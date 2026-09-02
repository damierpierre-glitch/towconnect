-- TowConnect — Phase 6, Part A: the regulated / exclusive towing zone engine.
-- Additive, run after 0001-0022. Touches no existing dispatch function; the
-- dispatch integration itself lands in 0025 so this file can be reviewed as
-- "the facts and the detection", separately from "what dispatch does about
-- them".
--
-- WHY THIS LIVES IN THE DATABASE
-- A regulated zone is a legal fact with an effective date, a source, and a
-- verification date. It changes when a government changes it, not when
-- TowConnect ships. Encoding it in React would mean a redeploy every time a
-- ministry moves a boundary or a contract is reassigned, and it would put a
-- legal restriction somewhere a client can trivially bypass. So the rule
-- lives here, the client only renders what the database says, and dispatch
-- (0025) is filtered by the database, not by the UI.
--
-- THE HARD RULE THIS FILE EXISTS TO ENFORCE
--   regulation > safety > service/equipment fit > availability > ETA >
--   TowConnect commercial preference
-- A commercial preference must never route around a legal restriction. The
-- structural expression of that here is that regulated_towing_zones has no
-- notion of a commercial partner at all: authorization is its own table with
-- its own source and its own verification date, and 0025 filters on it
-- before any scoring happens.

-- ============================================================
-- ENUMS
-- ============================================================

-- What kind of restriction applies. Deliberately not Québec-shaped: the
-- point of this phase is that a second and third province can be added as
-- rows, not as code.
create type zone_restriction_type as enum (
  'exclusive_operator',      -- one designated operator holds the territory
  'authorized_list',         -- a defined list of permitted operators
  'permit_required',         -- any operator may work it, with a permit
  'municipal_restriction',   -- a municipal by-law restricts towing
  'other'
);

-- What TowConnect is allowed to DO when a request falls in the zone.
create type zone_dispatch_mode as enum (
  -- Only companies with an 'authorized' row in regulated_zone_providers may
  -- be offered the job. Everyone else is excluded before scoring.
  'authorized_provider_only',
  -- TowConnect must not dispatch at all: the jurisdiction requires the
  -- motorist to go through a public authority (911, 511, a provincial line).
  -- The app's job is to say so clearly and get out of the way.
  'external_authority_required',
  -- Show the official instruction, take no automated action. The fallback
  -- for a rule we can state accurately but cannot yet act on.
  'manual_instruction_only',
  -- Dispatch is limited to a defined network but the jurisdiction permits a
  -- documented fallback outside it. Modelled now, no zone uses it yet.
  'restricted_network'
);

-- How much we actually trust the polygon. This is the anti-false-precision
-- control: a zone whose official boundary exists only as prose or a picture
-- must never quietly become an "exact" polygon that refuses service to real
-- people standing outside it.
create type zone_geometry_confidence as enum (
  'official_geospatial',            -- from an official geospatial dataset
  'derived_from_official_text',     -- built from an official written/segment description
  'approximate_pending_validation', -- coarse; must be reviewed before it can gate service
  'none'                            -- no geometry at all
);

create type zone_authorization_status as enum (
  'authorized',
  'suspended',
  'revoked',
  'pending_verification'
);

-- Where a request stands with respect to a regulated zone. Kept as its own
-- column rather than new request_status values on purpose: request_status
-- drives the accept/en_route/arrived/completed machine, its guards, its
-- unique indexes and the whole client tracker. Adding regulatory states to
-- it would put legal detection and job progress in one enum, and every
-- existing guard would have to be re-reasoned about. This is additive and
-- orthogonal.
create type regulated_dispatch_state as enum (
  'not_applicable',              -- no active zone covers the pickup point
  'awaiting_external_authority', -- the motorist must call 911/511; we do not dispatch
  'authorized_provider_search',  -- searching, restricted to authorized providers
  'restricted_capacity_wait',    -- authorized providers exist but none is available right now
  'manual_instruction'           -- instruction shown, no automated dispatch
);

