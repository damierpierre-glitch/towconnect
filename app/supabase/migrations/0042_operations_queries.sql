-- TowConnect — Phase 8: the queries the command centre is made of. Additive,
-- run after 0041.
--
-- WHY THESE ARE FUNCTIONS AND NOT UI CODE
-- Every number an operator acts on has to come from one place. The moment the
-- dashboard computes "requests needing attention" its own way, it can disagree
-- with what dispatch actually did — and the version that disagrees is the one
-- nobody tested. Same reasoning as dispatch_candidates() in 0026: one query,
-- read by both the engine and the explain view.
--
-- All of these are SECURITY DEFINER because they read across every company and
-- every customer. Each one states who may ask, null-safely (see 0039 — a guard
-- written the obvious way fails OPEN when auth.role() is NULL).
--
-- THE DERIVED THRESHOLDS CALL THE ENGINE, NOT A COPY OF IT
-- "Driver has gone quiet" and "an offer should have been made by now" use
-- driver_heartbeat_max_age() and dispatch_offer_window() directly — the very
-- functions dispatch itself uses. The matching rows in ops_thresholds are the
-- operator-visible statement of those rules, and ops_threshold_drift() (0043)
-- is what proves the two still agree. A queue that quietly described a rule
-- the system had stopped enforcing would be worse than no queue.

-- ============================================================
-- Indexes for the queries below
-- ============================================================
-- Added because these specific access patterns are new in Phase 8, and only
-- these: an index nobody's query uses is a write cost with no reader.
create index if not exists requests_active_idx
  on requests(created_at desc)
  where status in ('pending', 'matched', 'en_route', 'arrived', 'in_progress');

create index if not exists requests_status_created_idx on requests(status, created_at desc);

-- The KPI timings all join request_events by (request, status).
create index if not exists request_events_request_status_idx
  on request_events(request_id, status, created_at);

create index if not exists driver_profiles_online_idx
  on driver_profiles(last_heartbeat_at desc)
  where is_online;

create index if not exists payments_attention_idx
  on payments(created_at desc)
  where status in ('requires_payment_method', 'requires_action', 'failed');

