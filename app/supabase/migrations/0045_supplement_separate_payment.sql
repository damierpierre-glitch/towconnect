-- TowConnect — Phase 8.1: an approved supplement that can actually be
-- collected. Additive, run after 0044.
--
-- THE GAP THIS CLOSES
-- Phase 7 could only add a supplement to the authorization already held for
-- the job. Phase 7.1 proved, against real Stripe, that this platform's account
-- is not eligible for incremental authorization at all — so EVERY approved
-- supplement took the `uncollected` path and the provider was credited
-- nothing. Safe, and useless: the customer agreed to pay, and nobody was paid.
--
-- The fallback is a PaymentIntent of its own for the supplement. That brings
-- three obligations, and this migration exists to make them structural rather
-- than remembered:
--
--   1. A supplement is collected when STRIPE says so, not when we ask.
--   2. It can be charged at most once.
--   3. It credits the provider at most once.

-- ---- 1. the states a supplement's money can actually be in ---------------
-- 'requires_action' is the one that matters: an off-session charge that trips
-- SCA is neither collected nor failed, and collapsing it into either would
-- either credit money that never arrived or abandon money that still might.
alter table request_supplements
  drop constraint if exists request_supplements_payment_state_check;

alter table request_supplements
  add constraint request_supplements_payment_state_check
  check (payment_state in ('pending', 'authorized', 'requires_action', 'uncollected', 'failed', 'settled'));

alter table request_supplements
  -- The supplement's own PaymentIntent, when the fallback was used. UNIQUE:
  -- one intent belongs to one supplement, so a retry cannot quietly attach a
  -- second charge to the same agreement.
  add column if not exists stripe_payment_intent_id text unique,
  -- How the money was taken, so a receipt and an auditor can tell the two
  -- paths apart years later.
  add column if not exists collection_method text
    check (collection_method in ('incremental_authorization', 'separate_payment_intent'));

comment on column request_supplements.payment_state is
  'pending: approved, not yet attempted. authorized: added to the original hold. requires_action: '
  'the customer must complete authentication. uncollected: could not be charged. failed: Stripe '
  'refused. settled: Stripe confirmed the money moved. Only the service role writes this (0037).';

-- ---- 2. a supplement credits the provider at most once -------------------
-- 0035 gave `earning` a unique index per request for exactly this reason. A
-- supplement needs its own, because a job can legitimately carry several.
alter table provider_ledger_entries
  add column if not exists supplement_id uuid references request_supplements(id) on delete set null;

create unique index if not exists provider_ledger_one_entry_per_supplement
  on provider_ledger_entries(supplement_id)
  where supplement_id is not null;

comment on column provider_ledger_entries.supplement_id is
  'Which approved supplement this entry pays for. Unique where set: replaying a settlement writes '
  'nothing the second time, structurally rather than by remembering to check.';

-- ---- 3. refunds can name a supplement -----------------------------------
-- A supplement charged on its own PaymentIntent has to be refundable on its
-- own, without touching the fare the customer already accepted.
alter table refunds
  add column if not exists supplement_id uuid references request_supplements(id) on delete set null;

comment on column refunds.supplement_id is
  'Set when this refund is against a supplement''s own PaymentIntent rather than the job''s fare.';

