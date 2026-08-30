-- TowConnect initial schema
-- Run this in the Supabase SQL editor (or via `supabase db push`) on a fresh project.

create extension if not exists "pgcrypto";
create extension if not exists moddatetime schema extensions;

-- ============ ENUMS ============
create type user_role as enum ('user', 'driver', 'admin');
create type driver_approval_status as enum ('pending', 'approved', 'rejected');
create type request_status as enum ('pending', 'matched', 'en_route', 'arrived', 'completed', 'cancelled');
create type vehicle_type as enum ('standard', 'flatbed', 'heavy_duty');

-- ============ PROFILES ============
-- One row per auth.users, created automatically on signup (see trigger below).
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role user_role not null default 'user',
  full_name text not null default '',
  phone text,
  created_at timestamptz not null default now()
);

alter table profiles enable row level security;

create policy "profiles: read own" on profiles
  for select using (auth.uid() = id);

create policy "profiles: admins read all" on profiles
  for select using (
    exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'admin')
  );

create policy "profiles: update own" on profiles
  for update using (auth.uid() = id);

-- The next two profiles policies reference driver_profiles and requests, so
-- they're defined further down this file (search "profiles: public read of
-- approved driver names" / "profiles: request participants read each
-- other") — after those tables exist. CREATE POLICY validates its USING
-- expression immediately, so referencing a not-yet-created table here would
-- fail.

-- Auto-create a profile row when a new auth user signs up.
-- Role and full_name are passed via signup metadata (raw_user_meta_data).
create function handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, role, full_name)
  values (
    new.id,
    coalesce((new.raw_user_meta_data->>'role')::user_role, 'user'),
    coalesce(new.raw_user_meta_data->>'full_name', '')
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure handle_new_user();

-- ============ DRIVER PROFILES ============
create table driver_profiles (
  profile_id uuid primary key references profiles(id) on delete cascade,
  vehicle_type vehicle_type not null default 'standard',
  license_plate text,
  province text not null default '',
  -- double precision (not numeric): PostgREST serializes `numeric` columns as
  -- JSON strings to avoid precision loss, which would break client-side math.
  rating double precision not null default 5.0,
  total_services integer not null default 0,
  is_online boolean not null default false,
  approval_status driver_approval_status not null default 'pending',
  current_lat double precision,
  current_lng double precision,
  updated_at timestamptz not null default now()
);

alter table driver_profiles enable row level security;

create policy "driver_profiles: driver reads/updates own" on driver_profiles
  for all using (auth.uid() = profile_id);

create policy "driver_profiles: anyone can read approved online drivers" on driver_profiles
  for select using (approval_status = 'approved');

create policy "driver_profiles: admins full access" on driver_profiles
  for all using (
    exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'admin')
  );

-- Auto-create a driver_profiles row when a profile with role='driver' is created.
create function handle_new_driver_profile()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if new.role = 'driver' then
    insert into public.driver_profiles (profile_id) values (new.id)
    on conflict (profile_id) do nothing;
  end if;
  return new;
end;
$$;

create trigger on_profile_created_driver
  after insert on profiles
  for each row execute procedure handle_new_driver_profile();

-- ============ REQUESTS ============
create table requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  driver_id uuid references profiles(id) on delete set null,
  problem_type text not null,
  location_text text not null,
  lat double precision not null,
  lng double precision not null,
  vehicle_desc text,
  notes text,
  status request_status not null default 'pending',
  -- double precision (not numeric): see note on driver_profiles.rating above.
  price_estimate double precision not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index requests_status_idx on requests(status);
create index requests_driver_idx on requests(driver_id);
create index requests_user_idx on requests(user_id);

alter table requests enable row level security;

create policy "requests: user reads own" on requests
  for select using (auth.uid() = user_id);

create policy "requests: user creates own" on requests
  for insert with check (auth.uid() = user_id);

create policy "requests: user cancels own" on requests
  for update using (auth.uid() = user_id);

create policy "requests: approved drivers read pending + own assigned" on requests
  for select using (
    status = 'pending'
    or driver_id = auth.uid()
  );

-- WITH CHECK is explicit (not just the USING clause) because declining a
-- request sets driver_id to null on the new row, which would otherwise fail
-- the implicit "new row must also match USING" check.
create policy "requests: assigned driver updates" on requests
  for update using (driver_id = auth.uid())
  with check (driver_id = auth.uid() or driver_id is null);

create policy "requests: driver can claim a pending request" on requests
  for update using (status = 'pending' and driver_id is null);

create policy "requests: admins full access" on requests
  for all using (
    exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'admin')
  );

create trigger requests_set_updated_at
  before update on requests
  for each row execute procedure extensions.moddatetime(updated_at);

-- ============ REQUEST EVENTS (status timeline) ============
create table request_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references requests(id) on delete cascade,
  status request_status not null,
  created_at timestamptz not null default now()
);

alter table request_events enable row level security;

create policy "request_events: visible to request participants" on request_events
  for select using (
    exists (
      select 1 from requests r
      where r.id = request_events.request_id
        and (r.user_id = auth.uid() or r.driver_id = auth.uid())
    )
    or exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'admin')
  );

create policy "request_events: participants can insert" on request_events
  for insert with check (
    exists (
      select 1 from requests r
      where r.id = request_events.request_id
        and (r.user_id = auth.uid() or r.driver_id = auth.uid())
    )
  );

-- Log an event row every time a request's status changes.
create function log_request_status_change()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if (tg_op = 'INSERT') or (old.status is distinct from new.status) then
    insert into public.request_events (request_id, status) values (new.id, new.status);
  end if;
  return new;
end;
$$;

create trigger requests_log_status_insert
  after insert on requests
  for each row execute procedure log_request_status_change();

create trigger requests_log_status_update
  after update on requests
  for each row execute procedure log_request_status_change();

-- ============ PROFILES POLICIES (deferred from above) ============
-- Defined here, not alongside the other profiles policies near the top of
-- this file, because both reference tables (driver_profiles, requests) that
-- don't exist yet at that point — CREATE POLICY validates its USING
-- expression immediately against real tables/columns.

-- Lets users see the (public) name of any approved driver, e.g. in the
-- nearby-drivers list before a request is even created.
create policy "profiles: public read of approved driver names" on profiles
  for select using (
    exists (
      select 1 from driver_profiles dp
      where dp.profile_id = profiles.id and dp.approval_status = 'approved'
    )
  );

-- Lets the two sides of a request see each other's full profile (e.g. phone
-- number) once they are matched, without opening profiles up globally.
create policy "profiles: request participants read each other" on profiles
  for select using (
    exists (
      select 1 from requests r
      where (r.user_id = profiles.id or r.driver_id = profiles.id)
        and (r.user_id = auth.uid() or r.driver_id = auth.uid())
    )
  );

-- ============ REALTIME ============
alter publication supabase_realtime add table requests;
alter publication supabase_realtime add table driver_profiles;
alter publication supabase_realtime add table request_events;