-- ============================================================
-- REGULATED_TOWING_ZONES
-- ============================================================
create table regulated_towing_zones (
  id uuid primary key default gen_random_uuid(),
  country text not null default 'CA',
  province text not null,
  -- The body that actually makes the rule, spelled out rather than coded:
  -- this string ends up in front of a customer and in an audit log.
  jurisdiction text not null,
  official_name text not null,
  -- Whatever the jurisdiction itself calls the zone ('3C', 'Zone 1A', ...).
  zone_code text,

  restriction_type zone_restriction_type not null,
  dispatch_mode zone_dispatch_mode not null,

  -- MultiPolygon rather than Polygon: a real towing territory is frequently
  -- several disjoint highway corridors, not one blob.
  geometry geography(MultiPolygon, 4326),
  geometry_confidence zone_geometry_confidence not null default 'none',
  geometry_note text,

  -- Provenance is mandatory. A rule with no source is not a rule we are
  -- willing to refuse someone service over.
  source_url text not null,
  source_title text not null,
  effective_from date not null,
  effective_to date,
  last_verified_at timestamptz not null default now(),

  active boolean not null default false,

  -- Shown verbatim to the motorist. Both languages required, because a
  -- half-translated legal instruction is worse than none.
  user_instruction_fr text not null,
  user_instruction_en text not null,
  -- The number the official procedure says to call, when there is one.
  authority_phone text,

  -- Lower wins when two zones overlap. Overlap is expected (a municipal
  -- restriction inside a provincial corridor); this decides which rule the
  -- motorist is told about.
  precedence integer not null default 100,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- THE GUARD THAT MAKES "no fabricated data" structural rather than a
  -- promise: a zone cannot be switched on until it has a geometry AND that
  -- geometry has a stated provenance. Both of the seeded zones below fail
  -- this check today, which is exactly why they ship inactive.
  constraint regulated_zone_active_requires_geometry check (
    not active or (geometry is not null and geometry_confidence <> 'none')
  ),
  constraint regulated_zone_effective_range check (
    effective_to is null or effective_to >= effective_from
  )
);

create index regulated_towing_zones_geom_idx
  on regulated_towing_zones using gist (geometry);
create index regulated_towing_zones_lookup_idx
  on regulated_towing_zones (active, province, precedence);

create trigger regulated_towing_zones_set_updated_at
  before update on regulated_towing_zones
  for each row execute procedure extensions.moddatetime(updated_at);

alter table regulated_towing_zones enable row level security;

-- A regulated zone is published law. Any signed-in user may read the active
-- ones, because the client has to be able to render the instruction for the
-- zone it is standing in. Inactive/draft zones are admin-only: a half-built
-- zone must not leak into a customer's screen as if it were in force.
create policy "regulated zones: signed-in users read active zones" on regulated_towing_zones
  for select using (active = true);

create policy "regulated zones: admins full access" on regulated_towing_zones
  for all using (public.is_admin()) with check (public.is_admin());

-- ============================================================
-- REGULATED_ZONE_PROVIDERS — who is legally allowed to work a zone.
--
-- This is NOT a commercial preference list and must never be used as one.
-- Commercial preference is a separate, lower-priority concept (0025).
-- ============================================================
create table regulated_zone_providers (
  id uuid primary key default gen_random_uuid(),
  zone_id uuid not null references regulated_towing_zones(id) on delete cascade,

  -- Nullable on purpose. An official source names an operator whether or not
  -- that operator has ever heard of TowConnect. Recording the name with a
  -- null company_id keeps the official fact intact without inventing a
  -- TowConnect account to hang it on — and makes "authorized operators we
  -- have not onboarded" a queryable business list rather than a gap.
  company_id uuid references companies(id) on delete set null,
  official_operator_name text not null,

  authorization_status zone_authorization_status not null default 'pending_verification',
  valid_from date,
  valid_to date,

  -- Ordering *within* the set of legally authorized providers. Never a way
  -- to become authorized.
  priority integer not null default 100,

  source_url text,
  source_title text,
  last_verified_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint regulated_zone_provider_valid_range check (
    valid_to is null or valid_from is null or valid_to >= valid_from
  )
);