-- ---- 4. the operational view of an uncollected supplement ---------------
-- ops_attention_queue() already surfaces `uncollected`. Two of the new states
-- also need a person: a charge that failed, and one waiting on a customer who
-- may never come back to authenticate it.
create or replace function ops_attention_queue()
returns table (
  kind text, severity text, subject_kind text, subject_id uuid, request_id uuid,
  title text, detail text, since timestamptz, threshold_origin text
)
language plpgsql
stable
security definer set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and not coalesce(public.has_admin_capability('operations'), false)
     and not coalesce(public.has_admin_capability('support'), false) then
    raise exception 'Not authorized to read the operational queue' using errcode = '42501';
  end if;

  return query
    select 'request_pending_too_long', 'high', 'request', r.id, r.id,
      'Unmatched request', r.location_text, r.created_at,
      (select origin from ops_thresholds where key = 'pending_without_match')
    from requests r
    where r.status = 'pending' and r.created_at < now() - ops_threshold('pending_without_match')
    union all
    select 'no_candidate_found', 'critical', 'request', r.id, r.id,
      'No driver could be offered this request',
      coalesce(r.regulated_dispatch_state::text, 'no regulated state'), r.created_at, 'derived'
    from requests r
    where r.status = 'pending' and r.created_at < now() - dispatch_offer_window()
      and not exists (select 1 from dispatch_offers o where o.request_id = r.id)
    union all
    select 'assigned_driver_stale', 'high', 'driver', r.driver_id, r.id,
      'Assigned driver has gone quiet', r.status::text, dp.last_heartbeat_at, 'derived'
    from requests r join driver_profiles dp on dp.profile_id = r.driver_id
    where r.status in ('matched', 'en_route', 'arrived', 'in_progress')
      and (dp.last_heartbeat_at is null
           or dp.last_heartbeat_at < now() - driver_heartbeat_max_age())
    union all
    select 'regulated_capacity_wait', 'high', 'request', r.id, r.id,
      'Waiting on an authorized provider in a regulated zone', r.location_text, r.created_at, 'derived'
    from requests r
    where r.regulated_dispatch_state = 'restricted_capacity_wait' and r.status in ('pending', 'matched')
    union all
    select 'payment_failed', 'high', 'payment', p.id, p.request_id,
      'Payment failed', coalesce(p.failure_reason, 'no reason recorded'), p.updated_at, 'derived'
    from payments p where p.status = 'failed'
    union all
    select 'payment_unresolved', 'medium', 'payment', p.id, p.request_id,
      'Payment has not resolved', p.status::text, p.created_at,
      (select origin from ops_thresholds where key = 'payment_unresolved')
    from payments p
    where p.status in ('requires_payment_method', 'requires_action')
      and p.created_at < now() - ops_threshold('payment_unresolved')
    union all
    -- Three different problems, three different answers, so three rows rather
    -- than one bucket labelled "supplement".
    select 'supplement_uncollected', 'medium', 'request', s.request_id, s.request_id,
      'Approved supplement could not be charged', coalesce(s.payment_note, s.type_key), s.updated_at, 'derived'
    from request_supplements s where s.status = 'approved' and s.payment_state = 'uncollected'
    union all
    select 'supplement_charge_failed', 'high', 'request', s.request_id, s.request_id,
      'Supplement charge was refused', coalesce(s.payment_note, s.type_key), s.updated_at, 'derived'
    from request_supplements s where s.status = 'approved' and s.payment_state = 'failed'
    union all
    select 'supplement_awaiting_authentication', 'medium', 'request', s.request_id, s.request_id,
      'Supplement is waiting on the customer to authenticate',
      coalesce(s.payment_note, s.type_key), s.updated_at, 'derived'
    from request_supplements s where s.status = 'approved' and s.payment_state = 'requires_action'
    union all
    select 'refund_unresolved', 'high', 'request', rf.request_id, rf.request_id,
      'Refund is ' || rf.status::text, coalesce(rf.failure_reason, rf.reason), rf.updated_at, 'derived'
    from refunds rf where rf.status in ('pending', 'failed')
    union all
    select 'payout_awaiting_action', 'medium', 'company', pp.company_id, null::uuid,
      'Payout is ' || pp.state::text,
      to_char(pp.amount, 'FM999999990.00') || ' ' || upper(pp.currency), pp.created_at, 'derived'
    from provider_payouts pp where pp.state in ('pending', 'held')
    union all
    select 'connect_payouts_disabled', 'medium', 'company', c.id, null::uuid,
      'Company cannot receive payouts',
      coalesce(c.connect_disabled_reason, c.connect_status::text), c.connect_updated_at, 'derived'
    from companies c where c.stripe_account_id is not null and c.connect_payouts_enabled = false
    union all
    select 'open_incident', oi.severity::text, 'incident', oi.id, oi.request_id,
      oi.title, oi.type::text, oi.created_at, 'derived'
    from operational_incidents oi where oi.status in ('open', 'investigating');
