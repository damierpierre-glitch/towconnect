-- TowConnect — Phase 2: Smart Dispatch V1.
-- Additive migration, run after 0001-0005. Does not modify nearby_drivers(),
-- accept_request(), cleanup_stale(), or any existing table/policy — it only
-- adds a new table + functions that call into them.
--
-- Architecture in one paragraph: a request is still "searching" for as long
-- as it is status='pending' with requests.driver_id = null (exactly the same
-- semantics the manual-pick flow used, just automated). dispatch_offers is a
-- pure audit/lock trail of who was offered what and when — the client never
-- reads it directly; the request row itself (via existing Realtime) is all
-- the UI needs. Every write to dispatch_offers goes through a SECURITY
-- DEFINER function; there is no INSERT/UPDATE/DELETE policy for
-- authenticated at all, so neither a rider nor a driver can touch it
-- directly, only read their own rows.

-- ============================================================
-- DISPATCH_OFFERS
-- ============================================================
create type dispatch_offer_status as enum ('offered', 'declined', 'accepted', 'timeout');

create table dispatch_offers (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references requests(id) on delete cascade,
  driver_id uuid not null references profiles(id) on delete cascade,
  status dispatch_offer_status not null default 'offered',
  score double precision not null,
  rank integer not null default 1,
  offered_at timestamptz not null default now(),
  expires_at timestamptz not null,
  responded_at timestamptz
);

create index dispatch_offers_request_idx on dispatch_offers(request_id);
create index dispatch_offers_driver_idx on dispatch_offers(driver_id);

-- The invariant the whole sequential-offer model depends on: a request can
-- have at most one *outstanding* offer at a time. Past offers (declined /
-- timed out / accepted) are untouched by this index, so history is never
-- blocked — only a second simultaneous 'offered' row for the same request is.
create unique index dispatch_offers_one_active_per_request
  on dispatch_offers (request_id)
  where status = 'offered';

alter table dispatch_offers enable row level security;

create policy "dispatch_offers: driver reads own" on dispatch_offers
  for select using (auth.uid() = driver_id);

create policy "dispatch_offers: admins read all" on dispatch_offers
  for select using (public.is_admin());

-- No insert/update/delete policy for authenticated, intentionally: this
-- table is written to exclusively by dispatch_next_candidate(),
-- respond_to_dispatch_offer(), and process_dispatch_timeouts() below (all
-- SECURITY DEFINER). With RLS enabled and no matching policy, a plain client
-- INSERT/UPDATE/DELETE from a rider or driver session is rejected outright —
-- "a driver fabricates an offer" or "edits another driver's offer" is
-- structurally impossible, not just discouraged by app code.

alter publication supabase_realtime add table dispatch_offers;

-- Short and constant for V1 — a roadside customer is waiting. Kept as its
-- own function (not a magic literal repeated in two places) so the window
-- only has to change in one spot later.
create or replace function dispatch_offer_window()
returns interval
language sql
immutable
as $$ select interval '18 seconds' $$;

-- ============================================================
-- dispatch_next_candidate() — finds and offers the best remaining driver
-- for a request that is pending and currently driverless. Called:
--   1. Synchronously, once, right after a request is created (near-instant
--      first offer instead of waiting for the next cron tick).
--   2. From process_dispatch_timeouts() below, for any request left
--      driverless by a decline or a timeout.
-- ============================================================
create or replace function dispatch_next_candidate(p_request_id uuid)
returns dispatch_offers
language plpgsql
security definer set search_path = public
as $$
declare
  v_request requests;
  v_best record;
  v_offer dispatch_offers;
  v_tier double precision;