create index regulated_zone_providers_zone_idx on regulated_zone_providers(zone_id);
create index regulated_zone_providers_company_idx on regulated_zone_providers(company_id);

-- One live authorization per company per zone. Historical rows (revoked,
-- suspended, expired) are untouched — this only stops two simultaneous
-- 'authorized' records for the same pair.
create unique index regulated_zone_providers_one_active_per_company
  on regulated_zone_providers (zone_id, company_id)
  where company_id is not null and authorization_status = 'authorized';

create trigger regulated_zone_providers_set_updated_at
  before update on regulated_zone_providers
  for each row execute procedure extensions.moddatetime(updated_at);

alter table regulated_zone_providers enable row level security;

create policy "zone providers: admins full access" on regulated_zone_providers
  for all using (public.is_admin()) with check (public.is_admin());

-- A company may see its own authorizations (it needs to know where it is
-- allowed to work) but never another company's. company_members lands in
-- 0024; until then this policy resolves through companies.owner_id only,
-- and 0024 widens it.
create policy "zone providers: company reads own" on regulated_zone_providers
  for select using (
    company_id is not null
    and exists (
      select 1 from companies c
      where c.id = regulated_zone_providers.company_id and c.owner_id = auth.uid()
    )
  );

-- ============================================================
-- AUDIT TRAIL
--
-- The brief's requirement is that an admin must not be able to erase a
-- zone's source history without a trace. The trail is written by a SECURITY
-- DEFINER trigger and has no INSERT/UPDATE/DELETE policy for anyone —
-- including admins. An admin can delete a zone; they cannot delete the
-- record that they deleted it, or what its source said at the time.
-- ============================================================
create table regulated_zone_audit (
  id bigserial primary key,
  table_name text not null,
  row_id uuid not null,
  action text not null check (action in ('insert', 'update', 'delete')),
  actor_id uuid,
  actor_role text,
  old_row jsonb,
  new_row jsonb,
  created_at timestamptz not null default now()
);

create index regulated_zone_audit_row_idx on regulated_zone_audit(table_name, row_id, created_at desc);

alter table regulated_zone_audit enable row level security;

create policy "zone audit: admins read" on regulated_zone_audit
  for select using (public.is_admin());

create or replace function log_regulated_zone_change()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_old jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  v_new jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  v_id uuid := case when tg_op = 'DELETE' then old.id else new.id end;
begin
  -- geometry is a geography column; to_jsonb() renders it as an opaque hex
  -- string that bloats the log without being readable. Swap it for a
  -- compact, human-checkable summary instead.
  if v_old ? 'geometry' then
    v_old := jsonb_set(v_old, '{geometry}',
      to_jsonb(case when old.geometry is null then null else ST_AsText(ST_Envelope(old.geometry::geometry)) end));
  end if;
  if v_new ? 'geometry' then
    v_new := jsonb_set(v_new, '{geometry}',
      to_jsonb(case when new.geometry is null then null else ST_AsText(ST_Envelope(new.geometry::geometry)) end));
  end if;

  insert into regulated_zone_audit (table_name, row_id, action, actor_id, actor_role, old_row, new_row)
  values (tg_table_name, v_id, lower(tg_op), auth.uid(), auth.role(), v_old, v_new);

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger regulated_towing_zones_audit
  after insert or update or delete on regulated_towing_zones
  for each row execute procedure log_regulated_zone_change();

create trigger regulated_zone_providers_audit
  after insert or update or delete on regulated_zone_providers
  for each row execute procedure log_regulated_zone_change();

-- ============================================================
-- DETECTION
-- ============================================================

-- "Is this rule in force today?" — separate from `active`, which is the
-- operator switch. A zone can be active and not yet effective, or active
-- and expired; neither should gate a customer today.
create or replace function regulated_zone_in_force(z regulated_towing_zones)
returns boolean
language sql
stable
as $$
  select z.active
     and z.geometry is not null
     and z.effective_from <= current_date
     and (z.effective_to is null or z.effective_to >= current_date)
$$;