-- ============================================================
-- ops_attention_queue() — "what needs me right now"
-- ============================================================
-- Facts only. Every row is something a person can act on, and every row
-- carries where its threshold came from ('derived' from a rule the system
-- already enforces, or 'engineering' — a default, explicitly not an SLA).
create or replace function ops_attention_queue()
returns table (
  kind text,
  severity text,
  subject_kind text,
  subject_id uuid,
  request_id uuid,
  title text,
  detail text,
  since timestamptz,
  threshold_origin text
)
language plpgsql
stable
security definer set search_path = public
as $$
begin
  -- Internal staff only. Operations runs the queue; support needs to see
  -- it to answer a customer asking why nothing has happened yet.
  if coalesce(auth.role(), '') <> 'service_role'
     and not coalesce(public.has_admin_capability('operations'), false)
     and not coalesce(public.has_admin_capability('support'), false) then
    raise exception 'Not authorized to read the operational queue' using errcode = '42501';
  end if;

  return query
    -- A request nobody has matched, past the point where somebody should look.
    select
      'request_pending_too_long' as kind, 'high' as severity, 'request' as subject_kind,
      r.id as subject_id, r.id as request_id,
      'Unmatched request' as title,
      r.location_text as detail,
      r.created_at as since,
      (select origin from ops_thresholds where key = 'pending_without_match') as threshold_origin
    from requests r
    where r.status = 'pending'
      and r.created_at < now() - ops_threshold('pending_without_match')

    union all

    -- Dispatch ran and produced nobody: no offer has ever been made for this
    -- request, and enough time has passed that one would have been.
    select
      'no_candidate_found', 'critical', 'request', r.id, r.id,
      'No driver could be offered this request',
      coalesce(r.regulated_dispatch_state::text, 'no regulated state'),
      r.created_at,
      'derived'
    from requests r
    where r.status = 'pending'
      and r.created_at < now() - dispatch_offer_window()
      and not exists (select 1 from dispatch_offers o where o.request_id = r.id)

    union all

    -- A driver is on a job but the engine can no longer see them. Threshold
    -- derived: it is the same window dispatch itself uses.
    select
      'assigned_driver_stale', 'high', 'driver', r.driver_id, r.id,
      'Assigned driver has gone quiet',
      r.status::text,
      dp.last_heartbeat_at,
      'derived'
    from requests r
    join driver_profiles dp on dp.profile_id = r.driver_id
    where r.status in ('matched', 'en_route', 'arrived', 'in_progress')
      and (dp.last_heartbeat_at is null
           or dp.last_heartbeat_at < now() - driver_heartbeat_max_age())

    union all

    -- The motorist is waiting on a regulated zone with no available authorized
    -- provider. Nothing is broken; somebody has to decide what to tell them.
    select
      'regulated_capacity_wait', 'high', 'request', r.id, r.id,
      'Waiting on an authorized provider in a regulated zone',
      r.location_text,
      r.created_at,
      'derived'
    from requests r
    where r.regulated_dispatch_state = 'restricted_capacity_wait'
      and r.status in ('pending', 'matched')

    union all

    select
      'payment_failed', 'high', 'payment', p.id, p.request_id,
      'Payment failed',
      coalesce(p.failure_reason, 'no reason recorded'),
      p.updated_at,
      'derived'
    from payments p
    where p.status = 'failed'

    union all

    -- A payment stuck short of a terminal state for longer than anybody expects.
    select
      'payment_unresolved', 'medium', 'payment', p.id, p.request_id,
      'Payment has not resolved',
      p.status::text,
      p.created_at,
      (select origin from ops_thresholds where key = 'payment_unresolved')
    from payments p
    where p.status in ('requires_payment_method', 'requires_action')
      and p.created_at < now() - ops_threshold('payment_unresolved')

    union all

    -- Money the customer agreed to pay that was never secured.
    select
      'supplement_uncollected', 'medium', 'request', s.request_id, s.request_id,
      'Approved supplement was never collected',
      coalesce(s.payment_note, s.type_key),
      s.updated_at,
      'derived'
    from request_supplements s
    where s.status = 'approved' and s.payment_state = 'uncollected'

    union all

    select
      'refund_unresolved', 'high', 'request', rf.request_id, rf.request_id,
      'Refund is ' || rf.status::text,
      coalesce(rf.failure_reason, rf.reason),
      rf.updated_at,
      'derived'
    from refunds rf
    where rf.status in ('pending', 'failed')

    union all

    select
      'payout_awaiting_action', 'medium', 'company', pp.company_id, null::uuid,
      'Payout is ' || pp.state::text,
      to_char(pp.amount, 'FM999999990.00') || ' ' || upper(pp.currency),
      pp.created_at,
      'derived'
    from provider_payouts pp
    where pp.state in ('pending', 'held')

    union all

    -- A company that has started onboarding but cannot be paid.
    select
      'connect_payouts_disabled', 'medium', 'company', c.id, null::uuid,
      'Company cannot receive payouts',
      coalesce(c.connect_disabled_reason, c.connect_status::text),
      c.connect_updated_at,
      'derived'
    from companies c
    where c.stripe_account_id is not null
      and c.connect_payouts_enabled = false

    union all

    select
      'open_incident', oi.severity::text, 'incident', oi.id, oi.request_id,
      oi.title,
      oi.type::text,
      oi.created_at,
      'derived'
    from operational_incidents oi
    where oi.status in ('open', 'investigating');
end;
$$;

revoke all on function ops_attention_queue() from public;
grant execute on function ops_attention_queue() to authenticated, service_role;

comment on function ops_attention_queue() is
  'Every row is a fact somebody can act on, with the origin of its threshold. No vanity metrics, '
  'and no invented service level: rows marked ''engineering'' use a default chosen to make the queue '
  'useful, never a commitment anyone has made.';

