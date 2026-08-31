-- TowConnect — Phase 4.5. Two findings from the live validation run, both
-- additive. Run after 0001-0016.
--
-- ============================================================
-- FIX 1 — one shared notion of "available driver"
-- ============================================================
-- nearby_drivers() filtered on approved + is_online + has-a-position, but NOT
-- on heartbeat freshness. dispatch_next_candidate_core() additionally required
-- a heartbeat inside the last 2 minutes. The two therefore disagreed, and the
-- live run reproduced the consequence: a rider was quoted a price and ETA
-- computed from a driver that Smart Dispatch then (correctly) refused to
-- offer the job to — leaving the request searching with no explanation.
--
-- The fix is to move the freshness rule into nearby_drivers() itself, which
-- is the single function every availability question already flows through:
--   * StepEstimate's price/ETA preview
--   * createRequest()'s authoritative server-side pricing
--   * dispatch_next_candidate_core()'s candidate search
-- so all three now agree by construction rather than by duplicated code.
--
-- The window lives in its own function (same pattern as
-- dispatch_offer_window() from 0006) so the value exists in exactly one place
-- instead of being repeated as a literal in two definitions.
create or replace function driver_heartbeat_max_age()
returns interval
language sql
immutable
as $$ select interval '2 minutes' $$;

create or replace function nearby_drivers(
  p_lat double precision,
  p_lng double precision,
  p_radius_km double precision,
  p_limit int default 8
)
returns table (
  profile_id uuid,
  full_name text,
  rating double precision,
  total_services integer,
  vehicle_type vehicle_type,
  distance_km double precision
)
language sql
stable
security definer set search_path = public
as $$
  select
    dp.profile_id,
    p.full_name,
    dp.rating,
    dp.total_services,
    dp.vehicle_type,
    ST_Distance(
      dp.location_geog,
      ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography
    ) / 1000.0 as distance_km
  from driver_profiles dp
  join profiles p on p.id = dp.profile_id
  where dp.approval_status = 'approved'
    and dp.is_online = true
    and dp.location_geog is not null
    -- Added in 0017: a driver whose app stopped pinging is not actually
    -- available, so they must not price a quote either.
    and dp.last_heartbeat_at is not null
    and dp.last_heartbeat_at > now() - driver_heartbeat_max_age()
    and ST_DWithin(
      dp.location_geog,
      ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography,
      p_radius_km * 1000
    )
  order by
    dp.location_geog <-> ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography
  limit p_limit;
$$;

revoke all on function nearby_drivers(double precision, double precision, double precision, int) from public;
grant execute on function nearby_drivers(double precision, double precision, double precision, int) to authenticated;

-- dispatch_next_candidate_core(), unchanged from 0011 except that the
-- heartbeat literal is replaced by the shared window function. The redundant
-- per-candidate freshness check is deliberately KEPT: nearby_drivers() now
-- enforces it too, but leaving it here means dispatch stays correct even if
-- nearby_drivers() is ever relaxed again.
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
      and dp.last_heartbeat_at > now() - driver_heartbeat_max_age()
      and not exists (
        select 1 from requests r2
        where r2.driver_id = c.profile_id and r2.status in ('matched', 'en_route', 'arrived', 'in_progress')
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
-- FIX 2 — stop writing a row that is guaranteed to be rolled back
-- ============================================================
-- The expired-offer branch used to do:
--     update dispatch_offers set status = 'timeout' ...
--     raise exception 'This offer has expired' ...
-- The RAISE aborts the transaction, so that UPDATE never persists — the offer
-- stays 'offered'. Harmless (the essential guarantee, "an expired offer can
-- never be accepted", is enforced by the RAISE itself and is untouched here)
-- but the code and its comment claimed a state change that never happened,
-- which is exactly the kind of thing that misleads the next reader.
--
-- The write is removed rather than made to persist: persisting it would need
-- an autonomous transaction, and it is not needed — nudge_dispatch() and
-- process_dispatch_timeouts() already sweep expired offers, and
-- acceptRequest() in lib/actions/driver.ts now triggers that sweep
-- immediately when it sees this error, in its own transaction.
--
-- Everything else is identical to the 0014 definition.
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