-- The single point of truth for "which rule applies here". Returns at most
-- one zone: lowest precedence wins, then the smaller (more specific) area,
-- so a municipal carve-out inside a provincial corridor is what the motorist
-- is told about.
--
-- SECURITY DEFINER so that dispatch and the request trigger get the same
-- answer regardless of who is asking. It only ever returns published,
-- active, in-force zones, which the RLS policy above already exposes to
-- every signed-in user, so this grants no extra visibility.
create or replace function regulated_zone_for_point(
  p_lat double precision,
  p_lng double precision
)
returns regulated_towing_zones
language sql
stable
security definer set search_path = public
as $$
  select z.*
  from regulated_towing_zones z
  where regulated_zone_in_force(z)
    and ST_Intersects(z.geometry, ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography)
  order by z.precedence asc, ST_Area(z.geometry) asc
  limit 1
$$;

revoke all on function regulated_zone_for_point(double precision, double precision) from public;
grant execute on function regulated_zone_for_point(double precision, double precision)
  to authenticated, service_role;

-- Is this company legally allowed to work this zone right now?
create or replace function company_authorized_for_zone(p_company_id uuid, p_zone_id uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1
    from regulated_zone_providers p
    where p.zone_id = p_zone_id
      and p.company_id = p_company_id
      and p.authorization_status = 'authorized'
      and (p.valid_from is null or p.valid_from <= current_date)
      and (p.valid_to is null or p.valid_to >= current_date)
  )
$$;

revoke all on function company_authorized_for_zone(uuid, uuid) from public;
grant execute on function company_authorized_for_zone(uuid, uuid) to authenticated, service_role;

-- ============================================================
-- REQUESTS — the detected zone is stamped on the request at creation.
--
-- Snapshotted, not looked up live, for the same reason vehicle_desc and
-- price_estimate are snapshotted: what rule applied to this job is a fact
-- about that moment. A boundary edited next month must not silently rewrite
-- what happened last week.
-- ============================================================
alter table requests
  add column regulated_zone_id uuid references regulated_towing_zones(id) on delete set null,
  add column regulated_zone_mode zone_dispatch_mode,
  add column regulated_dispatch_state regulated_dispatch_state not null default 'not_applicable',
  add column regulated_zone_checked_at timestamptz;

create index requests_regulated_zone_idx on requests(regulated_zone_id)
  where regulated_zone_id is not null;

-- BEFORE INSERT, so the value can never be client-supplied: whatever a
-- client puts in these columns is overwritten by what PostGIS actually says
-- about the coordinates.
create or replace function stamp_regulated_zone()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_zone regulated_towing_zones;
begin
  v_zone := regulated_zone_for_point(new.lat, new.lng);
  new.regulated_zone_checked_at := now();

  if v_zone.id is null then
    new.regulated_zone_id := null;
    new.regulated_zone_mode := null;
    new.regulated_dispatch_state := 'not_applicable';
    return new;
  end if;

  new.regulated_zone_id := v_zone.id;
  new.regulated_zone_mode := v_zone.dispatch_mode;
  new.regulated_dispatch_state := case v_zone.dispatch_mode
    when 'external_authority_required' then 'awaiting_external_authority'
    when 'manual_instruction_only' then 'manual_instruction'
    else 'authorized_provider_search'
  end::regulated_dispatch_state;

  return new;
end;
$$;

create trigger requests_stamp_regulated_zone
  before insert on requests
  for each row execute procedure stamp_regulated_zone();

-- Extend the 0014 lockdown: a driver's own session may still only ever
-- change `status`. The regulatory columns are as off-limits as price is —
-- more so, since being able to clear regulated_zone_id from a driver session
-- would be a way to make a legal restriction disappear.
create or replace function guard_request_protected_fields()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
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
       -- Added in 0023.
       or new.regulated_zone_id is distinct from old.regulated_zone_id
       or new.regulated_zone_mode is distinct from old.regulated_zone_mode
       or new.regulated_dispatch_state is distinct from old.regulated_dispatch_state
       or new.regulated_zone_checked_at is distinct from old.regulated_zone_checked_at
    then
      raise exception 'A driver may only update a request''s status' using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

