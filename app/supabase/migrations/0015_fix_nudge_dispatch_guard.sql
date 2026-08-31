-- TowConnect — Phase 4 follow-up fix, found during live-validation review
-- (TOWCONNECT_LIVE_VALIDATION_REPORT.md). Additive, run after 0001-0014.
--
-- THE DEFECT
-- 0014 added guard_request_protected_fields(), which rejects any UPDATE on
-- `requests` made from the assigned driver's own auth context that changes
-- anything other than `status`.
--
-- nudge_dispatch() (0007) clears requests.driver_id when it sweeps an offer
-- that has passed its expiry:
--     update requests set driver_id = null
--     where id = p_request_id and driver_id = v_offer.driver_id ...
--
-- That function is deliberately callable by the driver holding the offer —
-- the driver's dashboard polls it every 5s (Phase 2.5) so a silently
-- abandoned offer is handed to the next candidate in seconds instead of
-- waiting on the dispatch-tick cron. But in that call auth.uid() IS
-- old.driver_id, so the 0014 guard fires and the whole nudge throws
-- '42501 A driver may only update a request''s status'.
--
-- Effect if shipped unfixed: the driver-side half of the Phase 2.5 timeout
-- optimisation is dead (every driver-initiated nudge errors), silently
-- pushing that case back to the ~1-minute cron cadence. The rider-side nudge
-- is unaffected (for a rider, auth.uid() <> old.driver_id, so the guard is
-- skipped) — which is exactly why this fails quietly rather than loudly.
--
-- THE FIX
-- Wrap that one write in the transaction-local `towconnect.internal_update`
-- flag the guard already honours — the same escape hatch 0014 itself uses
-- for respond_to_dispatch_offer()'s decline branch, and that 0003
-- established for bump_driver_total_services(). Nothing else about the
-- function changes: same authorization check, same expiry semantics, same
-- return value.
--
-- Not a weakening of the guard: the flag is set for the duration of a single
-- system-owned statement inside a SECURITY DEFINER function that has already
-- verified the caller is the rider, the offer-holding driver, or the service
-- role — never something a client can set for itself.
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

    perform set_config('towconnect.internal_update', 'true', true);
    update requests set driver_id = null
    where id = p_request_id and driver_id = v_offer.driver_id and status = 'pending';
    perform set_config('towconnect.internal_update', 'false', true);
  end if;

  -- Also covers the "searching, no offer at all yet" case (v_found_offer =
  -- false): retries the match, e.g. because a new driver just came online.
  return dispatch_next_candidate_core(p_request_id);
end;
$$;

revoke all on function nudge_dispatch(uuid) from public;
grant execute on function nudge_dispatch(uuid) to authenticated, service_role;