begin
  select * into v_request from requests where id = p_request_id for update;
  if not found then
    raise exception 'Request % not found', p_request_id using errcode = 'P0001';
  end if;

  -- Only the request's own owner (normal path: right after creation, or a
  -- client-triggered retry) or the service role (the dispatch-tick cron,
  -- advancing past a decline/timeout) may trigger dispatch for a request.
  if auth.uid() is distinct from v_request.user_id and auth.role() <> 'service_role' then
    raise exception 'Not authorized to dispatch this request' using errcode = '42501';
  end if;

  -- Nothing to do if the request isn't actively searching right now (already
  -- has an outstanding offer, already matched, or no longer active).
  if v_request.status <> 'pending' or v_request.driver_id is not null then
    return null;
  end if;

  -- Escalating radius — same tiers the old manual driver list used, so a
  -- rural/remote request doesn't dead-end at a fixed "city" radius.
  for v_tier in select unnest(array[15, 40, 350]) loop
    select
      c.profile_id,
      -- Score, in the order of the product's stated priorities:
      --  1. real availability — already guaranteed by nearby_drivers()
      --     (approved + is_online) plus the two extra filters below
      --     (fresh heartbeat, no other active job right now).
      --  2. compatibility with the request, when that information exists —
      --     a flat bonus, never a penalty, so an imperfect vehicle match
      --     can never make an available driver unreachable.
      --  3. ETA/distance — dominant weight, since distance is TowConnect's
      --     best available ETA proxy (no live routing/traffic yet), and
      --     "get there fast" is the whole point of the product.
      --  4. rating — a tie-breaker, not a reason to send help further away.
      -- Weights are fixed, documented constants, not learned or tuned by
      -- any model — deliberately simple and auditable for V1.
      (
        greatest(0, 1 - (c.distance_km / v_tier)) * 0.65
        + (c.rating / 5.0) * 0.20
        + case
            when v_request.problem_type = 'accident' and c.vehicle_type in ('flatbed', 'heavy_duty') then 0.15
            else 0
          end
      ) as score
    into v_best
    from nearby_drivers(v_request.lat, v_request.lng, v_tier, 15) c
    join driver_profiles dp on dp.profile_id = c.profile_id
    where
      -- Never re-offer a driver who already saw this request in this
      -- dispatch round (declined, timed out, or currently offered) — V1
      -- keeps this simple: move down the list, don't retry the same driver.
      not exists (
        select 1 from dispatch_offers o
        where o.request_id = p_request_id and o.driver_id = c.profile_id
      )
      -- Heartbeat freshness for *this* decision, tighter than
      -- cleanup_stale()'s ~3-minute offline threshold and independent of
      -- it — a driver who is technically still is_online=true but hasn't
      -- pinged recently must not receive a brand-new offer.
      and dp.last_heartbeat_at is not null
      and dp.last_heartbeat_at > now() - interval '2 minutes'
      -- Real availability: a driver already mid-job elsewhere. Redundant
      -- with accept_request()'s one-active-job unique index (which would
      -- reject the accept anyway), but filtering here means the offer never
      -- goes to them — and never wastes the offer window — in the first
      -- place.
      and not exists (
        select 1 from requests r2
        where r2.driver_id = c.profile_id and r2.status in ('matched', 'en_route', 'arrived')
      )
    order by score desc, c.distance_km asc
    limit 1;

    exit when v_best.profile_id is not null;
  end loop;

  if v_best.profile_id is null then
    -- No candidate anywhere, even at the widest tier. The request stays
    -- pending/driverless on purpose — process_dispatch_timeouts() will try
    -- again on its next run (a driver may come online in the meantime), and
    -- cleanup_stale()'s existing 10-minute expiry remains the backstop. No
    -- fake driver is ever created to fill the gap.
    return null;
  end if;

  update requests set driver_id = v_best.profile_id where id = p_request_id;

  insert into dispatch_offers (request_id, driver_id, status, score, rank, expires_at)
  values (p_request_id, v_best.profile_id, 'offered', v_best.score, 1, now() + dispatch_offer_window())
  returning * into v_offer;

  return v_offer;
end;
$$;

revoke all on function dispatch_next_candidate(uuid) from public;
grant execute on function dispatch_next_candidate(uuid) to authenticated, service_role;