-- ============================================================
-- ops_kpis() — stable definitions, stated in the code
-- ============================================================
--   Time to Match       = first 'matched' event      - request.created_at
--   Time to Arrival     = first 'arrived' event      - request.created_at
--   Match rate          = requests that ever reached 'matched' / requests created
--   Acceptance rate     = offers accepted / offers made
--   Completion rate     = requests completed / requests that ever matched
--   Cancellation rate   = requests cancelled / requests created
--   Human intervention  = requests with at least one incident attached
--   Failed payment rate = requests whose latest payment is 'failed' / with a payment
--
-- Every timing comes from request_events, which is written by a trigger on
-- `requests` itself — so it captures every path to a status, including the
-- ones the application forgot about.
create or replace function ops_kpis(p_from timestamptz, p_to timestamptz)
returns table (
  requests_created bigint,
  requests_matched bigint,
  requests_completed bigint,
  requests_cancelled bigint,
  requests_expired bigint,
  match_rate numeric,
  completion_rate numeric,
  cancellation_rate numeric,
  offers_made bigint,
  offers_accepted bigint,
  acceptance_rate numeric,
  median_time_to_match_seconds numeric,
  median_time_to_arrival_seconds numeric,
  regulated_requests bigint,
  requests_needing_human bigint,
  failed_payment_rate numeric
)
language plpgsql
stable
security definer set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and not coalesce(public.has_admin_capability('operations'), false)
     and not coalesce(public.has_admin_capability('finance'), false) then
    raise exception 'Not authorized to read platform KPIs' using errcode = '42501';
  end if;

  return query
    with scope as (
      select r.* from requests r where r.created_at >= p_from and r.created_at < p_to
    ),
    first_event as (
      select e.request_id, e.status, min(e.created_at) as at
      from request_events e
      join scope s on s.id = e.request_id
      group by e.request_id, e.status
    ),
    matched as (select request_id, at from first_event where status = 'matched'),
    arrived as (select request_id, at from first_event where status = 'arrived'),
    offers as (
      select o.* from dispatch_offers o join scope s on s.id = o.request_id
    ),
    latest_payment as (
      select distinct on (p.request_id) p.request_id, p.status
      from payments p join scope s on s.id = p.request_id
      order by p.request_id, p.created_at desc
    )
    select
      (select count(*) from scope),
      (select count(*) from matched),
      (select count(*) from scope where status = 'completed'),
      (select count(*) from scope where status = 'cancelled'),
      (select count(*) from scope where status = 'expired'),
      -- Rates are NULL, never 0, when the denominator is empty: "no requests
      -- yet" and "nothing ever matched" are different facts.
      case when (select count(*) from scope) = 0 then null
           else round((select count(*) from matched)::numeric * 100 / (select count(*) from scope), 1) end,
      case when (select count(*) from matched) = 0 then null
           else round((select count(*) from scope where status = 'completed')::numeric * 100
                      / (select count(*) from matched), 1) end,
      case when (select count(*) from scope) = 0 then null
           else round((select count(*) from scope where status = 'cancelled')::numeric * 100
                      / (select count(*) from scope), 1) end,
      (select count(*) from offers),
      (select count(*) from offers where status = 'accepted'),
      case when (select count(*) from offers) = 0 then null
           else round((select count(*) from offers where status = 'accepted')::numeric * 100
                      / (select count(*) from offers), 1) end,
      (select round(percentile_cont(0.5) within group (
         order by extract(epoch from (m.at - s.created_at)))::numeric, 1)
       from matched m join scope s on s.id = m.request_id),
      (select round(percentile_cont(0.5) within group (
         order by extract(epoch from (a.at - s.created_at)))::numeric, 1)
       from arrived a join scope s on s.id = a.request_id),
      (select count(*) from scope where regulated_zone_id is not null),
      (select count(distinct oi.request_id) from operational_incidents oi
        join scope s on s.id = oi.request_id),
      case when (select count(*) from latest_payment) = 0 then null
           else round((select count(*) from latest_payment where status = 'failed')::numeric * 100
                      / (select count(*) from latest_payment), 1) end;
