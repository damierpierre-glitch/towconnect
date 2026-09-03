-- TowConnect — Phase 10: everything needed to run a small, closed pilot on
-- Montréal & Rive-Sud without lying to anyone. Additive, run after 0046.
--
-- WHAT THIS MIGRATION IS NOT
-- It is not a feature phase. Nothing here makes TowConnect do more; every
-- table below makes a risk visible, or makes a claim refusable. The four
-- ideas, in order:
--
--   1. A readiness item cannot be green without evidence — enforced by a
--      CHECK constraint, not by a habit.
--   2. Coverage is a DECLARATION, never a proof. The table says what we mean
--      to serve; a separate function reports how many partners can actually
--      serve it, and those two numbers are allowed to disagree loudly.
--   3. The pilot gate can close the platform without a deploy — and it is a
--      trigger on `requests`, so a forgotten code path cannot walk around it.
--   4. Analytics may not carry anything about a person. A whitelist trigger
--      refuses the key, rather than a code review being asked to notice it.

-- ============================================================
-- 1. LAUNCH READINESS — the checklist as data
-- ============================================================
-- A checklist in a document rots the day after it is written, and the version
-- everybody quotes is the stale one. This lives beside the system it
-- describes and is read by verify:phase10.
--
-- THE CONSTRAINT IS THE POINT
-- `ready` requires evidence. "How do you know?" is the only question that
-- matters on a launch checklist, and a row that cannot answer it cannot be
-- marked ready. That is a constraint precisely because ticking a box on a
-- busy day is exactly what a launch checklist exists to resist.
create type readiness_domain as enum (
  'product', 'customer', 'driver', 'business', 'operations', 'finance',
  'regulatory', 'security', 'privacy', 'monitoring', 'support', 'data',
  'legal', 'commercial'
);

create type readiness_status as enum (
  'not_started',
  'in_progress',
  'ready',
  'blocked',
  'not_applicable'   -- out of scope for the pilot, with the reason recorded
);

create table launch_readiness_items (
  id uuid primary key default gen_random_uuid(),
  domain readiness_domain not null,
  -- Stable key, so a script can assert on one item without matching prose.
  key text not null unique check (key ~ '^[a-z0-9_.]{3,64}$'),
  title text not null check (length(btrim(title)) > 0),
  status readiness_status not null default 'not_started',
  -- Never a fabricated name. 'Founder / Product' is who actually holds it
  -- today; 'future <role>' is honest about a seat nobody sits in yet.
  owner text not null check (length(btrim(owner)) > 0),
  -- How somebody else could check it: a script name, a document path, a
  -- screen, a Stripe dashboard page.
  evidence text,
  -- Does an unready item stop the pilot, or merely get carried into it?
  blocker boolean not null default false,
  last_reviewed_at timestamptz,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint readiness_ready_requires_evidence check (
    status <> 'ready' or (evidence is not null and length(btrim(evidence)) > 0)
  ),
  constraint readiness_not_applicable_requires_note check (
    status <> 'not_applicable' or (note is not null and length(btrim(note)) > 0)
  ),
  constraint readiness_blocked_requires_note check (
    status <> 'blocked' or (note is not null and length(btrim(note)) > 0)
  )
);

create index launch_readiness_domain_idx on launch_readiness_items(domain, key);
create index launch_readiness_blocker_idx on launch_readiness_items(status) where blocker;

create trigger launch_readiness_set_updated_at
  before update on launch_readiness_items
  for each row execute procedure extensions.moddatetime(updated_at);

alter table launch_readiness_items enable row level security;

create policy "readiness: admins read" on launch_readiness_items
  for select using (public.is_admin());
create policy "readiness: operations write" on launch_readiness_items
  for all using (public.has_admin_capability('operations'))
  with check (public.has_admin_capability('operations'));

comment on table launch_readiness_items is
  'The pilot launch checklist, as data. A row cannot be marked ready without evidence - that is a '
  'CHECK constraint, because ticking a box is easier than proving one.';

-- ============================================================
-- 2. PILOT COVERAGE — a declaration, never a proof
-- ============================================================
-- This table answers "where do we intend to operate". It does NOT answer
-- "where can somebody actually be rescued" — pilot_coverage_report() answers
-- that by counting partners, and the two are allowed to disagree.
--
-- AND IT NEVER TOUCHES THE REGULATED ENGINE
-- Being inside a declared coverage area grants nothing. A point inside a
-- restricted zone is still stamped and still held or redirected by 0023's
-- rules; coverage is evaluated separately and can only ever remove options,
-- never add them. Reversing that would let a commercial decision quietly
-- override a law, which is the failure ADR-0001 exists to prevent.
create type pilot_coverage_state as enum (
  'served',       -- inside the declared pilot territory
  'not_served'    -- deliberately excluded, with the reason stated
);

create table pilot_coverage_areas (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) > 0),
  state pilot_coverage_state not null,
  kind service_area_kind not null,

  center_lat double precision,
  center_lng double precision,
  radius_km double precision,
  geometry geography(MultiPolygon, 4326),

  -- Mandatory, and it is the honest half of this table: what this shape is,
  -- and what it is not.
  note text not null check (length(btrim(note)) > 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint pilot_coverage_shape check (
    (kind = 'radius'
      and center_lat is not null and center_lng is not null
      and radius_km is not null and radius_km > 0 and geometry is null)
    or
    (kind = 'polygon'
      and geometry is not null
      and center_lat is null and center_lng is null and radius_km is null)
  )
);

alter table pilot_coverage_areas
  add column center_geog geography(Point, 4326)
  generated always as (
    case
      when center_lat is not null and center_lng is not null
        then ST_SetSRID(ST_MakePoint(center_lng, center_lat), 4326)::geography
      else null
    end
  ) stored;

create index pilot_coverage_geom_idx on pilot_coverage_areas using gist (geometry);
create index pilot_coverage_center_idx on pilot_coverage_areas using gist (center_geog);

create trigger pilot_coverage_set_updated_at
  before update on pilot_coverage_areas
  for each row execute procedure extensions.moddatetime(updated_at);

alter table pilot_coverage_areas enable row level security;

-- Readable by any signed-in user: a customer is entitled to be told, before
-- they finish typing an address, that we do not serve it yet.
create policy "pilot coverage: signed-in users read active" on pilot_coverage_areas
  for select using (active);
create policy "pilot coverage: operations write" on pilot_coverage_areas
  for all using (public.has_admin_capability('operations'))
  with check (public.has_admin_capability('operations'));

comment on table pilot_coverage_areas is
  'Declared pilot territory. A commercial statement of intent, NOT evidence that anybody is '
  'available there - pilot_coverage_report() answers that separately. Never consulted by the '
  'regulated-zone engine and unable to override it.';

-- ============================================================
-- 3. PILOT CONFIG — the switch, and the gate it drives
-- ============================================================
-- One row, enforced by the primary key. Three modes:
--
--   off    — behave exactly as before this migration. THE DEFAULT, because a
--            migration that silently starts refusing requests is a migration
--            that takes a platform down at 3am.
--   pilot  — the gate is live: territory, hours and (optionally) an allowlist.
--   paused — refuse new requests with a stated reason. Jobs already running
--            are untouched: pausing intake must never abandon somebody who is
--            already waiting at the roadside.
create type pilot_mode as enum ('off', 'pilot', 'paused');

create table pilot_config (
  -- Singleton. `id` can only be true, so there can only ever be one row.
  id boolean primary key default true check (id),
  mode pilot_mode not null default 'off',
  territory_label text not null default 'Montréal & Rive-Sud',

  -- NULL means "no hours restriction stated". Not "closed": an unset field
  -- must never read as a refusal.
  hours_start time,
  hours_end time,
  timezone text not null default 'America/Toronto',

  allowlist_enabled boolean not null default false,
  -- Deliberately NULL. How many ready partners the territory needs before it
  -- opens is a commercial decision nobody has made, and a number invented
  -- here would be quoted back as the answer.
  min_ready_partners integer check (min_ready_partners is null or min_ready_partners > 0),

  paused_reason text,
  updated_at timestamptz not null default now(),
  -- SET NULL, not the default RESTRICT: an administrator leaving must never
  -- make the pilot switch itself undeletable. The same shape as the
  -- payout/company cycle found in Phase 7.1.
  updated_by uuid references profiles(id) on delete set null,

  constraint pilot_paused_requires_reason check (
    mode <> 'paused' or (paused_reason is not null and length(btrim(paused_reason)) > 0)
  ),
  constraint pilot_hours_both_or_neither check (
    (hours_start is null) = (hours_end is null)
  )
);