-- ============================================================
-- respond_to_dispatch_offer() — a driver accepting or declining the offer
-- currently held for a request. Wraps the existing accept_request() for the
-- accept path (same atomic pending->matched UPDATE and one-active-job
-- guard — not reimplemented, not bypassed) and mirrors the old
-- declineRequest() predicate for the decline path, while also settling the
-- dispatch_offers bookkeeping that neither of those touches.
-- ============================================================
create or replace function respond_to_dispatch_offer(p_request_id uuid, p_accept boolean)
returns requests
language plpgsql
security definer set search_path = public
as $$
declare
  v_offer dispatch_offers;
  v_found_offer boolean := false;
  v_request requests;
begin
  select * into v_offer
  from dispatch_offers
  where request_id = p_request_id and driver_id = auth.uid() and status = 'offered'
  order by offered_at desc
  limit 1
  for update;
  v_found_offer := found;

  -- Enforced here, not only by the cron: an offer past its window can never
  -- be accepted or declined through this function, regardless of whether
  -- process_dispatch_timeouts() has swept it yet.
  if v_found_offer and v_offer.expires_at < now() then
    update dispatch_offers set status = 'timeout', responded_at = now() where id = v_offer.id;
    raise exception 'This offer has expired' using errcode = 'P0001';
  end if;

  if p_accept then
    v_request := accept_request(p_request_id);
    if v_found_offer then
      update dispatch_offers set status = 'accepted', responded_at = now() where id = v_offer.id;
    end if;
  else
    update requests
    set driver_id = null
    where id = p_request_id and driver_id = auth.uid() and status = 'pending'
    returning * into v_request;

    if not found then
      raise exception 'Request % is no longer offered to you', p_request_id using errcode = 'P0001';
    end if;

    if v_found_offer then
      update dispatch_offers set status = 'declined', responded_at = now() where id = v_offer.id;
    end if;
  end if;

  return v_request;
end;
$$;

revoke all on function respond_to_dispatch_offer(uuid, boolean) from public;
grant execute on function respond_to_dispatch_offer(uuid, boolean) to authenticated;

-- ============================================================
-- process_dispatch_timeouts() — called every ~15s by the dispatch-tick Edge
-- Function (service role only, same trust model as cleanup_stale()). Two
-- jobs: sweep offers whose window passed with no response, then give every
-- now-driverless pending request another shot at the next-best candidate.
-- ============================================================
create or replace function process_dispatch_timeouts()
returns table (timed_out int, redispatched int)
language plpgsql
security definer set search_path = public
as $$
declare
  v_timed_out int := 0;
  v_redispatched int := 0;
  v_row record;
begin
  for v_row in
    update dispatch_offers
    set status = 'timeout', responded_at = now()
    where status = 'offered' and expires_at < now()
    returning request_id, driver_id
  loop
    v_timed_out := v_timed_out + 1;
    -- Only clear driver_id if it still points at the driver whose offer
    -- just timed out — a concurrent accept/decline may already have moved
    -- the request on, and this must never clobber that.
    update requests
    set driver_id = null
    where id = v_row.request_id and driver_id = v_row.driver_id and status = 'pending';
  end loop;

  for v_row in
    select id from requests where status = 'pending' and driver_id is null
  loop
    if dispatch_next_candidate(v_row.id) is not null then
      v_redispatched := v_redispatched + 1;
    end if;
  end loop;

  return query select v_timed_out, v_redispatched;
end;
$$;

revoke all on function process_dispatch_timeouts() from public;
grant execute on function process_dispatch_timeouts() to service_role;

-- ============================================================
-- Cancelling a request while an offer is outstanding shouldn't leave a
-- driver staring at a stale offer for up to 18 more seconds — mark it
-- resolved immediately. driver_id is left as-is (harmless once status isn't
-- 'pending': the driver dashboard's own "pending" filter already hides it).
-- ============================================================
create or replace function expire_offer_on_cancel()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    update dispatch_offers
    set status = 'timeout', responded_at = now()
    where request_id = new.id and status = 'offered';
  end if;
  return new;
end;
$$;

create trigger requests_expire_offer_on_cancel
  after update on requests
  for each row execute procedure expire_offer_on_cancel();
