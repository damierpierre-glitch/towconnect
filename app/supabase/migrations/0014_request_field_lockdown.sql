-- TowConnect — Phase 4: closes the gap flagged in the Phase 3 report — the
-- assigned driver's own session could, in principle, update ANY column of
-- their request via "requests: assigned driver updates" (0001), not just
-- status. Now that money (price_estimate, price_base/distance/surcharge)
-- and destination data live on this same row, that gap needed closing
-- before Stripe went anywhere near it. Additive, run after 0001-0013.

-- ============================================================
-- guard_request_protected_fields() — the assigned driver's own session may
-- only ever change `status` on their request. Everything else (who it
-- belongs to, which vehicle, pickup/destination, every price field,
-- driver_id itself) is off limits from that session, full stop.
-- ============================================================
create or replace function guard_request_protected_fields()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  -- Escape hatch for the system's own internal writes that legitimately
  -- touch more than `status` from within a driver's auth context — today
  -- that's exactly one place: respond_to_dispatch_offer()'s decline branch,
  -- which clears driver_id back to null. Same pattern as
  -- guard_driver_privileged_fields()'s bump_driver_total_services() escape
  -- hatch in 0003.
  if current_setting('towconnect.internal_update', true) = 'true' then
    return new;
  end if;

  if auth.uid() = old.driver_id and auth.role() <> 'service_role' then
    if new.user_id is distinct from old.user_id
       or new.driver_id is distinct from old.driver_id
       or new.vehicle_id is distinct from old.vehicle_id
       or new.problem_type is distinct from old.problem_type
       or new.location_text is distinct from old.location_text
       or new.lat is distinct from old.lat
       or new.lng is distinct from old.lng
       or new.vehicle_desc is distinct from old.vehicle_desc
       or new.notes is distinct from old.notes
       or new.destination_address is distinct from old.destination_address
       or new.destination_lat is distinct from old.destination_lat
       or new.destination_lng is distinct from old.destination_lng
       or new.tow_distance_km is distinct from old.tow_distance_km
       or new.price_estimate is distinct from old.price_estimate
       or new.price_base is distinct from old.price_base
       or new.price_distance is distinct from old.price_distance
       or new.price_surcharge is distinct from old.price_surcharge
       or new.commission_amount is distinct from old.commission_amount
       or new.partner_amount is distinct from old.partner_amount
    then
      raise exception 'A driver may only update a request''s status' using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

create trigger requests_guard_protected_fields
  before update on requests
  for each row execute procedure guard_request_protected_fields();

-- ============================================================
-- respond_to_dispatch_offer() — redefined only to wrap its decline branch's
-- driver_id write with the internal_update flag the new guard above checks
-- for. The accept/decline/expiry logic itself is unchanged from
-- 0007_dispatch_immediate_advance.sql.
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
    perform set_config('towconnect.internal_update', 'true', true);
    update requests
    set driver_id = null
    where id = p_request_id and driver_id = auth.uid() and status = 'pending'
    returning * into v_request;
    perform set_config('towconnect.internal_update', 'false', true);

    if not found then
      raise exception 'Request % is no longer offered to you', p_request_id using errcode = 'P0001';
    end if;

    if v_found_offer then
      update dispatch_offers set status = 'declined', responded_at = now() where id = v_offer.id;
    end if;

    perform dispatch_next_candidate_core(p_request_id);
  end if;

  return v_request;
end;
$$;

revoke all on function respond_to_dispatch_offer(uuid, boolean) from public;
grant execute on function respond_to_dispatch_offer(uuid, boolean) to authenticated;