insert into pilot_config (id) values (true);

alter table pilot_config enable row level security;

-- Any signed-in user may read it: the customer app has to be able to say
-- "we are paused" rather than failing at submit with a database error.
create policy "pilot config: signed-in users read" on pilot_config
  for select using (auth.uid() is not null);
create policy "pilot config: operations write" on pilot_config
  for all using (public.has_admin_capability('operations'))
  with check (public.has_admin_capability('operations'));

-- Who may use the platform while the pilot is gated. Empty by default and
-- irrelevant unless allowlist_enabled — an empty allowlist with the flag ON
-- means nobody, which is a legitimate thing to want on the morning of a
-- launch and a terrible accident to have by default.
create table pilot_allowlist (
  profile_id uuid primary key references profiles(id) on delete cascade,
  note text,
  added_by uuid references profiles(id) on delete set null,
  added_at timestamptz not null default now()
);

alter table pilot_allowlist enable row level security;

-- A person may check whether they themselves are on it. They may not read
-- the list: who else is being let in is not their business.
create policy "pilot allowlist: read own row" on pilot_allowlist
  for select using (profile_id = auth.uid() or public.has_admin_capability('operations'));
create policy "pilot allowlist: operations write" on pilot_allowlist
  for all using (public.has_admin_capability('operations'))
  with check (public.has_admin_capability('operations'));

comment on table pilot_config is
  'The pilot switch. Changing mode closes or opens intake WITHOUT a deploy, and the enforcement is '
  'a trigger on requests (below), not a check in one server action.';

-- ============================================================
-- 4. WHERE THE PILOT REACHES — evaluated, never assumed
-- ============================================================
-- 'undeclared' is a third answer on purpose. No declared territory at all
-- means "no restriction stated", exactly as company_covers_point() reads an
-- empty service-area list — not "serves nowhere". An empty configuration
-- that reads as a refusal is how a migration takes a platform offline.
create or replace function pilot_point_coverage(p_lat double precision, p_lng double precision)
returns text
language sql
stable
security definer set search_path = public
as $$
  select case
    -- An exclusion wins. If somebody has deliberately carved a hole in the
    -- territory, the hole is the decision.
    when exists (
      select 1 from pilot_coverage_areas a
      where a.active and a.state = 'not_served'
        and (
          (a.kind = 'radius' and ST_DWithin(a.center_geog,
             ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography, a.radius_km * 1000))
          or (a.kind = 'polygon' and ST_Intersects(a.geometry,
             ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography))
        )
    ) then 'not_served'
    when exists (
      select 1 from pilot_coverage_areas a
      where a.active and a.state = 'served'
        and (
          (a.kind = 'radius' and ST_DWithin(a.center_geog,
             ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography, a.radius_km * 1000))
          or (a.kind = 'polygon' and ST_Intersects(a.geometry,
             ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography))
        )
    ) then 'served'
    when not exists (
      select 1 from pilot_coverage_areas a where a.active and a.state = 'served'
    ) then 'undeclared'
    else 'not_served'
  end;
$$;

revoke all on function pilot_point_coverage(double precision, double precision) from public;
grant execute on function pilot_point_coverage(double precision, double precision)
  to authenticated, service_role;

comment on function pilot_point_coverage(double precision, double precision) is
  'served / not_served / undeclared. Says where TowConnect intends to operate. Says nothing about '
  'whether a tow truck is available, and grants nothing inside a regulated zone.';

-- ============================================================
-- 5. THE PILOT GATE
-- ============================================================
-- One function decides, and one trigger enforces. The server action calls the
-- function so it can show a sentence instead of a database error; the trigger
-- exists because a server action is a code path somebody can forget.
create or replace function pilot_gate(
  p_profile_id uuid,
  p_lat double precision,
  p_lng double precision
)
returns table (allowed boolean, reason text, detail text)
language plpgsql
stable
security definer set search_path = public
as $$
declare
  cfg public.pilot_config;
  v_local_time time;
  v_coverage text;
begin
  select * into cfg from public.pilot_config where id;

  -- No config row at all would be a broken install, not a closed platform.
  if not found or cfg.mode = 'off' then
    return query select true, 'open'::text, null::text;
    return;
  end if;

  if cfg.mode = 'paused' then
    return query select false, 'paused'::text, cfg.paused_reason;
    return;
  end if;

  -- mode = 'pilot' from here.
  if cfg.allowlist_enabled then
    if p_profile_id is null
       or not exists (select 1 from public.pilot_allowlist a where a.profile_id = p_profile_id) then
      return query select false, 'not_on_allowlist'::text, null::text;
      return;
    end if;
  end if;

  if cfg.hours_start is not null then
    v_local_time := (now() at time zone cfg.timezone)::time;
    -- A window that wraps midnight (22:00 -> 06:00) is the normal case for
    -- roadside work, so it is handled rather than assumed away.
    if cfg.hours_start <= cfg.hours_end then
      if v_local_time < cfg.hours_start or v_local_time >= cfg.hours_end then
        return query select false, 'outside_hours'::text,
          to_char(cfg.hours_start, 'HH24:MI') || '-' || to_char(cfg.hours_end, 'HH24:MI')
          || ' ' || cfg.timezone;
        return;
      end if;
    else
      if v_local_time < cfg.hours_start and v_local_time >= cfg.hours_end then
        return query select false, 'outside_hours'::text,
          to_char(cfg.hours_start, 'HH24:MI') || '-' || to_char(cfg.hours_end, 'HH24:MI')
          || ' ' || cfg.timezone;
        return;
      end if;
    end if;
  end if;

  if p_lat is not null and p_lng is not null then
    v_coverage := public.pilot_point_coverage(p_lat, p_lng);
    if v_coverage = 'not_served' then
      return query select false, 'outside_territory'::text, cfg.territory_label;
      return;
    end if;
  end if;

  return query select true, 'open'::text, null::text;
end;
$$;

revoke all on function pilot_gate(uuid, double precision, double precision) from public;
grant execute on function pilot_gate(uuid, double precision, double precision)
  to authenticated, service_role;

-- The enforcement. A BEFORE INSERT trigger sees every path to a new request,
-- including the ones a future feature forgets to guard.
--
-- ONLY INTAKE. Nothing here touches a request that already exists: pausing
-- the pilot must never abandon somebody who is already waiting by the road.
create or replace function guard_pilot_gate()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  g record;
begin
  select * into g from public.pilot_gate(new.user_id, new.lat, new.lng);
  if not g.allowed then
    raise exception 'pilot_closed:%', g.reason
      using errcode = 'TC010',
            hint = coalesce(g.detail, '');
  end if;
  return new;
end;
$$;

create trigger requests_pilot_gate
  before insert on requests
  for each row execute procedure guard_pilot_gate();

comment on function guard_pilot_gate() is
  'Refuses NEW requests while the pilot is paused, out of hours, outside the declared territory, or '
  'from somebody not on the allowlist. Existing jobs are never touched.';

-- ============================================================
-- 6. PARTNER PILOT STATUS — commercial, and nothing else
-- ============================================================
-- THREE DIFFERENT WORDS THAT ALL SOUND LIKE "ready"
--   companies.status          — approved to operate at all (compliance)
--   companies.pilot_status    — where they are in OUR rollout (commercial)
--   driver_profiles.is_online — whether a truck is available right now
--
-- Conflating any two of them produces the same bug in three disguises:
-- somebody being dispatched work they are not allowed to do, or somebody
-- being counted as capacity who is asleep. So this column is commercial only,
-- and the dispatch engine never reads it.
create type partner_pilot_status as enum (
  'none',        -- not part of the pilot conversation
  'invited',     -- contacted, nothing signed
  'onboarding',  -- filling in company, drivers, vehicles, documents
  'ready',       -- could take a job; has not been switched on
  'active',      -- switched on for the pilot
  'paused'       -- temporarily out, by their choice or ours
);