end;
$$;

revoke all on function ops_kpis(timestamptz, timestamptz) from public;
grant execute on function ops_kpis(timestamptz, timestamptz) to authenticated, service_role;

comment on function ops_kpis(timestamptz, timestamptz) is
  'Phase 8 KPI definitions, stable and stated in the function body. Timings come from '
  'request_events, so they exist only for requests whose status changes were recorded there — '
  'nothing is back-filled or estimated. A rate over an empty denominator is NULL, never 0.';

-- ============================================================
-- ops_reconciliation_exceptions() — the finance invariants, live
-- ============================================================
-- The same invariants verify:finance checks from a script, available to an
-- operator without running anything. Deliberately the same list: two answers
-- to "does the money add up" would eventually disagree.
create or replace function ops_reconciliation_exceptions()
returns table (
  kind text,
  request_id uuid,
  company_id uuid,
  detail text
)
language plpgsql
stable
security definer set search_path = public
as $$
begin
  -- Money that does not add up is both a finance problem and an
  -- operational one. Support sees neither: it exposes amounts across
  -- every company.
  if coalesce(auth.role(), '') <> 'service_role'
     and not coalesce(public.has_admin_capability('finance'), false)
     and not coalesce(public.has_admin_capability('operations'), false) then
    raise exception 'Not authorized to read reconciliation exceptions' using errcode = '42501';
  end if;

  return query
    -- A finished job that was priced but never credited to anybody.
    select 'completed_without_ledger', r.id, null::uuid,
           'partner_amount ' || r.partner_amount::text || ' but no earning entry'
    from requests r
    where r.status = 'completed'
      and r.partner_amount is not null
      and not exists (
        select 1 from provider_ledger_entries e
        where e.request_id = r.id and e.entry_type = 'earning'
      )

    union all

    -- Accepted under a configuration, yet carrying no compensation.
    select 'frozen_without_amount', r.id, null::uuid,
           'pricing_config_id set, partner_amount NULL'
    from requests r
    where r.economics_frozen_at is not null
      and r.pricing_config_id is not null
      and r.partner_amount is null

    union all

    -- The three parts must add back up to what the customer pays.
    select 'identity_drift', r.id, null::uuid,
           'price ' || r.price_estimate::text || ' vs parts '
           || (coalesce(r.partner_amount, 0) + coalesce(r.commission_amount, 0)
               + coalesce(r.payment_processing_cost, 0))::text
    from requests r
    where r.partner_amount is not null
      and abs(coalesce(r.price_estimate, 0)
              - (coalesce(r.partner_amount, 0) + coalesce(r.commission_amount, 0)
                 + coalesce(r.payment_processing_cost, 0))) > 0.005

    union all

    -- Money went back to a customer but was never taken back from the provider.
    select 'refund_without_reversal', rf.request_id, null::uuid,
           'refund ' || rf.amount::text || ' succeeded with no refund_reversal entry'
    from refunds rf
    where rf.status = 'succeeded'
      and exists (
        select 1 from provider_ledger_entries e
        where e.request_id = rf.request_id and e.entry_type = 'earning'
      )
      and not exists (
        select 1 from provider_ledger_entries e
        where e.request_id = rf.request_id and e.entry_type = 'refund_reversal'
      )

    union all

    -- A company paid more than it ever earned.
    select 'payout_exceeds_earnings', null::uuid, e.company_id,
           'paid ' || (-sum(e.amount) filter (where e.entry_type = 'payout'))::text
           || ' of ' || sum(e.amount) filter (
                where e.entry_type in ('earning', 'supplement', 'adjustment', 'refund_reversal')
              )::text || ' earned'
    from provider_ledger_entries e
    group by e.company_id
    having coalesce(-sum(e.amount) filter (where e.entry_type = 'payout'), 0)
         - coalesce(sum(e.amount) filter (where e.entry_type = 'payout_reversal'), 0)
         > coalesce(sum(e.amount) filter (
             where e.entry_type in ('earning', 'supplement', 'adjustment', 'refund_reversal')
           ), 0) + 0.005

    union all

    -- An uncollected supplement that somehow credited somebody.
    select 'uncollected_supplement_credited', s.request_id, null::uuid,
           'supplement ' || s.amount::text || ' is uncollected but a supplement entry exists'
    from request_supplements s
    where s.status = 'approved' and s.payment_state = 'uncollected'
      and exists (
        select 1 from provider_ledger_entries e
        where e.request_id = s.request_id and e.entry_type = 'supplement'
      );
