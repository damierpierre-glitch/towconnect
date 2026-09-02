-- TowConnect — Phase 6, Part B: companies, memberships, fleet vehicles,
-- driver assignments and business service areas. Additive, run after 0023.
--
-- WHY MEMBERSHIP RATHER THAN driver_profiles.company_id
-- 0020 added driver_profiles.company_id as groundwork. It cannot carry this
-- phase: a company has an owner, back-office admins and dispatchers who are
-- not drivers at all and have no driver_profiles row to hang a company_id
-- on. company_members is therefore the source of truth for "who belongs to
-- which company, in what capacity", and driver_profiles.company_id is kept
-- in sync from it by a trigger purely so existing queries and the admin UI
-- keep working. Dispatch (0025) reads membership, never the mirror.
--
-- RLS RECURSION
-- Every policy below that asks "is the caller in this company" goes through
-- a SECURITY DEFINER helper, not an inline subquery on company_members. A
-- policy on company_members that selects from company_members deadlocks into
-- infinite recursion — the same trap 0004 had to fix on profiles. The
-- helpers are the fix, and they are also the only place the rule is written.

-- ============================================================
-- ENUMS
-- ============================================================
create type company_status as enum ('pending', 'active', 'suspended', 'rejected');
create type company_member_role as enum ('owner', 'admin', 'dispatcher', 'driver');
create type company_member_status as enum ('invited', 'active', 'removed');
create type fleet_vehicle_status as enum ('active', 'inactive', 'maintenance');
create type service_area_kind as enum ('radius', 'polygon');

-- The physical capabilities a truck actually has. Deliberately about
-- equipment, not about marketing: 'flatbed' is a deck, 'boost' is a booster
-- pack. Dispatch (0025) maps a customer's problem type onto these through a
-- configurable table rather than hard-coding the relationship.
create type service_capability as enum (
  'flatbed',
  'wheel_lift',
  'heavy_duty',
  'winch',
  'boost',
  'lockout',
  'tire_change',
  'fuel_delivery',
  'recovery'
);

-- ============================================================
-- COMPANIES — extending the 0020 stub into something a real business can
-- be represented by. Only fields with an actual use: nothing here is
-- collected "in case".
-- ============================================================
alter table companies
  add column display_name text,
  add column status company_status not null default 'pending',
  add column phone text,
  add column email text,
  add column province text,
  add column address text,
  add column updated_at timestamptz not null default now();

comment on column companies.name is 'Legal / registered business name.';
comment on column companies.display_name is
  'What customers and the app show. Falls back to name when null.';

create trigger companies_set_updated_at
  before update on companies
  for each row execute procedure extensions.moddatetime(updated_at);

-- ============================================================
-- COMPANY_MEMBERS
-- ============================================================
create table company_members (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  role company_member_role not null,
  status company_member_status not null default 'active',
  invited_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, profile_id)
);

create index company_members_profile_idx on company_members(profile_id) where status = 'active';
create index company_members_company_idx on company_members(company_id, role) where status = 'active';

-- A driver drives for one company at a time. Back-office roles are not
-- constrained this way — an accountant may legitimately serve two operators.
create unique index company_members_one_active_driver_company
  on company_members (profile_id)
  where status = 'active' and role = 'driver';

create trigger company_members_set_updated_at
  before update on company_members
  for each row execute procedure extensions.moddatetime(updated_at);

alter table company_members enable row level security;

-- ============================================================
-- MEMBERSHIP HELPERS — SECURITY DEFINER so policies can call them without
-- recursing through the very table they protect.
-- ============================================================
create or replace function company_role_of(p_company_id uuid, p_profile_id uuid default auth.uid())
returns company_member_role
language sql
stable
security definer set search_path = public
as $$
  select m.role
  from company_members m
  where m.company_id = p_company_id
    and m.profile_id = p_profile_id
    and m.status = 'active'
  limit 1
$$;

