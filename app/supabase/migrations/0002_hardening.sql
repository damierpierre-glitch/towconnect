-- TowConnect hardening pass — see technical review items 2, 3, 4, 5, 6.
-- Run this after 0001_init.sql on the same project.

-- ============================================================
-- 2. price_estimate: revert to numeric — money is never float.
--    (Client code now parses through lib/pricing.ts#toMoney() at every
--    display/arithmetic site instead of relying on the column being a
--    native JS number.)
-- ============================================================
alter table requests
  alter column price_estimate type numeric(8,2);

alter table requests
  alter column price_estimate set default 0;

comment on column requests.price_estimate is
  'numeric, not double precision: this is money. PostgREST returns it as a '
  'string — parse with toMoney() client-side before doing math on it.';

-- ============================================================
-- 3. Atomic accept: accept_request() + one-active-job-per-driver constraint
-- ============================================================

-- A driver can have at most one request in an active (non-terminal) state at
-- a time. Partial unique index — 'pending'/'completed'/'cancelled'/'expired'
-- rows are unaffected, so a driver's history and future offers aren't
-- constrained, only their concurrently active job.
create unique index requests_one_active_job_per_driver
  on requests (driver_id)
  where status in ('matched', 'en_route', 'arrived');

create or replace function accept_request(p_request_id uuid)
returns requests
language plpgsql
security definer set search_path = public
as $$
declare
  v_row requests;
begin
  begin
    update requests
    set status = 'matched'
    where id = p_request_id
      and driver_id = auth.uid()
      and status = 'pending'
    returning * into v_row;
  exception when unique_violation then
    raise exception 'You already have another active job in progress'
      using errcode = 'P0001';
  end;

  if not found then
    raise exception 'Request % is no longer available to accept', p_request_id
      using errcode = 'P0001';
  end if;

  return v_row;
end;
$$;

revoke all on function accept_request(uuid) from public;
grant execute on function accept_request(uuid) to authenticated;

-- ============================================================
-- 4. PostGIS + geospatial nearby-driver search
-- ============================================================
create extension if not exists postgis;

-- Generated geography columns, kept in sync automatically from the existing
-- lat/lng columns — nothing in application code needs to write to these.
alter table driver_profiles
  add column location_geog geography(Point, 4326)
  generated always as (
    case
      when current_lat is not null and current_lng is not null
        then ST_SetSRID(ST_MakePoint(current_lng, current_lat), 4326)::geography
      else null
    end
  ) stored;

alter table requests
  add column location_geog geography(Point, 4326)
  generated always as (
    ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography
  ) stored;

create index driver_profiles_geog_idx on driver_profiles using gist (location_geog);
create index requests_geog_idx on requests using gist (location_geog);

-- Replaces the in-memory Haversine loop in StepDrivers.tsx: does the
-- proximity filter (ST_DWithin) and nearest-first ordering (KNN via <->) in
-- the database, using the GiST index above instead of a full table scan.
--
-- SECURITY DEFINER is deliberate and doubles as the item-5 fix: it lets this
-- function read driver_profiles.location_geog (which RLS otherwise hides
-- from everyone except the driver themself, an admin, or their currently
-- matched rider — see the policy change below) while returning only the
-- computed distance, never the raw coordinates.
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

-- ============================================================
-- 5. Live position exposure: driver coordinates are no longer publicly
--    readable. Discovery goes through nearby_drivers() (item 4, above),
--    which never returns raw lat/lng/location_geog.
-- ============================================================
drop policy "driver_profiles: anyone can read approved online drivers" on driver_profiles;

-- The two remaining broad policies ("driver reads/updates own" and "admins
-- full access") already cover the self and admin cases; this adds the third
-- audience named in the review: a rider whose currently active job is with
-- this specific driver.
create policy "driver_profiles: rider with active job sees assigned driver" on driver_profiles
  for select using (
    exists (
      select 1 from requests r
      where r.driver_id = driver_profiles.profile_id
        and r.user_id = auth.uid()
        and r.status in ('matched', 'en_route', 'arrived')
    )
  );

-- No longer needed: the pre-booking driver directory now goes through
-- nearby_drivers() (SECURITY DEFINER), not a direct client-side select on
-- profiles joined to driver_profiles.
drop policy "profiles: public read of approved driver names" on profiles;

-- ============================================================
-- 6. Stale-data maintenance (called every minute by the cleanup-stale Edge
--    Function — see supabase/functions/cleanup-stale/).
-- ============================================================
-- Safe to run in the same transaction as the rest of this file: the new
-- value is only referenced inside a plpgsql function body below (parsed
-- lazily at first call, not at CREATE FUNCTION time), never used in an
-- executed DML statement here. Postgres only rejects using a brand-new enum
-- value in a statement that runs before the ADD VALUE commits.
alter type request_status add value if not exists 'expired';

alter table driver_profiles
  add column last_heartbeat_at timestamptz;

-- Existing online drivers won't have a heartbeat yet on migrate; give them
-- one now so cleanup_stale() doesn't immediately flip everyone offline.
update driver_profiles set last_heartbeat_at = now() where is_online = true;

create or replace function cleanup_stale(
  p_request_timeout_minutes int default 10,
  p_driver_heartbeat_minutes int default 3
)
returns table (expired_requests int, offline_drivers int)
language plpgsql
security definer set search_path = public
as $$
declare
  v_expired int;
  v_offline int;
begin
  update requests
  set status = 'expired'
  where status = 'pending'
    and created_at < now() - (p_request_timeout_minutes || ' minutes')::interval;
  get diagnostics v_expired = row_count;

  update driver_profiles
  set is_online = false
  where is_online = true
    and (
      last_heartbeat_at is null
      or last_heartbeat_at < now() - (p_driver_heartbeat_minutes || ' minutes')::interval
    );
  get diagnostics v_offline = row_count;

  return query select v_expired, v_offline;
end;
$$;

-- Maintenance function: only the service role (used by the Edge Function)
-- may call it, never anon/authenticated clients.
revoke all on function cleanup_stale(int, int) from public;
grant execute on function cleanup_stale(int, int) to service_role;

-- ============================================================
-- Found while writing the item-8 RLS integration test, not in the original
-- review list: "driver_profiles: driver reads/updates own" is a `for all`
-- policy keyed only on `profile_id = auth.uid()`, with no column-level
-- restriction — RLS is row-level, so as written it lets a driver run
-- `update driver_profiles set approval_status = 'approved' where profile_id
-- = auth.uid()` and have it succeed. A trigger is needed because RLS
-- policies can't express "this column may not change" on their own.
--
-- Scoped narrowly to approval_status (the specific self-approval case named
-- in the review) so it doesn't touch the existing total_services
-- self-increment in advanceRequestStatus() — rating and total_services being
-- similarly driver-writable is a related but separate gap, left as a
-- follow-up rather than folded in here.
-- ============================================================
create or replace function guard_driver_approval_status()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if new.approval_status is distinct from old.approval_status then
    if not exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'admin') then
      raise exception 'Only an admin can change approval_status' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create trigger driver_profiles_guard_approval
  before update on driver_profiles
  for each row execute procedure guard_driver_approval_status();