end;
$$;

revoke all on function ops_reconciliation_exceptions() from public;
grant execute on function ops_reconciliation_exceptions() to authenticated, service_role;

-- ============================================================
-- ops_live_map() — bounded, so the map cannot ask for the whole planet
-- ============================================================
-- Bounds are required, not optional: "load everything and let the client
-- filter" is how a map becomes unusable the week the platform gets busy.
create or replace function ops_live_map(
  p_min_lat double precision,
  p_min_lng double precision,
  p_max_lat double precision,
  p_max_lng double precision
)
returns table (
  entity text,
  id uuid,
  lat double precision,
  lng double precision,
  label text,
  state text,
  company_id uuid,
  since timestamptz
)
language plpgsql
stable
security definer set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and not coalesce(public.has_admin_capability('operations'), false)
     and not coalesce(public.has_admin_capability('support'), false) then
    raise exception 'Not authorized to read the live map' using errcode = '42501';
  end if;

  return query
    select
      'driver', dp.profile_id, dp.current_lat, dp.current_lng,
      coalesce(nullif(p.full_name, ''), 'Driver'),
      case
        when not dp.is_online then 'offline'
        when dp.last_heartbeat_at is null
          or dp.last_heartbeat_at < now() - driver_heartbeat_max_age() then 'stale'
        when exists (
          select 1 from requests r
          where r.driver_id = dp.profile_id
            and r.status in ('matched', 'en_route', 'arrived', 'in_progress')
        ) then 'on_job'
        else 'available'
      end,
      driver_company_id(dp.profile_id),
      dp.last_heartbeat_at
    from driver_profiles dp
    join profiles p on p.id = dp.profile_id
    where dp.approval_status = 'approved'
      and dp.current_lat is not null and dp.current_lng is not null
      and dp.current_lat between p_min_lat and p_max_lat
      and dp.current_lng between p_min_lng and p_max_lng
      and dp.is_online

    union all

    select
      'request', r.id, r.lat, r.lng,
      r.location_text,
      -- The operational state, which is not always the request status: a
      -- pending request with a live offer is "searching", and a regulated wait
      -- is its own thing entirely.
      case
        when r.status = 'pending' and r.regulated_dispatch_state = 'restricted_capacity_wait'
          then 'restricted_capacity_wait'
        when r.status = 'pending' and r.regulated_dispatch_state = 'awaiting_external_authority'
          then 'awaiting_external_authority'
        when r.status = 'pending' and exists (
          select 1 from dispatch_offers o
          where o.request_id = r.id and o.status = 'offered' and o.expires_at > now()
        ) then 'searching'
        else r.status::text
      end,
      driver_company_id(r.driver_id),
      r.created_at
    from requests r
    where r.status in ('pending', 'matched', 'en_route', 'arrived', 'in_progress')
      and r.lat between p_min_lat and p_max_lat
      and r.lng between p_min_lng and p_max_lng;
end;
$$;

revoke all on function ops_live_map(double precision, double precision, double precision, double precision) from public;
grant execute on function ops_live_map(double precision, double precision, double precision, double precision)
  to authenticated, service_role;

comment on function ops_live_map(double precision, double precision, double precision, double precision) is
  'Real drivers and real requests inside the given bounds. Never a placeholder: an empty map means '
  'nothing is happening there, which is information.';