alter table companies
  add column pilot_status partner_pilot_status not null default 'none',
  add column pilot_status_note text,
  add column pilot_status_updated_at timestamptz;

create index companies_pilot_status_idx on companies(pilot_status)
  where pilot_status <> 'none';

-- A company must not be able to promote itself into the pilot. Same reasoning
-- as guard_driver_approval_status() in 0002: the field that decides whether
-- somebody gets work is never writable by the person who wants the work.
create or replace function guard_company_pilot_status()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if new.pilot_status is distinct from old.pilot_status
     or new.pilot_status_note is distinct from old.pilot_status_note then
    if coalesce(auth.role(), '') <> 'service_role'
       and not coalesce(public.has_admin_capability('operations'), false) then
      raise exception 'Pilot status is set by TowConnect operations, not by the company.'
        using errcode = '42501';
    end if;
    new.pilot_status_updated_at := now();
  end if;
  return new;
end;
$$;

create trigger companies_guard_pilot_status
  before update on companies
  for each row execute procedure guard_company_pilot_status();

-- ============================================================
-- 7. PARTNER READINESS — computed from the system, not asserted
-- ============================================================
-- The blocking reasons come from the same functions dispatch uses, so a
-- company shown as ready here and refused by dispatch would be one bug in one
-- place rather than a disagreement between two opinions.
create or replace function pilot_partner_readiness()
returns table (
  company_id uuid,
  company_name text,
  status company_status,
  pilot_status partner_pilot_status,
  drivers_total bigint,
  drivers_dispatchable bigint,
  drivers_online bigint,
  fleet_vehicles bigint,
  service_areas bigint,
  connect_charges_enabled boolean,
  connect_payouts_enabled boolean,
  blocking_reasons text[]
)
language plpgsql
stable
security definer set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and not coalesce(public.has_admin_capability('operations'), false)
     and not coalesce(public.has_admin_capability('finance'), false) then
    raise exception 'Not authorized to read partner readiness' using errcode = '42501';
  end if;

  return query
  with roster as (
    select cm.company_id, cm.profile_id
    from company_members cm
    where cm.status = 'active' and cm.role in ('driver', 'owner', 'admin')
      and exists (select 1 from driver_profiles dp where dp.profile_id = cm.profile_id)
  ),
  counts as (
    select
      c.id,
      (select count(*) from roster r where r.company_id = c.id) as drivers_total,
      (select count(*) from roster r
        where r.company_id = c.id
          and not coalesce(public.driver_dispatch_blocked(r.profile_id), true)) as drivers_dispatchable,
      (select count(*) from roster r
        join driver_profiles dp on dp.profile_id = r.profile_id
        where r.company_id = c.id and dp.is_online) as drivers_online,
      (select count(*) from fleet_vehicles fv
        where fv.company_id = c.id and fv.status = 'active') as vehicles,
      (select count(*) from company_service_areas sa
        where sa.company_id = c.id and sa.active) as areas
    from companies c
  )
  select
    c.id,
    coalesce(c.display_name, c.name),
    c.status,
    c.pilot_status,
    k.drivers_total,
    k.drivers_dispatchable,
    k.drivers_online,
    k.vehicles,
    k.areas,
    c.connect_charges_enabled,
    c.connect_payouts_enabled,
    -- Every reason is a fact read out of the system, never a judgement.
    (
      select coalesce(array_agg(reason), array[]::text[])
      from (
        select 'company not active'::text as reason where c.status <> 'active'
        union all
        select 'no driver on the roster' where k.drivers_total = 0
        union all
        select 'no driver passes compliance' where k.drivers_total > 0 and k.drivers_dispatchable = 0
        union all
        select 'no active fleet vehicle' where k.vehicles = 0
        union all
        select 'Stripe Connect cannot accept charges' where not c.connect_charges_enabled
        union all
        select 'Stripe Connect cannot pay out' where not c.connect_payouts_enabled
      ) reasons
    )
  from companies c
  join counts k on k.id = c.id
  order by c.pilot_status desc, coalesce(c.display_name, c.name);
end;
$$;

revoke all on function pilot_partner_readiness() from public;
grant execute on function pilot_partner_readiness() to authenticated, service_role;

-- How many partners could actually take a job inside a declared area.
--
-- A company that has declared NO service area is counted everywhere, because
-- that is exactly how company_covers_point() reads silence — one reading of
-- an empty configuration, not two competing ones.
create or replace function pilot_coverage_report()
returns table (
  area_name text,
  state pilot_coverage_state,
  note text,
  partners_ready bigint,
  partners_active bigint,
  drivers_dispatchable bigint
)
language plpgsql
stable
security definer set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and not coalesce(public.has_admin_capability('operations'), false) then
    raise exception 'Not authorized to read the coverage report' using errcode = '42501';
  end if;

  return query
  with reach as (
    select ca.id as area_id, c.id as company_id
    from pilot_coverage_areas ca
    cross join companies c
    where ca.active and ca.state = 'served'
      and (
        not exists (select 1 from company_service_areas sa
                    where sa.company_id = c.id and sa.active)
        or exists (
          select 1 from company_service_areas sa
          where sa.company_id = c.id and sa.active
            and case
              when sa.kind = 'radius' and ca.kind = 'radius'
                then ST_DWithin(sa.center_geog, ca.center_geog,
                                (sa.radius_km + ca.radius_km) * 1000)
              when sa.kind = 'radius' and ca.kind = 'polygon'
                then ST_DWithin(ca.geometry, sa.center_geog, sa.radius_km * 1000)
              when sa.kind = 'polygon' and ca.kind = 'radius'
                then ST_DWithin(sa.geometry, ca.center_geog, ca.radius_km * 1000)
              else ST_Intersects(sa.geometry, ca.geometry)
            end
        )
      )
  )
  select
    ca.name,
    ca.state,
    ca.note,
    (select count(*) from reach r join companies c on c.id = r.company_id
      where r.area_id = ca.id and c.pilot_status in ('ready', 'active')),
    (select count(*) from reach r join companies c on c.id = r.company_id
      where r.area_id = ca.id and c.pilot_status = 'active'),
    (select count(*) from reach r
      join company_members cm on cm.company_id = r.company_id and cm.status = 'active'
      join driver_profiles dp on dp.profile_id = cm.profile_id
      where r.area_id = ca.id
        and not coalesce(public.driver_dispatch_blocked(cm.profile_id), true))
  from pilot_coverage_areas ca
  where ca.active
  order by ca.state, ca.name;
end;
$$;

revoke all on function pilot_coverage_report() from public;
grant execute on function pilot_coverage_report() to authenticated, service_role;

comment on function pilot_coverage_report() is
  'Declared territory beside the capacity that actually reaches it. The point is that these two '
  'numbers can disagree, and that the disagreement is visible before a customer discovers it.';