create or replace function is_company_member(p_company_id uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select company_role_of(p_company_id) is not null
$$;

-- Owner, company admin or dispatcher. The set allowed to run the business:
-- see the whole company's work, manage fleet and assignments. A 'driver'
-- member is deliberately NOT a manager.
create or replace function is_company_manager(p_company_id uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select company_role_of(p_company_id) in ('owner', 'admin', 'dispatcher')
$$;

-- Only these two may change who belongs to the company or hand out roles. A
-- dispatcher runs the day; they do not staff it.
create or replace function is_company_owner_or_admin(p_company_id uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select company_role_of(p_company_id) in ('owner', 'admin')
$$;

-- The company a driver actually drives for. This — not
-- driver_profiles.company_id — is what dispatch and zone authorization read.
create or replace function driver_company_id(p_profile_id uuid)
returns uuid
language sql
stable
security definer set search_path = public
as $$
  select m.company_id
  from company_members m
  where m.profile_id = p_profile_id
    and m.status = 'active'
    and m.role = 'driver'
  limit 1
$$;

revoke all on function company_role_of(uuid, uuid) from public;
revoke all on function is_company_member(uuid) from public;
revoke all on function is_company_manager(uuid) from public;
revoke all on function is_company_owner_or_admin(uuid) from public;
revoke all on function driver_company_id(uuid) from public;
grant execute on function company_role_of(uuid, uuid) to authenticated, service_role;
grant execute on function is_company_member(uuid) to authenticated, service_role;
grant execute on function is_company_manager(uuid) to authenticated, service_role;
grant execute on function is_company_owner_or_admin(uuid) to authenticated, service_role;
grant execute on function driver_company_id(uuid) to authenticated, service_role;

-- ---- company_members policies ----
create policy "company_members: members read their own company roster" on company_members
  for select using (is_company_member(company_id) or public.is_admin());

-- The invariant the brief calls out: a driver must not be able to attach
-- themself to a company. Only a company's own owner/admin (or a platform
-- admin) may create a membership, so "self-assignment to a foreign company"
-- has no path at all — the WITH CHECK is evaluated against the row being
-- inserted, and a non-member's company_role_of() is null.
create policy "company_members: owners and admins add members" on company_members
  for insert with check (is_company_owner_or_admin(company_id) or public.is_admin());

create policy "company_members: owners and admins update members" on company_members
  for update using (is_company_owner_or_admin(company_id) or public.is_admin())
  with check (is_company_owner_or_admin(company_id) or public.is_admin());

create policy "company_members: owners and admins remove members" on company_members
  for delete using (is_company_owner_or_admin(company_id) or public.is_admin());

-- A company must never be left without an owner, and an owner must not be
-- demoted or deleted by a company admin — only by a platform admin.
create or replace function guard_company_owner()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_old_role company_member_role := case when tg_op = 'INSERT' then null else old.role end;
  v_company uuid := case when tg_op = 'DELETE' then old.company_id else new.company_id end;
begin
  if auth.role() = 'service_role' or public.is_admin() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if v_old_role = 'owner'
     and (tg_op = 'DELETE' or new.role is distinct from 'owner' or new.status is distinct from 'active')
  then
    raise exception 'Only a platform admin can remove or demote a company owner'
      using errcode = '42501';
  end if;

  -- Nobody but a platform admin may mint a second owner either: ownership
  -- transfer is a back-office action with real consequences.
  if tg_op <> 'DELETE' and new.role = 'owner' and v_old_role is distinct from 'owner'
     and exists (
       select 1 from company_members m
       where m.company_id = v_company and m.role = 'owner' and m.status = 'active'
         and (tg_op = 'INSERT' or m.id <> new.id)
     )
  then
    raise exception 'This company already has an owner' using errcode = '42501';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger company_members_guard_owner
  before insert or update or delete on company_members
  for each row execute procedure guard_company_owner();

-- Keep the 0020 mirror column consistent. It is a convenience for existing
-- queries; company_members remains authoritative.
create or replace function sync_driver_company_mirror()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_profile uuid := case when tg_op = 'DELETE' then old.profile_id else new.profile_id end;
begin
  perform set_config('towconnect.internal_update', 'true', true);
  update driver_profiles
  set company_id = driver_company_id(v_profile)
  where profile_id = v_profile;
  perform set_config('towconnect.internal_update', 'false', true);
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger company_members_sync_driver_mirror
  after insert or update or delete on company_members
  for each row execute procedure sync_driver_company_mirror();

comment on column driver_profiles.company_id is
  'Derived mirror of company_members (role=driver, status=active), kept in sync by trigger. '
  'Superseded as the source of truth by company_members — dispatch reads driver_company_id().';

-- ---- companies policies (widened from 0020's owner-only read) ----
create policy "companies: members read own company" on companies
  for select using (is_company_member(id));

create policy "companies: owner and admins update own company" on companies
  for update using (is_company_owner_or_admin(id)) with check (is_company_owner_or_admin(id));

-- Still no INSERT policy for authenticated: creating a company remains a
-- back-office action (platform admin) until there is a real business signup
-- flow with verification behind it. Inventing a self-serve company signup
-- here would let anyone declare themself an operator.

-- Now that company_members exists, a company's managers can see the zone
-- authorizations that apply to them, not just the legal owner.
drop policy "zone providers: company reads own" on regulated_zone_providers;
create policy "zone providers: company members read own" on regulated_zone_providers
  for select using (company_id is not null and is_company_member(company_id));

-- ============================================================
-- FLEET_VEHICLES
-- ============================================================
create table fleet_vehicles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  -- What the yard calls it. Optional: plenty of small operators just say
  -- "the flatbed".
  label text,
  truck_type vehicle_type not null default 'standard',
  plate text,
  province text,
  status fleet_vehicle_status not null default 'active',
  -- The equipment actually on this truck. Empty means "not declared", which
  -- 0025 treats as unknown rather than as incapable — see the note there.
  capabilities service_capability[] not null default '{}',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index fleet_vehicles_company_idx on fleet_vehicles(company_id) where status = 'active';
create unique index fleet_vehicles_plate_per_company
  on fleet_vehicles (company_id, upper(plate)) where plate is not null;

create trigger fleet_vehicles_set_updated_at
  before update on fleet_vehicles
  for each row execute procedure extensions.moddatetime(updated_at);

alter table fleet_vehicles enable row level security;

create policy "fleet_vehicles: company members read own fleet" on fleet_vehicles
  for select using (is_company_member(company_id) or public.is_admin());

create policy "fleet_vehicles: managers write own fleet" on fleet_vehicles
  for all using (is_company_manager(company_id) or public.is_admin())
  with check (is_company_manager(company_id) or public.is_admin());

-- ============================================================
-- DRIVER ↔ VEHICLE ASSIGNMENT
--
-- The brief: a driver must not be able to put themself behind any truck,
-- least of all another company's. There is therefore no self-assignment path
-- at all — insert/update/delete are manager-only, and a trigger additionally
-- refuses any pairing where the driver is not an active member of the
-- vehicle's own company. Policy for authorization, trigger for the
-- cross-company invariant, because a policy cannot see both sides cleanly.
-- ============================================================
create table driver_vehicle_assignments (
  id uuid primary key default gen_random_uuid(),
  fleet_vehicle_id uuid not null references fleet_vehicles(id) on delete cascade,
  driver_id uuid not null references profiles(id) on delete cascade,
  assigned_by uuid references profiles(id),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  ended_at timestamptz
);

create index driver_vehicle_assignments_driver_idx on driver_vehicle_assignments(driver_id) where active;
create index driver_vehicle_assignments_vehicle_idx on driver_vehicle_assignments(fleet_vehicle_id) where active;
create unique index driver_vehicle_assignments_one_active_per_driver
  on driver_vehicle_assignments (driver_id) where active;
create unique index driver_vehicle_assignments_one_active_per_vehicle
  on driver_vehicle_assignments (fleet_vehicle_id) where active;

alter table driver_vehicle_assignments enable row level security;

create or replace function fleet_vehicle_company(p_vehicle_id uuid)
returns uuid
language sql
stable
security definer set search_path = public
as $$ select company_id from fleet_vehicles where id = p_vehicle_id $$;

revoke all on function fleet_vehicle_company(uuid) from public;
grant execute on function fleet_vehicle_company(uuid) to authenticated, service_role;

create policy "driver_vehicle_assignments: company members read own" on driver_vehicle_assignments
  for select using (
    is_company_member(fleet_vehicle_company(fleet_vehicle_id))
    or driver_id = auth.uid()
    or public.is_admin()
  );

create policy "driver_vehicle_assignments: managers assign" on driver_vehicle_assignments
  for all using (
    is_company_manager(fleet_vehicle_company(fleet_vehicle_id)) or public.is_admin()
  )
  with check (
    is_company_manager(fleet_vehicle_company(fleet_vehicle_id)) or public.is_admin()
  );

create or replace function guard_driver_vehicle_assignment()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_company uuid := fleet_vehicle_company(new.fleet_vehicle_id);
begin
  if v_company is null then
    raise exception 'Fleet vehicle % does not exist', new.fleet_vehicle_id using errcode = 'P0001';
  end if;

  -- The cross-company invariant. Holds for the service role too: an
  -- assignment that pairs a driver with another company's truck is wrong no
  -- matter who writes it.
  if company_role_of(v_company, new.driver_id) is distinct from 'driver' then
    raise exception 'Driver % is not an active driver of the company that owns this vehicle', new.driver_id
      using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger driver_vehicle_assignments_guard
  before insert or update on driver_vehicle_assignments
  for each row execute procedure guard_driver_vehicle_assignment();

-- The equipment a given driver can actually bring, resolved through their
-- active truck. Returns an empty array when the driver has no fleet vehicle
-- (an independent operator) — 0025 distinguishes "declared none" from
-- "declared nothing" and never treats the latter as incapable.
create or replace function driver_capabilities(p_driver_id uuid)
returns service_capability[]
language sql
stable
security definer set search_path = public
as $$
  select coalesce(fv.capabilities, '{}')
  from driver_vehicle_assignments a
  join fleet_vehicles fv on fv.id = a.fleet_vehicle_id
  where a.driver_id = p_driver_id and a.active and fv.status = 'active'
  limit 1
$$;

revoke all on function driver_capabilities(uuid) from public;
grant execute on function driver_capabilities(uuid) to authenticated, service_role;

-- ============================================================
-- COMPANY_SERVICE_AREAS
--
-- A real service area, not "the province". Two shapes, because operators
-- genuinely think in both: "40 km around the yard" and "this territory".
-- Secondary to regulated zones by construction — nothing here can grant
-- access to a zone, only narrow where a company wants work.
-- ============================================================
create table company_service_areas (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  name text not null,
  kind service_area_kind not null,

  center_lat double precision,
  center_lng double precision,
  radius_km double precision,

  geometry geography(MultiPolygon, 4326),

  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint company_service_area_shape check (
    (kind = 'radius'
      and center_lat is not null and center_lng is not null
      and radius_km is not null and radius_km > 0 and geometry is null)
    or
    (kind = 'polygon'
      and geometry is not null
      and center_lat is null and center_lng is null and radius_km is null)
  )
);

alter table company_service_areas
  add column center_geog geography(Point, 4326)
  generated always as (
    case
      when center_lat is not null and center_lng is not null
        then ST_SetSRID(ST_MakePoint(center_lng, center_lat), 4326)::geography
      else null
    end
  ) stored;

create index company_service_areas_geom_idx on company_service_areas using gist (geometry);
create index company_service_areas_center_idx on company_service_areas using gist (center_geog);
create index company_service_areas_company_idx on company_service_areas(company_id) where active;

create trigger company_service_areas_set_updated_at
  before update on company_service_areas
  for each row execute procedure extensions.moddatetime(updated_at);

alter table company_service_areas enable row level security;

create policy "service areas: company members read own" on company_service_areas
  for select using (is_company_member(company_id) or public.is_admin());

create policy "service areas: managers write own" on company_service_areas
  for all using (is_company_manager(company_id) or public.is_admin())
  with check (is_company_manager(company_id) or public.is_admin());

-- "Does this company want work at this point?"
--
-- A company that has declared NO service area returns true: silence means
-- "no restriction stated", not "serves nowhere". Reading an empty
-- configuration as a refusal would take every existing operator offline the
-- moment this migration lands.
create or replace function company_covers_point(
  p_company_id uuid,
  p_lat double precision,
  p_lng double precision
)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select
    not exists (
      select 1 from company_service_areas a
      where a.company_id = p_company_id and a.active
    )
    or exists (
      select 1 from company_service_areas a
      where a.company_id = p_company_id
        and a.active
        and (
          (a.kind = 'radius'
            and ST_DWithin(a.center_geog,
                           ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography,
                           a.radius_km * 1000))
          or
          (a.kind = 'polygon'
            and ST_Intersects(a.geometry,
                              ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography))
        )
    )
$$;

revoke all on function company_covers_point(uuid, double precision, double precision) from public;
grant execute on function company_covers_point(uuid, double precision, double precision)
  to authenticated, service_role;

comment on function company_covers_point(uuid, double precision, double precision) is
  'Business service-area check. Strictly secondary to regulated zones: it can only narrow where a '
  'company is offered work, never widen where it is legally allowed to work.';
