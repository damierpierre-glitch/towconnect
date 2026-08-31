-- TowConnect — Phase 2.5: stabilize Smart Dispatch's real-world timeout
-- latency. Additive, run after 0001-0006.
--
-- What changed and why — see TOWCONNECT_PHASE2_5_REPORT.md for the full
-- audit, this is the short version:
--
--   * An explicit decline used to just clear driver_id and mark the offer
--     'declined', then wait for the next dispatch-tick cron run (worst case
--     ~1 minute on most Supabase Cron / pg_cron setups, which only support
--     minute-level granularity) to offer the next candidate. It now calls
--     the matching engine again in the SAME transaction — next candidate,
--     same request/response cycle, no cron dependency at all.
--   * A silent timeout (driver never responds) still needs *something* to
--     notice the window closed. Rather than requiring sub-minute cron
--     scheduling (not reliably available on this stack), the rider's own
--     tab — already open, already watching, already the party with the
--     strongest incentive to keep watching — nudges the backend every few
--     seconds while a request is searching/waiting. The dispatch-tick cron
--     remains the authoritative backstop for the case where every relevant
--     tab is closed; nothing about its correctness changes.
--
-- The actual matching/offer-creation logic is unchanged — it is only moved,
-- verbatim, into its own function so respond_to_dispatch_offer() and the new
-- nudge_dispatch() can call it directly without duplicating it.

-- ============================================================
-- dispatch_next_candidate_core() — the matching engine itself, with NO
-- authorization check of its own. Callable only from within the three
-- trusted entry points below (each SECURITY DEFINER, each enforcing its own
-- authorization before ever reaching this function) — a function owner
-- always has implicit EXECUTE on functions it owns, so no explicit GRANT is
-- needed or given here, and public/authenticated/service_role are denied
-- direct access on purpose.
-- ============================================================
create or replace function dispatch_next_candidate_core(p_request_id uuid)
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

  if v_request.status <> 'pending' or v_request.driver_id is not null then
    return null;
  end if;

  for v_tier in select unnest(array[15, 40, 350]) loop
    select
      c.profile_id,
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
      not exists (
        select 1 from dispatch_offers o
        where o.request_id = p_request_id and o.driver_id = c.profile_id
      )
      and dp.last_heartbeat_at is not null
      and dp.last_heartbeat_at > now() - interval '2 minutes'
      and not exists (
        select 1 from requests r2
        where r2.driver_id = c.profile_id and r2.status in ('matched', 'en_route', 'arrived')
      )
    order by score desc, c.distance_km asc
    limit 1;

    exit when v_best.profile_id is not null;
  end loop;

  if v_best.profile_id is null then
    return null;
  end if;

  update requests set driver_id = v_best.profile_id where id = p_request_id;

  insert into dispatch_offers (request_id, driver_id, status, score, rank, expires_at)
  values (p_request_id, v_best.profile_id, 'offered', v_best.score, 1, now() + dispatch_offer_window())
  returning * into v_offer;

  return v_offer;
end;
$$;

revoke all on function dispatch_next_candidate_core(uuid) from public;

-- ============================================================
-- dispatch_next_candidate() — public entry point, unchanged behavior from
-- 0006: authorization check, then delegates to the core.
-- ============================================================
create or replace function dispatch_next_candidate(p_request_id uuid)
returns dispatch_offers
language plpgsql
security definer set search_path = public
as $$
declare
  v_request requests;
begin
  select * into v_request from requests where id = p_request_id;
  if not found then
    raise exception 'Request % not found', p_request_id using errcode = 'P0001';
  end if;

  if auth.uid() is distinct from v_request.user_id and auth.role() <> 'service_role' then
    raise exception 'Not authorized to dispatch this request' using errcode = '42501';
  end if;

  return dispatch_next_candidate_core(p_request_id);
end;
$$;

revoke all on function dispatch_next_candidate(uuid) from public;
grant execute on function dispatch_next_candidate(uuid) to authenticated, service_role;

-- ============================================================
-- respond_to_dispatch_offer() — same accept/decline contract as 0006, with
-- one addition: a successful decline now advances dispatch immediately, in
-- the same transaction, instead of leaving the request driverless until the
-- next cron tick. The expired-offer check is untouched on purpose — it only
-- raises, it never writes, so there is nothing for the exception to roll
-- back; the stale row itself gets swept by the next nudge_dispatch() call
-- (client-driven, seconds away in practice) or by dispatch-tick.
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

    -- The core fix for this phase: advance to the next candidate right now,
    -- in this same call, rather than waiting on dispatch-tick.
    perform dispatch_next_candidate_core(p_request_id);
  end if;

  return v_request;
end;
$$;

revoke all on function respond_to_dispatch_offer(uuid, boolean) from public;
grant execute on function respond_to_dispatch_offer(uuid, boolean) to authenticated;

-- ============================================================
-- nudge_dispatch() — "is anything actually due right now? if so, handle it."
-- Idempotent and cheap to call liberally: a call that finds nothing overdue
-- is a pure no-op (single SELECT, no writes). This is what closes the real
-- latency gap for silent timeouts: the rider's own client (already open,
-- already watching this request) calls this every few seconds while
-- searching or waiting on a driver's answer, so an abandoned offer is
-- picked up in ~seconds instead of waiting on cron cadence. The driver's own
-- client does the same while their offer is outstanding, covering the case
-- where the rider's tab happens to be the one that's closed.
--
-- This is a latency optimization layered on top of, not a replacement for,
-- the server-side guarantees: respond_to_dispatch_offer() already rejects
-- an expired offer inline regardless of whether anything ever nudges it,
-- and dispatch-tick's process_dispatch_timeouts() remains the backstop for
-- the case where every relevant tab is closed.
-- ============================================================
create or replace function nudge_dispatch(p_request_id uuid)
returns dispatch_offers
language plpgsql
security definer set search_path = public
as $$
declare
  v_request requests;
  v_offer dispatch_offers;
  v_found_offer boolean;
begin
  select * into v_request from requests where id = p_request_id;
  if not found then
    raise exception 'Request % not found', p_request_id using errcode = 'P0001';
  end if;

  select * into v_offer
  from dispatch_offers
  where request_id = p_request_id and status = 'offered'
  order by offered_at desc
  limit 1
  for update;
  v_found_offer := found;

  -- Authorized nudgers: the rider waiting on this request, the driver
  -- currently holding the (possibly expired) offer, or the service role.
  -- Nobody else can force-advance someone else's request.
  if auth.uid() is distinct from v_request.user_id
     and (not v_found_offer or auth.uid() is distinct from v_offer.driver_id)
     and auth.role() <> 'service_role' then
    raise exception 'Not authorized to advance dispatch for this request' using errcode = '42501';
  end if;

  if v_found_offer then
    if v_offer.expires_at >= now() then
      -- Not actually due yet — an early or redundant nudge is a no-op, not
      -- an error, so the client can poll on a plain timer without needing
      -- to track the exact expiry itself.
      return null;
    end if;
    update dispatch_offers set status = 'timeout', responded_at = now() where id = v_offer.id;
    update requests set driver_id = null where id = p_request_id and driver_id = v_offer.driver_id and status = 'pending';
  end if;

  -- Also covers the "searching, no offer at all yet" case (v_found_offer =
  -- false): retries the match, e.g. because a new driver just came online.
  return dispatch_next_candidate_core(p_request_id);
end;
$$;

revoke all on function nudge_dispatch(uuid) from public;
grant execute on function nudge_dispatch(uuid) to authenticated, service_role;