-- ============================================================
-- SEED — the two jurisdictions named in the brief.
--
-- READ THIS BEFORE ACTIVATING ANYTHING BELOW.
--
-- Both rows ship with geometry = NULL, geometry_confidence = 'none' and
-- active = false, and the CHECK constraint above makes it impossible to
-- activate them until someone attaches a real boundary. That is not an
-- oversight, it is the finding:
--
--   * Québec — quebec.ca describes the exclusive-towing territory in prose
--     ("the island of Montréal, the island of Laval, sections of the North
--     and South shores, bridges under provincial jurisdiction") and links a
--     picture of a map. It publishes no geospatial boundary. Données Québec
--     has no layer for it.
--   * Ontario — ontario.ca defines all 15 zones as highway segments between
--     named cross-roads ("Highway 401 from Highway 400 to Highway 404") and
--     points at the Ontario 511 interactive map. Ontario GeoHub publishes no
--     tow-zone layer, and the Ontario 511 open API (which does serve events,
--     cameras, construction and truck restrictions) has no tow-zone
--     endpoint — probed directly, 404.
--
-- Turning either description into a polygon by hand would produce a boundary
-- that looks authoritative and is not, and every false positive refuses a
-- stranded motorist the service they came for. The metadata, the instruction
-- text and the machinery are real; the boundary is the one thing missing,
-- and it is missing visibly.
-- ============================================================

insert into regulated_towing_zones (
  province, jurisdiction, official_name, zone_code,
  restriction_type, dispatch_mode,
  geometry, geometry_confidence, geometry_note,
  source_url, source_title,
  effective_from, last_verified_at, active,
  user_instruction_fr, user_instruction_en, authority_phone, precedence
) values (
  'QC',
  'Ministère des Transports et de la Mobilité durable du Québec',
  'Remorquage exclusif — région métropolitaine de Montréal',
  null,
  'exclusive_operator',
  -- The province requires the motorist to go through 911; TowConnect
  -- dispatching its own truck there would be telling someone to break the
  -- rule they are standing in.
  'external_authority_required',
  null,
  'none',
  'Officially described in prose only: "the island of Montréal", "the island of Laval", '
    || '"sections of the North and South shores of Montréal", "bridges under provincial jurisdiction '
    || 'in the Montréal metropolitan area", covering expressways within that territory. quebec.ca links '
    || 'an image map but publishes no geospatial boundary, and Données Québec has no corresponding layer. '
    || 'Approximating it with the island outlines would wrongly capture every residential street in '
    || 'Montréal, which is the opposite of the truth: the restriction applies to the expressway network.',
  'https://www.quebec.ca/en/transports/traffic-road-safety/road-network/exclusive-towing-metropolitan-montreal',
  'Exclusive towing in metropolitan Montréal — Gouvernement du Québec',
  -- The procedure below (911) is the one that took effect on this date; the
  -- exclusive-towing regime itself is older.
  '2026-06-01',
  now(),
  false,
  'Vous êtes dans une zone de remorquage exclusif. La réglementation du Québec exige que vous '
    || 'composiez le 911 : le remorqueur désigné pour ce secteur sera dépêché. Vous devez utiliser ce '
    || 'service — TowConnect ne peut pas envoyer un remorqueur ici. Vous pourrez choisir le remorqueur '
    || 'de votre choix dès que votre véhicule aura quitté la zone.',
  'You are in an exclusive towing zone. Québec regulations require you to call 911: the tow operator '
    || 'designated for this area will be dispatched. You are required to use that service — TowConnect '
    || 'cannot send a truck here. You may choose your own tow operator as soon as your vehicle has left '
    || 'the zone.',
  '911',
  10
);

insert into regulated_towing_zones (
  province, jurisdiction, official_name, zone_code,
  restriction_type, dispatch_mode,
  geometry, geometry_confidence, geometry_note,
  source_url, source_title,
  effective_from, last_verified_at, active,
  user_instruction_fr, user_instruction_en, authority_phone, precedence
) values (
  'ON',
  'Ontario Ministry of Transportation',
  'Restricted Towing Zones — Tow Zone Program (GTHA)',
  null,
  'exclusive_operator',
  -- Ontario also routes the motorist through a public line (511) rather than
  -- letting them pick an operator, so the same mode applies. The per-zone
  -- authorized operators are recorded below regardless, because that is the
  -- official fact and because it is what an 'authorized_provider_only' mode
  -- would need the day a zone is split out with its own geometry.
  'external_authority_required',
  null,
  'none',
  'Ontario publishes all 15 zones as highway segments between named cross-roads '
    || '(e.g. "Highway 401 from Highway 400 to Highway 404") and directs motorists to the Ontario 511 '
    || 'interactive map. No tow-zone layer is published on Ontario GeoHub, and the Ontario 511 open API '
    || '(which does serve events, cameras, construction and truck restrictions) returns 404 for tow-zone '
    || 'endpoints — probed directly on 2026-09-01. Each zone needs its own row and its own buffered '
    || 'centreline geometry before it can gate service; this row carries the programme-level rule and '
    || 'the authorized-operator list until then.',
  'https://www.ontario.ca/page/tow-zone-program',
  'Tow Zone Program — Government of Ontario',
  '2021-03-02',
  now(),
  false,
  'Vous êtes dans une zone de remorquage restreint de l''Ontario. Seule l''entreprise autorisée pour '
    || 'ce secteur peut remorquer votre véhicule. Composez le 911 s''il s''agit d''une urgence ou si vous '
    || 'ne pouvez pas déplacer votre véhicule hors des voies de circulation; sinon composez le 511 et '
    || 'choisissez l''option du programme de zones de remorquage. TowConnect ne peut pas envoyer un '
    || 'remorqueur ici.',
  'You are in an Ontario restricted towing zone. Only the company authorized for this zone may tow your '
    || 'vehicle. Call 911 if this is an emergency or you cannot move your vehicle out of a travelled '
    || 'lane; otherwise call 511 and select the Tow Zone Program option. TowConnect cannot send a truck '
    || 'here.',
  '511',
  10
);

-- The 15 Ontario zones and their contracted operators, exactly as published
-- on ontario.ca/page/tow-zone-program. Recorded with company_id = null
-- because none of them is a TowConnect company: these are the official
-- facts, not a partner list. authorization_status is 'authorized' because
-- the ministry publishes them as the contracted providers; last_verified_at
-- is the date that page was read.
insert into regulated_zone_providers (
  zone_id, company_id, official_operator_name, authorization_status,
  source_url, source_title, last_verified_at, priority
)
select
  z.id, null, v.operator, 'authorized',
  'https://www.ontario.ca/page/tow-zone-program',
  'Tow Zone Program — Government of Ontario, restricted towing zones table (zone ' || v.zone_code || ')',
  now(),
  100
from regulated_towing_zones z
cross join (values
  ('1A', 'Abrams Towing'),
  ('1B', 'Bob''s Towing'),
  ('1C', 'William''s Towing Service'),
  ('1D', 'Classic Towing & Storage Service'),
  ('2A', 'A.Z. Towing'),
  ('2B', 'C.A. Towing'),
  ('2C', 'COMTOW'),
  ('2D', 'Lyon''s Towing'),
  ('3A', 'Fellow''s Towing'),
  ('3B', 'Pacific Towing and Recovery'),
  ('3C', 'Bill & Son Towing'),
  ('3D', 'JP Towing Service & Storage Ltd.'),
  ('4A', 'ABC Towing'),
  ('4B', 'JKM Towing Inc.'),
  ('4C', 'A Action Towing and Recovery Inc.')
) as v(zone_code, operator)
where z.province = 'ON' and z.official_name = 'Restricted Towing Zones — Tow Zone Program (GTHA)';

comment on table regulated_towing_zones is
  'Regulated / exclusive towing territories. A row may only be activated once it has a real geometry '
  '(enforced by regulated_zone_active_requires_geometry) — see the seed notes in 0023 for why both '
  'seeded zones ship inactive.';
comment on table regulated_zone_providers is
  'Who is LEGALLY authorized to work a zone. Never a commercial preference list — commercial '
  'preference is a separate, strictly lower-priority concept (see 0025).';