end;
$$;

revoke all on function ops_attention_queue() from public;
grant execute on function ops_attention_queue() to authenticated, service_role;

-- ---- 5. reconciliation follows the new rule -----------------------------
-- "An uncollected supplement must not credit anybody" becomes "a supplement
-- that Stripe has not confirmed must not credit anybody".
create or replace function ops_reconciliation_exceptions()
returns table (kind text, request_id uuid, company_id uuid, detail text)
language plpgsql
stable
security definer set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and not coalesce(public.has_admin_capability('finance'), false)
     and not coalesce(public.has_admin_capability('operations'), false) then
    raise exception 'Not authorized to read reconciliation exceptions' using errcode = '42501';
  end if;

  return query
    select 'completed_without_ledger', r.id, null::uuid,
           'partner_amount ' || r.partner_amount::text || ' but no earning entry'
    from requests r
    where r.status = 'completed' and r.partner_amount is not null
      and not exists (select 1 from provider_ledger_entries e
                      where e.request_id = r.id and e.entry_type = 'earning')
    union all
    select 'frozen_without_amount', r.id, null::uuid, 'pricing_config_id set, partner_amount NULL'
    from requests r
    where r.economics_frozen_at is not null and r.pricing_config_id is not null
      and r.partner_amount is null
    union all
    select 'identity_drift', r.id, null::uuid,
           'price ' || r.price_estimate::text || ' vs parts '
           || (coalesce(r.partner_amount,0) + coalesce(r.commission_amount,0)
               + coalesce(r.payment_processing_cost,0))::text
    from requests r
    where r.partner_amount is not null
      and abs(coalesce(r.price_estimate,0)
              - (coalesce(r.partner_amount,0) + coalesce(r.commission_amount,0)
                 + coalesce(r.payment_processing_cost,0))) > 0.005
    union all
    select 'refund_without_reversal', rf.request_id, null::uuid,
           'refund ' || rf.amount::text || ' succeeded with no refund_reversal entry'
    from refunds rf
    where rf.status = 'succeeded'
      and exists (select 1 from provider_ledger_entries e
                  where e.request_id = rf.request_id and e.entry_type = 'earning')
      and not exists (select 1 from provider_ledger_entries e
                      where e.request_id = rf.request_id and e.entry_type = 'refund_reversal')
    union all
    select 'payout_exceeds_earnings', null::uuid, e.company_id,
           'paid ' || coalesce(-sum(e.amount) filter (where e.entry_type = 'payout'), 0)::text
           || ' of ' || coalesce(sum(e.amount) filter (
                where e.entry_type in ('earning','supplement','adjustment','refund_reversal')), 0)::text
           || ' earned'
    from provider_ledger_entries e
    group by e.company_id
    having coalesce(-sum(e.amount) filter (where e.entry_type = 'payout'), 0)
         - coalesce(sum(e.amount) filter (where e.entry_type = 'payout_reversal'), 0)
         > coalesce(sum(e.amount) filter (
             where e.entry_type in ('earning','supplement','adjustment','refund_reversal')), 0) + 0.005
    union all
    select 'unsettled_supplement_credited', s.request_id, null::uuid,
           'supplement ' || s.amount::text || ' is ' || s.payment_state
           || ' but a ledger entry exists for it'
    from request_supplements s
    where s.status = 'approved' and s.payment_state <> 'settled'
      and exists (select 1 from provider_ledger_entries e where e.supplement_id = s.id)
    union all
    -- The mirror image: money Stripe confirmed, that nobody was credited for.
    select 'settled_supplement_not_credited', s.request_id, null::uuid,
           'supplement ' || s.amount::text || ' settled with no ledger entry'
    from request_supplements s
    join requests r on r.id = s.request_id
    where s.status = 'approved' and s.payment_state = 'settled'
      and r.partner_amount is not null
      and not exists (select 1 from provider_ledger_entries e where e.supplement_id = s.id);
end;
$$;

revoke all on function ops_reconciliation_exceptions() from public;
grant execute on function ops_reconciliation_exceptions() to authenticated, service_role;
