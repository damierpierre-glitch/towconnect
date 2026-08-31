-- TowConnect — Phase 3 follow-up: 'in_progress' (0009_in_progress_status.sql)
-- represents a driver actively mid-intervention, which is exactly as
-- "active" as 'matched'/'en_route'/'arrived' for every place that already
-- reasoned about "does this driver currently have an active job" or "can
-- the rider currently see this driver's profile". Three spots defined
-- before 'in_progress' existed need to include it too, or a driver mid-job
-- could be double-booked, offered a second job, or have their profile
-- become unreadable by their own rider partway through the intervention.
-- Additive: redefines the same index/policy/function via DROP+CREATE /
-- CREATE OR REPLACE, doesn't touch 0001-0010's files.

-- ============================================================
-- 1. One-active-job-per-driver partial unique index (0002_hardening.sql)
-- ============================================================
drop index if exists requests_one_active_job_per_driver;

create unique index requests_one_active_job_per_driver
  on requests (driver_id)
  where status in ('matched', 'en_route', 'arrived', 'in_progress');

-- ============================================================
-- 2. Rider can read their assigned driver's profile while the job is active
--    (0002_hardening.sql)
-- ============================================================
drop policy if exists "driver_profiles: rider with active job sees assigned driver" on driver_profiles;

create policy "driver_profiles: rider with active job sees assigned driver" on driver_profiles
  for select using (
    exists (
      select 1 from requests r
      where r.driver_id = driver_profiles.profile_id
        and r.user_id = auth.uid()
        and r.status in ('matched', 'en_route', 'arrived', 'in_progress')
    )
  );

-- ============================================================
-- 3. Smart Dispatch must not offer a new job to a driver already mid an
--    'in_progress' intervention (dispatch_next_candidate_core(), most
--    recently redefined in 0007_dispatch_immediate_advance.sql — logic
--    otherwise unchanged, only this one exclusion list is updated).
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
