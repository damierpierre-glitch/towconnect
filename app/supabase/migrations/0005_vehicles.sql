-- TowConnect — Phase 1: saved vehicles.
-- Additive migration, run after 0001-0004. Does not touch existing tables'
-- columns other than adding a nullable FK on requests.

-- ============================================================
-- VEHICLES
-- ============================================================
create table vehicles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  make text not null,
  model text not null,
  year integer not null check (year between 1950 and 2100),
  color text,
  plate text,
  province text,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index vehicles_user_idx on vehicles(user_id);

-- A user may have at most one primary vehicle. Partial unique index, not a
-- table-wide constraint, so it only restricts rows where is_primary = true —
-- every other row is unaffected. Enforced at the DB level so no amount of
-- concurrent client requests can create two primaries for the same user.
create unique index vehicles_one_primary_per_user
  on vehicles (user_id)
  where is_primary;

create trigger vehicles_set_updated_at
  before update on vehicles
  for each row execute procedure extensions.moddatetime(updated_at);

alter table vehicles enable row level security;

create policy "vehicles: owner reads own" on vehicles
  for select using (auth.uid() = user_id);

create policy "vehicles: owner inserts own" on vehicles
  for insert with check (auth.uid() = user_id);

create policy "vehicles: owner updates own" on vehicles
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "vehicles: owner deletes own" on vehicles
  for delete using (auth.uid() = user_id);

-- Admins can read all vehicles (support/ops visibility), same pattern as the
-- other tables' admin policies (uses the is_admin() helper from 0004).
create policy "vehicles: admins read all" on vehicles
  for select using (public.is_admin());

-- ============================================================
-- REQUESTS.VEHICLE_ID — links a request to the saved vehicle used, while
-- requests.vehicle_desc (existing column) remains the immutable snapshot of
-- what the vehicle looked like at request time. Editing or deleting a saved
-- vehicle later must never change a past request's displayed info — that's
-- exactly why vehicle_desc is kept and never backfilled from vehicles here.
-- ============================================================
alter table requests
  add column vehicle_id uuid references vehicles(id) on delete set null;

create index requests_vehicle_idx on requests(vehicle_id);