-- ============================================================
-- 8. PARTNER LINKS — where a request came from, and nothing more
-- ============================================================
-- A QR sticker in a tyre shop and a link on a garage's page need to be
-- distinguishable, so we can tell which channel actually produced work. That
-- is the whole ambition: this is NOT a referral programme, there is no
-- payout attached to a code, and nothing about a code changes what anybody
-- is charged or paid.
create table partner_links (
  code text primary key check (code ~ '^[a-z0-9][a-z0-9-]{2,31}$'),
  label text not null check (length(btrim(label)) > 0),
  -- Nullable: a code can belong to a channel rather than a company (a poster,
  -- a local event, a business card).
  company_id uuid references companies(id) on delete set null,
  kind text not null check (kind in ('qr', 'link', 'manual')),
  active boolean not null default true,
  note text,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table partner_links enable row level security;

-- Anyone signed in may resolve a code they were handed — otherwise the app
-- cannot tell a customer which partner sent them, and cannot reject a code
-- that does not exist.
create policy "partner links: signed-in users read active" on partner_links
  for select using (active or public.has_admin_capability('operations'));
create policy "partner links: operations write" on partner_links
  for all using (public.has_admin_capability('operations'))
  with check (public.has_admin_capability('operations'));

alter table requests
  add column attribution_code text references partner_links(code) on delete set null;

create index requests_attribution_idx on requests(attribution_code)
  where attribution_code is not null;

-- Set once, at creation. Attribution that can be edited afterwards is not
-- attribution, it is a story about where work came from.
create or replace function guard_request_attribution()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if new.attribution_code is distinct from old.attribution_code then
    raise exception 'Attribution is recorded when the request is created and cannot be changed.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger requests_guard_attribution
  before update on requests
  for each row execute procedure guard_request_attribution();

-- ============================================================
-- 9. PRODUCT EVENTS — the funnel, with the person left out
-- ============================================================
-- The events are an ENUM, not free text. A vague event name ("clicked",
-- "error") is worse than no event: it produces a number nobody can act on and
-- everybody quotes. Adding a step is a migration, on purpose.
create type product_event_name as enum (
  'landing_viewed',
  'signup_started',
  'login_started',
  'auth_completed',
  'location_obtained',
  'location_denied',
  'vehicle_selected',
  'situation_selected',
  'estimate_shown',
  'checkout_started',
  'payment_authorized',
  'request_created',
  'request_matched',
  'driver_arrived',
  'request_completed',
  'request_cancelled'
);

create table product_events (
  id uuid primary key default gen_random_uuid(),
  name product_event_name not null,
  -- Who, when we already know: their own funnel is their own data.
  profile_id uuid references profiles(id) on delete set null,
  -- A random per-browser id so an anonymous landing view can be joined to the
  -- signup that followed it. It is not an identity and is never resolved to
  -- one; it exists to make a conversion rate countable.
  anon_id text check (anon_id is null or anon_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  request_id uuid references requests(id) on delete set null,
  attribution_code text,
  props jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index product_events_funnel_idx on product_events(created_at desc, name);
create index product_events_anon_idx on product_events(anon_id, created_at)
  where anon_id is not null;

alter table product_events enable row level security;

-- Nobody writes here through the API. The only path is record_product_event()
-- below, which is what applies the rules.
create policy "product events: operations and finance read" on product_events
  for select using (
    public.has_admin_capability('operations') or public.has_admin_capability('finance')
  );

-- THE WHITELIST IS THE PRIVACY CONTROL
-- Not a review checklist, not a convention — a trigger that refuses the row.
-- Analytics is where personal data leaks by accident, because the field that
-- carries it was added to answer a reasonable question.
create or replace function guard_product_event_props()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  k text;
  allowed constant text[] := array[
    'problem_type', 'vehicle_type', 'has_destination', 'step', 'reason',
    'duration_ms', 'source', 'platform', 'viewport', 'locale', 'error_code',
    'coverage', 'regulated_state'
  ];
begin
  if jsonb_typeof(new.props) <> 'object' then
    raise exception 'Event properties must be an object.' using errcode = '22023';
  end if;

  for k in select jsonb_object_keys(new.props) loop
    if not (k = any (allowed)) then
      raise exception 'Event property "%" is not on the analytics whitelist.', k
        using errcode = '42501',
              hint = 'Analytics carries shapes of behaviour, never facts about a person.';
    end if;
    -- A whitelisted key is still capable of carrying a paragraph. Anything
    -- long enough to be prose is long enough to be a name or an address.
    if jsonb_typeof(new.props -> k) = 'string' and length(new.props ->> k) > 64 then
      raise exception 'Event property "%" is too long for analytics.', k
        using errcode = '22001';
    end if;
  end loop;

  return new;
end;
$$;

create trigger product_events_guard_props
  before insert or update on product_events
  for each row execute procedure guard_product_event_props();

-- The only way in. Rate-limited per browser inside the function rather than
-- in one caller, because this is an unauthenticated path by nature: a landing
-- view happens before anybody signs in.
create or replace function record_product_event(
  p_name product_event_name,
  p_anon_id text default null,
  p_request_id uuid default null,
  p_attribution_code text default null,
  p_props jsonb default '{}'::jsonb
)
returns void
language plpgsql
volatile
security definer set search_path = public
as $$
declare
  v_recent integer;
begin
  if p_anon_id is not null then
    select count(*) into v_recent
    from product_events e
    where e.anon_id = p_anon_id and e.created_at > now() - interval '1 hour';
    -- Generous for a real session, useless for a flood.
    if v_recent >= 300 then
      return;
    end if;
  end if;

  insert into product_events (name, profile_id, anon_id, request_id, attribution_code, props)
  values (p_name, auth.uid(), p_anon_id, p_request_id,
          nullif(btrim(coalesce(p_attribution_code, '')), ''), coalesce(p_props, '{}'::jsonb));
end;
$$;

revoke all on function record_product_event(product_event_name, text, uuid, text, jsonb) from public;
grant execute on function record_product_event(product_event_name, text, uuid, text, jsonb)
  to authenticated, service_role;

comment on table product_events is
  'The acquisition funnel. Event names are an enum and properties are whitelisted by a trigger, so '
  'analytics cannot accumulate personal data by accident. No chat content, no address, no money.';

-- ============================================================
-- 10. THE FUNNEL, READ BACK
-- ============================================================
-- Counts and one conversion rate per step. Deliberately no cohorting, no
-- attribution modelling and no "predicted" anything: at pilot volume those
-- would be noise dressed as insight.
create or replace function funnel_summary(p_from timestamptz, p_to timestamptz)
returns table (
  step integer,
  name text,
  events bigint,
  sessions bigint,
  conversion_from_previous numeric
)
language plpgsql
stable
security definer set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and not coalesce(public.has_admin_capability('operations'), false)
     and not coalesce(public.has_admin_capability('finance'), false) then
    raise exception 'Not authorized to read the funnel' using errcode = '42501';
  end if;

  return query
  with ordered as (
    select * from (values
      (1,  'landing_viewed'),
      (2,  'auth_completed'),
      (3,  'location_obtained'),
      (4,  'vehicle_selected'),
      (5,  'situation_selected'),
      (6,  'estimate_shown'),
      (7,  'checkout_started'),
      (8,  'payment_authorized'),
      (9,  'request_created'),
      (10, 'request_matched'),
      (11, 'driver_arrived'),
      (12, 'request_completed')
    ) as t(step, name)
  ),
  counted as (
    select
      o.step,
      o.name,
      (select count(*) from product_events e
        where e.name::text = o.name and e.created_at >= p_from and e.created_at < p_to) as events,
      (select count(distinct coalesce(e.anon_id, e.profile_id::text)) from product_events e
        where e.name::text = o.name and e.created_at >= p_from and e.created_at < p_to) as sessions
    from ordered o
  )
  select
    c.step,
    c.name,
    c.events,
    c.sessions,
    -- NULL, never 0, when the previous step never happened: "nobody got here"
    -- and "everybody who got here dropped" are different facts.
    case
      when lag(c.sessions) over (order by c.step) is null then null
      when lag(c.sessions) over (order by c.step) = 0 then null
      else round(c.sessions::numeric * 100 / lag(c.sessions) over (order by c.step), 1)
    end
  from counted c
  order by c.step;
end;
$$;

revoke all on function funnel_summary(timestamptz, timestamptz) from public;
grant execute on function funnel_summary(timestamptz, timestamptz) to authenticated, service_role;

-- ============================================================
-- 11. SYSTEM HEALTH — measured, and honest about what it cannot see
-- ============================================================
-- THREE STATES, NOT TWO
-- 'unknown' is the important one. A health board that renders "ok" because it
-- failed to read a signal is worse than no health board: it converts an
-- outage into a green tick. Every component below can return unknown, and
-- says why.
create or replace function ops_system_health()
returns table (
  component text,
  state text,          -- ok | attention | unknown
  detail text,
  measured_at timestamptz
)
language plpgsql
stable
security definer set search_path = public
as $$
declare
  v_last_cron timestamptz;
  v_cron_failures integer;
  v_last_webhook timestamptz;
  v_webhooks bigint;
  v_stuck_dispatch integer;
  v_stuck_payments integer;
  v_realtime integer;
  v_exceptions integer;
  v_super_admins integer;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and not coalesce(public.has_admin_capability('operations'), false) then
    raise exception 'Not authorized to read system health' using errcode = '42501';
  end if;

  -- Database -----------------------------------------------------------
  return query select 'database'::text, 'ok'::text,
    'Answering. Up since ' || to_char(pg_postmaster_start_time(), 'YYYY-MM-DD HH24:MI') || ' UTC.',
    now();

  -- Scheduler ----------------------------------------------------------
  -- Dispatch timeouts and stale-job cleanup only happen because pg_cron runs
  -- them. A scheduler that stopped is invisible from the application: nothing
  -- errors, work simply stops being swept up.
  if to_regclass('cron.job_run_details') is null then
    return query select 'scheduler'::text, 'unknown'::text,
      'cron.job_run_details is not readable from here; check the Supabase dashboard.'::text, now();
  else
    select max(start_time), count(*) filter (where status <> 'succeeded' and start_time > now() - interval '15 minutes')
      into v_last_cron, v_cron_failures
    from cron.job_run_details;

    if v_last_cron is null then
      return query select 'scheduler'::text, 'unknown'::text,
        'No scheduler run has ever been recorded.'::text, now();
    elsif v_last_cron < now() - public.ops_threshold('scheduler_max_silence') then
      return query select 'scheduler'::text, 'attention'::text,
        'Last run ' || to_char(v_last_cron, 'YYYY-MM-DD HH24:MI') ||
        ' UTC. The jobs are scheduled every minute.', now();
    elsif coalesce(v_cron_failures, 0) > 0 then
      return query select 'scheduler'::text, 'attention'::text,
        v_cron_failures || ' failed run(s) in the last 15 minutes.', now();
    else
      return query select 'scheduler'::text, 'ok'::text,
        'Last run ' || to_char(v_last_cron, 'HH24:MI:SS') || ' UTC.', now();
    end if;
  end if;

  -- Stripe webhook -----------------------------------------------------
  -- A webhook that stopped arriving looks exactly like a quiet day, which is
  -- why "no events at all" is reported as unknown rather than as fine.
  select max(processed_at), count(*) into v_last_webhook, v_webhooks
  from stripe_webhook_events;

  select count(*) into v_stuck_payments
  from payments p
  where p.status in ('requires_payment_method', 'requires_action')
    and p.created_at < now() - public.ops_threshold('payment_unresolved');

  if v_webhooks = 0 then
    return query select 'stripe_webhook'::text, 'unknown'::text,
      'No Stripe event has ever been recorded. Correct before the first payment, not after.'::text,
      now();
  elsif coalesce(v_stuck_payments, 0) > 0 then
    return query select 'stripe_webhook'::text, 'attention'::text,
      v_stuck_payments || ' payment(s) unresolved past the configured threshold. Last event ' ||
      to_char(v_last_webhook, 'YYYY-MM-DD HH24:MI') || ' UTC.', now();
  else
    return query select 'stripe_webhook'::text, 'ok'::text,
      v_webhooks || ' event(s) processed, last ' || to_char(v_last_webhook, 'YYYY-MM-DD HH24:MI') ||
      ' UTC.', now();
  end if;

  -- Dispatch -----------------------------------------------------------
  select count(*) into v_stuck_dispatch
  from requests r
  where r.status = 'pending'
    and r.created_at < now() - public.ops_threshold('pending_without_match')
    and not exists (
      select 1 from dispatch_offers o
      where o.request_id = r.id and o.status = 'offered' and o.expires_at > now()
    );

  if coalesce(v_stuck_dispatch, 0) > 0 then
    return query select 'dispatch'::text, 'attention'::text,
      v_stuck_dispatch || ' request(s) pending with no live offer.', now();
  else
    return query select 'dispatch'::text, 'ok'::text,
      'No request is waiting without an offer.'::text, now();
  end if;

  -- Realtime -----------------------------------------------------------
  select count(*) into v_realtime
  from pg_publication_tables where pubname = 'supabase_realtime';

  if coalesce(v_realtime, 0) = 0 then
    return query select 'realtime'::text, 'attention'::text,
      'No table is published to supabase_realtime. Tracking and chat will not update live.'::text,
      now();
  else
    return query select 'realtime'::text, 'ok'::text,
      v_realtime || ' table(s) published to supabase_realtime.', now();
  end if;

  -- Finance ------------------------------------------------------------
  select count(*) into v_exceptions from public.ops_reconciliation_exceptions();
  if coalesce(v_exceptions, 0) > 0 then
    return query select 'finance_reconciliation'::text, 'attention'::text,
      v_exceptions || ' reconciliation exception(s).', now();
  else
    return query select 'finance_reconciliation'::text, 'ok'::text,
      'The ledger, the payments and the payouts agree.'::text, now();
  end if;

  -- Administrative access ----------------------------------------------
  select public.ops_super_admin_count() into v_super_admins;
  if coalesce(v_super_admins, 0) = 0 then
    return query select 'admin_access'::text, 'attention'::text,
      'Nobody holds super_admin. Capabilities cannot be granted.'::text, now();
  else
    return query select 'admin_access'::text, 'ok'::text,
      v_super_admins || ' super admin(s).', now();
  end if;
end;
$$;

revoke all on function ops_system_health() from public;
grant execute on function ops_system_health() to authenticated, service_role;

comment on function ops_system_health() is
  'Component health with three states. unknown is deliberate: a signal that could not be read must '
  'never render as a green tick.';

-- ============================================================
-- 12. ALERTS — only what somebody must do something about
-- ============================================================
-- The test for inclusion is a hard one and it is applied here rather than in
-- a dashboard: if the honest response to an alert is "yes, I know", it is not
-- an alert, it is a number, and it belongs on the KPI screen. An alert list
-- that is usually non-empty trains people to ignore it, which costs more than
-- having no alerts at all.
create or replace function ops_alerts()
returns table (
  key text,
  severity text,     -- critical | high | medium
  title text,
  detail text,
  action text
)
language plpgsql
stable
security definer set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and not coalesce(public.has_admin_capability('operations'), false) then
    raise exception 'Not authorized to read alerts' using errcode = '42501';
  end if;

  return query
  select h.component,
         case h.component
           when 'scheduler' then 'critical'
           when 'stripe_webhook' then 'critical'
           when 'dispatch' then 'high'
           when 'finance_reconciliation' then 'high'
           when 'admin_access' then 'critical'
           else 'medium'
         end,
         case h.component
           when 'scheduler' then 'The scheduler is not running'
           when 'stripe_webhook' then 'Stripe events are not being processed'
           when 'dispatch' then 'Requests are waiting with nobody offered'
           when 'realtime' then 'Live updates are not published'
           when 'finance_reconciliation' then 'The money does not reconcile'
           when 'admin_access' then 'Nobody can grant capabilities'
           else h.component
         end,
         h.detail,
         case h.component
           when 'scheduler' then 'Check pg_cron in the Supabase dashboard. Dispatch timeouts and stale-job cleanup are stopped.'
           when 'stripe_webhook' then 'Check the webhook endpoint and its signing secret, then replay the missed events from Stripe.'
           when 'dispatch' then 'Open the dispatch console; check whether any compliant driver is online in the area.'
           when 'realtime' then 'Re-add the tables to the supabase_realtime publication.'
           when 'finance_reconciliation' then 'Open the reconciliation exceptions and resolve each one before the next payout.'
           when 'admin_access' then 'Grant super_admin to a trusted administrator from the database.'
           else 'Investigate.'
         end
  from public.ops_system_health() h
  where h.state = 'attention'

  union all

  -- The pilot being paused is not a fault, but it IS a state somebody must
  -- remember to leave. A pause that is forgotten is an outage nobody reports.
  select 'pilot_paused', 'medium',
         'New requests are being refused',
         coalesce(c.paused_reason, 'No reason recorded.'),
         'Set pilot_config.mode back to pilot or off when the reason no longer holds.'
  from pilot_config c where c.mode = 'paused'

  union all

  -- Somebody who has agreed to take work but cannot be paid is a commitment
  -- we cannot honour. Better found now than after their first job.
  select 'partner_cannot_be_paid', 'high',
         'A pilot partner cannot be paid',
         string_agg(p.company_name, ', '),
         'Finish Stripe Connect onboarding for these companies before they take a job.'
  from public.pilot_partner_readiness() p
  where p.pilot_status in ('ready', 'active') and not p.connect_payouts_enabled
  having count(*) > 0;
end;
$$;

revoke all on function ops_alerts() from public;
grant execute on function ops_alerts() to authenticated, service_role;

-- ============================================================
-- 13. GO / NO-GO — the checklist, evaluated
-- ============================================================
-- Some criteria are computed and some are human judgements recorded in
-- launch_readiness_items. Both appear, and a human judgement that has not
-- been made shows as 'undecided' rather than quietly passing.
create or replace function pilot_go_no_go()
returns table (
  criterion text,
  state text,        -- pass | fail | undecided
  detail text
)
language plpgsql
stable
security definer set search_path = public
as $$
declare
  v_min integer;
  v_ready integer;
  v_alerts integer;
  v_blockers integer;
  v_coverage integer;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and not coalesce(public.has_admin_capability('operations'), false) then
    raise exception 'Not authorized to read the go/no-go checklist' using errcode = '42501';
  end if;

  -- EVERY COLUMN IS QUALIFIED. This function's OUT parameter is named `state`,
  -- and pilot_coverage_areas has a column of the same name; an unqualified
  -- reference resolves to the parameter and fails at runtime, not at creation.
  -- The same shadowing broke safety_link_view() in Phase 9.
  select cfg.min_ready_partners into v_min from pilot_config cfg where cfg.id;
  select count(*) into v_ready from public.pilot_partner_readiness() p
    where p.pilot_status in ('ready', 'active') and cardinality(p.blocking_reasons) = 0;
  select count(*) into v_alerts from public.ops_alerts();
  select count(*) into v_blockers from launch_readiness_items i
    where i.blocker and i.status not in ('ready', 'not_applicable');
  select count(*) into v_coverage from pilot_coverage_areas ca
    where ca.active and ca.state = 'served';

  return query select 'Minimum ready partners'::text,
    case when v_min is null then 'undecided' when v_ready >= v_min then 'pass' else 'fail' end,
    case when v_min is null
      then v_ready || ' partner(s) ready. The minimum has not been decided — pilot_config.min_ready_partners is null.'
      else v_ready || ' of ' || v_min || ' ready.' end;

  return query select 'Declared coverage'::text,
    case when v_coverage > 0 then 'pass' else 'fail' end,
    v_coverage || ' served area(s) declared.';

  return query select 'No open alert'::text,
    case when v_alerts = 0 then 'pass' else 'fail' end,
    v_alerts || ' alert(s) open.';

  return query select 'No outstanding readiness blocker'::text,
    case when v_blockers = 0 then 'pass' else 'fail' end,
    v_blockers || ' blocking item(s) not ready.';

  -- Judgements that are recorded rather than computed. Listed individually so
  -- "who decided this" has an answer.
  return query
  select i.title,
    case i.status
      when 'ready' then 'pass'
      when 'not_applicable' then 'pass'
      when 'blocked' then 'fail'
      else 'undecided'
    end,
    coalesce(i.evidence, i.note, 'No evidence recorded.')
  from launch_readiness_items i
  where i.blocker
  order by i.domain, i.key;
end;
$$;

revoke all on function pilot_go_no_go() from public;
grant execute on function pilot_go_no_go() to authenticated, service_role;

comment on function pilot_go_no_go() is
  'The objective half of the launch decision. A criterion nobody has decided reports undecided, '
  'never pass: an unmade decision must not be able to look like a made one.';

-- ============================================================
-- 14. THRESHOLDS THIS PHASE INTRODUCES
-- ============================================================
insert into ops_thresholds (key, value_seconds, origin, description) values
  ('scheduler_max_silence', 300, 'engineering',
   'How long pg_cron may go without a recorded run before system health calls it out. The jobs are '
   'scheduled every minute, so five minutes is four missed ticks. Engineering default.')
on conflict (key) do nothing;

-- ============================================================
-- 15. THE DECLARED PILOT TERRITORY
-- ============================================================
-- ONE AREA, AND ITS FLAW IS WRITTEN DOWN
-- A circle is not "Montréal & Rive-Sud". It reaches Laval and part of the
-- North Shore, which are NOT in the pilot, and it clips the eastern end of
-- the island, which is. It ships anyway because a coarse shape that is
-- labelled coarse is safer than no shape at all — and the readiness item
-- 'operations.coverage_polygon' below blocks the launch until it is replaced
-- with real boundaries. That is the same discipline as ADR-0002: an
-- approximation may exist, but it may never be presented as a boundary.
insert into pilot_coverage_areas (name, state, kind, center_lat, center_lng, radius_km, note)
values (
  'Montréal & Rive-Sud (approximation pilote)',
  'served',
  'radius',
  45.4900, -73.5500, 30,
  'A 30 km circle centred between downtown Montréal and Longueuil. It is a COMMERCIAL DECLARATION '
  'of where the pilot intends to operate, not a municipal boundary, not a legal service area, and '
  'not evidence that a tow truck is available. It over-reaches into Laval and the North Shore and '
  'must be replaced by real boundaries before the pilot opens to customers who are not on the '
  'allowlist (readiness item operations.coverage_polygon).'
);

-- ============================================================
-- 16. THE READINESS CHECKLIST, SEEDED HONESTLY
-- ============================================================
-- Statuses below are what is true at the end of Phase 10, not what would be
-- convenient. Several blockers are deliberately red: a checklist whose every
-- line is green on the day it is written is a checklist nobody applied.
insert into launch_readiness_items (domain, key, title, status, owner, evidence, blocker, note, last_reviewed_at) values

-- ---- product ----
('product', 'product.customer_flow', 'Customer can request, pay, be matched, tracked and completed',
 'ready', 'Founder / Product',
 'npm run test:finance (125 assertions, real server actions as real users) + Phase 10 manual mobile pass',
 true, null, now()),
('product', 'product.driver_flow', 'Driver can go online, receive an offer, accept, progress and complete',
 'ready', 'Founder / Product',
 'npm run test:operations (40 assertions) + scripts/e2e-driver.ts + Phase 10 manual mobile pass',
 true, null, now()),
('product', 'product.pilot_switch', 'Intake can be paused and resumed without a deploy',
 'ready', 'Founder / Product',
 'npm run test:pilot — pauses the pilot, proves a request is refused, resumes it, proves it is accepted',
 false, null, now()),
('product', 'product.session_survives', 'An active job survives a refresh, a lost network and a reopened tab',
 'ready', 'Founder / Product',
 'Phase 10 manual test 3 and 5; the tracking view reads request state from the server on every load',
 true, null, now()),

-- ---- customer ----
('customer', 'customer.mobile', 'The whole customer path works at 375px',
 'ready', 'Founder / Product',
 'Phase 10 manual test 1, walked at 375x812 on the running app',
 true, null, now()),
('customer', 'customer.errors', 'No raw technical error reaches a customer',
 'ready', 'Founder / Product',
 'src/lib/errors.ts maps every thrown error to a sentence; npm run test asserts the mapping',
 true, null, now()),
('customer', 'customer.location_denied', 'A refused or slow GPS is handled, not fatal',
 'ready', 'Founder / Product',
 'Phase 10 manual test 4; the flow falls back to a typed address',
 true, null, now()),
('customer', 'customer.safety_link', 'A customer can share their rescue with somebody they trust',
 'ready', 'Founder / Product', 'npm run test:safety (39 assertions)', false, null, now()),

-- ---- driver ----
('driver', 'driver.mobile', 'The driver path works one-handed on a phone',
 'ready', 'Founder / Product', 'Phase 10 manual test 2, walked at 375x812', true, null, now()),
('driver', 'driver.compliance_gate', 'A non-compliant driver cannot go online or be dispatched',
 'ready', 'Founder / Product',
 'driver_online_blocked() / driver_dispatch_blocked() (0025); npm run verify:phase6',
 true, null, now()),
('driver', 'driver.failure_states', 'Stale heartbeat, expired offer and lost race are all handled',
 'ready', 'Founder / Product',
 'npm run test:operations; npm run verify:scheduler proves the timeout sweep runs unattended',
 false, null, now()),

-- ---- business ----
('business', 'business.onboarding', 'A towing company can be taken from first contact to ready',
 'ready', 'Founder / Commercial',
 'docs/11-partners/partner-onboarding.md, walked against the real screens in Phase 10',
 true, null, now()),
('business', 'business.pilot_status', 'Commercial pilot status is separate from compliance and availability',
 'ready', 'Founder / Product',
 'companies.pilot_status (0047), write-guarded to operations; npm run test:pilot asserts a company cannot promote itself',
 false, null, now()),
('business', 'business.partner_kit', 'A partner can be handed something that answers their questions',
 'ready', 'Founder / Commercial', 'docs/11-partners/partner-kit.md', false, null, now()),

-- ---- operations ----
('operations', 'operations.command_centre', 'An operator can see what needs them right now',
 'ready', 'Founder / Operations',
 'Phase 8 command centre; npm run verify:operations (27 checks)', true, null, now()),
('operations', 'operations.runbooks', 'Every foreseeable pilot incident has a written response',
 'ready', 'Founder / Operations', 'docs/09-sops/ (4 runbooks) + docs/06-support/pilot-support-runbook.md',
 true, null, now()),
('operations', 'operations.launch_runbook', 'The launch itself has a runbook, including how to stop',
 'ready', 'Founder / Operations', 'docs/09-sops/pilot-launch-runbook.md', true, null, now()),
('operations', 'operations.coverage_polygon', 'Coverage is a real boundary, not a circle',
 'in_progress', 'Founder / Operations', null, true,
 'The declared area is a 30 km circle that over-reaches into Laval and the North Shore. Acceptable while '
 'the allowlist is on and every request is watched; NOT acceptable once anybody can request. Needs '
 'municipal boundaries from an official source, loaded the way the Ontario zones were.',
 now()),
('operations', 'operations.hours', 'Pilot operating hours are decided and configured',
 'not_started', 'Founder / Operations', null, true,
 'pilot_config.hours_start / hours_end are null, which means no restriction is stated. Promising 24/7 '
 'with a handful of partners would be the first promise TowConnect breaks. A decision, not a bug.',
 now()),
('operations', 'operations.min_partners', 'The minimum number of ready partners is decided',
 'not_started', 'Founder / Commercial', null, true,
 'pilot_config.min_ready_partners is null. Deliberately not chosen by engineering: it is a commercial '
 'judgement about how many refusals a first customer may see.', now()),

-- ---- finance ----
('finance', 'finance.sandbox_cycle', 'The full money cycle works end to end in the Stripe sandbox',
 'ready', 'Founder / Finance',
 'npm run test:finance (125 assertions: authorize, capture, supplement, refund, cancellation, payout)',
 true, null, now()),
('finance', 'finance.reconciliation', 'The ledger, the payments and the payouts agree',
 'ready', 'Founder / Finance',
 'npm run verify:finance (16 invariants) + ops_reconciliation_exceptions() live on the finance screen',
 true, null, now()),
('finance', 'finance.commission', 'The TowConnect commission is decided and configured',
 'not_started', 'Founder / Business', null, true,
 'pricing_configured() returns false. No rate has ever been set and none has been suggested by '
 'engineering. Until it is set, no price can be quoted to a customer and no pilot can charge anybody.',
 now()),
('finance', 'finance.payout_execution', 'A partner can actually be paid, not merely credited',
 'blocked', 'Founder / Finance', null, true,
 'The internal payout is prepared and recorded; no Stripe transfer has ever been executed. The Connect '
 'account still owes one identity check (proof of liveness). Until a transfer completes in the sandbox, '
 '"the partner gets paid" is an untested claim.', now()),
('finance', 'finance.stripe_live', 'Stripe is deliberately NOT live',
 'ready', 'Founder / Finance',
 'src/lib/stripe/mode.ts refuses a live key; npm run test asserts it; STRIPE_SECRET_KEY is a test key',
 false, 'Correct state for a closed pilot. Going live is a separate decision with its own checklist '
 '(docs/04-finance/stripe-live-readiness.md).', now()),

-- ---- regulatory ----
('regulatory', 'regulatory.zone_engine', 'Regulated zones are enforced before any commercial preference',
 'ready', 'Founder / Compliance',
 'npm run verify:phase6_1 (32 checks); ADR-0001', true, null, now()),
('regulatory', 'regulatory.zone_geometries', 'No zone is active without a geometry and a source',
 'ready', 'Founder / Compliance',
 'CHECK constraint regulated_zone_active_requires_geometry (0023); every active zone carries source_url',
 true, null, now()),
('regulatory', 'regulatory.operating_authority', 'TowConnect is allowed to operate as an intermediary in Québec',
 'not_started', 'Founder / Legal', null, true,
 'Not verified. Whether a towing intermediary needs a permit, a licence or a registration in Québec has '
 'not been checked with anybody qualified. This is the single largest unknown in the pilot.', now()),

-- ---- security ----
('security', 'security.rls', 'Row-level security is proven, not assumed',
 'ready', 'Founder / Engineering', 'npm run test:integration (213 assertions against the live database, including that a finance-only admin cannot read a driver identity document)',
 true, null, now()),
('security', 'security.capabilities', 'Admin access is scoped by capability, with no grandfather rule',
 'ready', 'Founder / Engineering', '0043 and 0044; npm run verify:operations', true, null, now()),
('security', 'security.secrets', 'No secret is in the repository or its recent history',
 'ready', 'Founder / Engineering', 'npm run verify:phase10 scans the working tree and the last 50 commits',
 true, null, now()),
('security', 'security.service_role', 'The service role never reaches a browser',
 'ready', 'Founder / Engineering',
 'src/lib/supabase/admin.ts imports server-only; npm run verify:phase10 asserts no client file imports it',
 true, null, now()),
('security', 'security.prelaunch_review', 'A pre-launch security review was actually performed',
 'ready', 'Founder / Engineering', 'TOWCONNECT_PHASE10_REPORT.md, security review section', true, null, now()),

-- ---- privacy ----
('privacy', 'privacy.minimisation', 'Each surface carries the least data that makes it work',
 'ready', 'Founder / Engineering',
 'safety_link_view() projects 18 fields; exports enumerate columns by hand; analytics props are whitelisted by a trigger',
 true, null, now()),
('privacy', 'privacy.analytics', 'Analytics cannot accumulate personal data',
 'ready', 'Founder / Engineering',
 'guard_product_event_props() refuses any key off the whitelist; npm run test:pilot proves the refusal',
 false, null, now()),
('privacy', 'privacy.retention', 'How long each kind of record is kept has been decided',
 'not_started', 'Founder / Legal', null, false,
 'No retention period has been agreed. safety_link_lifetime and safety_link_grace are labelled engineering '
 'defaults precisely so they are not mistaken for policy.', now()),
('privacy', 'privacy.policy_published', 'A privacy policy is published and accurate',
 'in_progress', 'Founder / Legal', null, true,
 'docs/13-legal/privacy-policy.md exists and describes what the system actually does, but is marked '
 'DRAFT - LEGAL REVIEW REQUIRED and has not been reviewed by anybody qualified.', now()),

-- ---- monitoring ----
('monitoring', 'monitoring.health', 'Somebody can see whether the platform is working',
 'ready', 'Founder / Engineering',
 'ops_system_health() and the /dashboard/admin/operations/health screen', true, null, now()),
('monitoring', 'monitoring.alerts', 'Only actionable conditions raise an alert',
 'ready', 'Founder / Engineering', 'ops_alerts(); six conditions, each with a stated action', true, null, now()),
('monitoring', 'monitoring.delivery', 'An alert reaches a human who is not looking at the screen',
 'not_started', 'Founder / Operations', null, false,
 'Alerts are visible on the operations screen and nowhere else. No email, SMS or pager delivery exists. '
 'Acceptable for a pilot where the founder is watching; not acceptable beyond it.', now()),
('monitoring', 'monitoring.error_tracking', 'Server errors are captured somewhere durable',
 'not_started', 'Founder / Engineering', null, false,
 'Errors go to the platform logs only. No error tracker is wired up.', now()),

-- ---- support ----
('support', 'support.playbook', 'Support has a written answer for the cases that will actually happen',
 'ready', 'Founder / Support', 'docs/06-support/support-playbook.md and docs/06-support/pilot-support-runbook.md',
 true, null, now()),
('support', 'support.escalation', 'Every support case says who looks, with what data, and when to escalate',
 'ready', 'Founder / Support', 'docs/06-support/pilot-support-runbook.md, escalation table', true, null, now()),
('support', 'support.channel', 'A customer in trouble can reach a human',
 'not_started', 'Founder / Support', null, true,
 'No support telephone number or monitored inbox has been published. The Contact page cannot be honest '
 'until one exists, and a roadside pilot without a reachable human is not a pilot.', now()),

-- ---- data ----
('data', 'data.dictionary', 'Every term means one thing',
 'ready', 'Founder / Engineering', 'docs/05-data/data-dictionary.md; npm run verify:phase9 checks it against the schema',
 false, null, now()),
('data', 'data.kpis', 'Every KPI has exactly one definition',
 'ready', 'Founder / Engineering', 'ops_kpis() is the single definition; npm run verify:phase9 fails on a second one',
 true, null, now()),
('data', 'data.funnel', 'The acquisition funnel is instrumented',
 'ready', 'Founder / Product', 'funnel_summary(); npm run test:pilot records a real funnel and reads it back',
 false, null, now()),
('data', 'data.review_pack', 'The pilot can be reviewed from data rather than from memory',
 'ready', 'Founder / Product', 'docs/05-data/pilot-review-pack.md, built from the Phase 9 exports', false, null, now()),

-- ---- legal ----
('legal', 'legal.terms', 'Terms of service are published and reviewed',
 'in_progress', 'Founder / Legal', null, true,
 'docs/13-legal/terms-of-service.md is a DRAFT - LEGAL REVIEW REQUIRED. It describes the real system, '
 'which is the useful half; it has no legal force until somebody qualified has read it.', now()),
('legal', 'legal.partner_terms', 'Partner terms are published and reviewed',
 'in_progress', 'Founder / Legal', null, true,
 'docs/13-legal/partner-terms.md is a DRAFT - LEGAL REVIEW REQUIRED. It cannot be final while the '
 'commission is undecided.', now()),
('legal', 'legal.insurance', 'Insurance responsibilities are established',
 'not_started', 'Founder / Legal', null, true,
 'Who is liable for damage during a tow arranged through TowConnect has not been established with an '
 'insurer or a lawyer. Partner terms currently state that the towing company carries its own cover, '
 'which is a description of the intended arrangement, not a verified one.', now()),

-- ---- commercial ----
('commercial', 'commercial.plan', 'There is a concrete 30-day plan to find the first partners',
 'ready', 'Founder / Commercial', 'docs/12-commercial/30-day-pilot-plan.md', false, null, now()),
('commercial', 'commercial.scripts', 'There is something to say on the phone and at the counter',
 'ready', 'Founder / Commercial', 'docs/12-commercial/sales-scripts.md', false, null, now()),
('commercial', 'commercial.attribution', 'Where a request came from can be measured',
 'ready', 'Founder / Product', 'partner_links + requests.attribution_code; npm run test:pilot', false, null, now()),
('commercial', 'commercial.first_partners', 'At least one real towing partner is ready',
 'not_started', 'Founder / Commercial', null, true,
 'No real towing company has been onboarded. The only company in the database is the Phase 8.1 Connect '
 'test fixture. Supply first: there is nothing to launch to customers until this is non-zero.', now()),

-- ---- found by the Launch Blocker Sprint ----
('data', 'data.test_suite_stability', 'The launch battery does not raise false alarms',
 'in_progress', 'Founder / Engineering', null, false,
 'One assertion in test:integration - "a driver coming online later is picked up on the next nudge" - '
 'failed once in two consecutive runs and passed on the other, with no code change between them. The '
 'suite runs for minutes against the live project while two pg_cron sweepers run every minute: '
 'cleanup_stale expires a pending request after 10 minutes and takes a driver offline after 3 minutes '
 'without a heartbeat. A long section racing those sweepers is the likely cause. It matters because the '
 'launch runbook tells somebody to run this battery at T-24h, and a red line that is really a race will '
 'either be ignored or stop a launch for nothing.', now()),

-- ---- found by the Launch Blocker Sprint, auditing the account lifecycle ----
('customer', 'customer.password_recovery', 'A customer who forgets their password can get back in',
 'not_started', 'Founder / Product', null, true,
 'There is no password-reset flow in the product: no link on the login screen, no call to '
 'resetPasswordForEmail anywhere in src/, and no page to set a new one. Supabase can produce a valid '
 'recovery link and returns it only to an allow-listed origin (npm run test:auth proves both), so the '
 'platform side works and nothing in the product reaches it. Depends on the same SMTP provider as '
 'signup confirmation: a recovery email nobody receives is not recovery.', now()),

-- ---- found during the Phase 10 walkthrough, not before it ----
-- Both of these exist because somebody actually tried the thing rather than
-- reading the code that implements it.
('product', 'product.signup_email', 'A first customer can confirm their email and sign in',
 'blocked', 'Founder / Engineering', null, true,
 'Reproduced and named by npm run test:auth, which fails on exactly this. Root cause, in Supabase''s own '
 'words: the project is on the free tier with the default email provider, so rate_limit_email_sent is 2 '
 'messages per hour for the WHOLE project, and the Management API refuses template changes with "Email '
 'template modification is not available for free tier projects using the default email provider". Two '
 'customers per hour is not a pilot. REMAINING HUMAN ACTION: create an account with a transactional email '
 'provider (Resend, Brevo and Postmark all have free tiers), verify a sending domain, enter the SMTP '
 'settings under Authentication > Emails, raise rate_limit_email_sent, then apply '
 'supabase/auth-templates/templates.ts. Everything after delivery is already proven.', now()),
('security', 'security.analytics_rate_limit', 'The analytics endpoint is rate-limited per source',
 'not_started', 'Founder / Engineering', null, false,
 'record_product_event() is reachable without a session because a landing view happens before anybody '
 'signs in. Bounded by a fixed enum, a property whitelist and 300 events per browser per hour, but not '
 'limited per IP address. Accepted for a closed pilot; add before the allowlist comes off.', now()),
('security', 'security.document_scoping', 'Identity documents are readable only by operations',
 'ready', 'Founder / Engineering',
 '0048 scopes driver_documents and the driver-documents storage bucket to '
 'has_admin_capability(''operations''); docs/08-security/prelaunch-security-review.md, finding 1',
 true, null, now()),
('finance', 'finance.webhook_secret_parity',
 'The webhook endpoint''s signing secret is correct wherever it is used',
 'ready', 'Founder / Engineering',
 'npm run test:finance — the deployed endpoint refuses an unsigned request and a forged one, Stripe '
 'reports zero events pending delivery over 24h (which only happens when the deployment holds the '
 'endpoint''s own secret), exactly one enabled endpoint exists and points at the deployment under test, '
 'and the handler refuses to run at all with no secret configured.',
 true,
 'Reframed rather than patched. Stripe never returns an endpoint secret after creation, so local and '
 'deployment cannot be reconciled by any script. The signed replay now runs against the route handler '
 'in-process, where signing and verification share one secret; the deployment is tested without needing '
 'any secret at all. The local STRIPE_WEBHOOK_SECRET deliberately no longer participates.', now())

on conflict (key) do nothing;
