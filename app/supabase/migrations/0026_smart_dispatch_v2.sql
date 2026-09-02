-- TowConnect — Phase 6, Part C: Smart Dispatch V2. Additive, run after 0025.
--
-- THE ORDER OF PRIORITIES, WRITTEN AS CODE
--   1. regulation        — a zone's rule decides whether we may dispatch at all,
--                          and if so to whom. Evaluated first, as a hard filter.
--   2. safety/compliance — a driver whose mandatory documents are not in good
--                          standing is not offered work. Hard filter.
--   3. service fit       — equipment that cannot do the job is excluded, but
--                          only on real evidence. Hard filter, see below.
--   4. availability      — approved, online, fresh heartbeat, not mid-job.
--   5. ETA / proximity   — the dominant term in the score.
--   6. commercial        — a preferred partner gets a short head start and
--                          nothing more. It is the LAST thing consulted, it
--                          cannot resurrect a candidate excluded by 1-4, and
--                          it is off by default.
--
-- Everything above the score is a filter; the score only ever ranks
-- candidates that already passed every filter. That is the structural reason
-- a commercial preference cannot route around a legal restriction: by the
-- time preference is consulted, the illegal candidates are already gone.
--
-- WHAT CHANGED FROM V1 (0006 / 0007 / 0017)
--   * regulated zones are honoured (they did not exist);
--   * declared equipment/service capability is honoured (0018 collected it
--     and explicitly did not use it);
--   * document compliance is honoured (0019 collected it and did not use it);
--   * business service areas are honoured (did not exist);
--   * a driver with no completed jobs is no longer handed a free 5.0.
--   * the matching decision is explainable: one function produces the
--     candidate list with a reason per driver, and both dispatch and the
--     admin explain view read it, so what admins see is what dispatch did.

-- ============================================================
-- SERVICE TYPE REQUIREMENTS — configurable, not hard-coded.
-- ============================================================
create table service_type_requirements (
  problem_type text primary key,
  -- At least one of these satisfies the job. Empty = no equipment
  -- requirement, which means nobody is excluded for equipment.
  any_of_capabilities service_capability[] not null default '{}',
  -- Every one of these must be present. Reserved for jobs that genuinely
  -- need a combination; empty for all of the seeded types.
  all_of_capabilities service_capability[] not null default '{}',
  active boolean not null default true,
  notes text,
  updated_at timestamptz not null default now()
);

create trigger service_type_requirements_set_updated_at
  before update on service_type_requirements
  for each row execute procedure extensions.moddatetime(updated_at);

alter table service_type_requirements enable row level security;

create policy "service requirements: signed-in users read active" on service_type_requirements
  for select using (active = true);
create policy "service requirements: admins full access" on service_type_requirements
  for all using (public.is_admin()) with check (public.is_admin());

-- Seeded from PROBLEM_TYPES in src/lib/constants.ts. These are physical
-- facts about the work (a dead battery needs a booster, a locked car needs
-- lockout tools), not business policy — and they stay editable without a
-- deploy.
insert into service_type_requirements (problem_type, any_of_capabilities, notes) values
  ('battery',     '{boost}',                          'Boost pack or jump start.'),
  ('out_of_gas',  '{fuel_delivery}',                  'Fuel delivery to the roadside.'),
  ('lockout',     '{lockout}',                        'Lockout tooling.'),
  ('flat_tire',   '{tire_change}',                    'Tire change on site.'),
  ('stuck_snow',  '{winch,recovery}',                 'Winch-out or recovery.'),
  ('mechanical',  '{flatbed,wheel_lift}',             'Vehicle is not driveable and must be towed.'),
  ('accident',    '{flatbed,heavy_duty,recovery}',    'Damaged vehicle: deck, heavy unit or recovery gear.'),
  ('other',       '{}',                               'Unspecified: no equipment requirement, nobody excluded.');

-- ============================================================
-- SERVICE COMPATIBILITY — and the evidence it is based on.
--
-- Four answers, and the difference between two of them is the whole point:
--   'compatible'   — the driver can do this job.
--   'incompatible' — we have REAL evidence they cannot. Excluded.
--   'unknown'      — nothing declared. NOT excluded, and no bonus either.
--   'not_required' — the job needs no particular equipment.
--
-- Evidence, strongest first:
--   1. the capabilities on their assigned fleet truck;
--   2. the problem types the driver themself declared (driver_profiles.
--      service_types, collected in Phase 5);
--   3. their declared truck type.
--
-- (1) and (2) are strong enough to exclude on. (3) is not: vehicle_type says
-- what kind of truck it is, not what is in the toolbox, so a 'standard' unit
-- that happens to carry a booster must not be shut out of battery jobs on an
-- inference. It can therefore earn 'compatible' but never 'incompatible'.
-- The practical effect is that Phase 5 drivers who declared nothing keep
-- receiving exactly the work they received before this migration.
-- ============================================================
create or replace function vehicle_type_capabilities(p_type vehicle_type)
returns service_capability[]
language sql
immutable
as $$
  select case p_type
    when 'flatbed'    then array['flatbed']::service_capability[]
    when 'heavy_duty' then array['heavy_duty','recovery']::service_capability[]
    else                   array['wheel_lift']::service_capability[]
  end
$$;

comment on function vehicle_type_capabilities(vehicle_type) is
  'Weak inference from the declared truck type, used only to GRANT compatibility, never to deny it.';

create or replace function driver_service_compatibility(
  p_driver_id uuid,
  p_problem_type text
)
returns text
language plpgsql
stable
security definer set search_path = public
as $$
declare
  v_req service_type_requirements;
  v_caps service_capability[];
  v_declared text[];
  v_vehicle vehicle_type;
  v_has_strong boolean := false;
  v_ok boolean;
begin
  select * into v_req
  from service_type_requirements
  where problem_type = p_problem_type and active;

  if not found
     or (coalesce(array_length(v_req.any_of_capabilities, 1), 0) = 0
         and coalesce(array_length(v_req.all_of_capabilities, 1), 0) = 0) then
    return 'not_required';
  end if;

  -- Evidence 1: the truck they are actually assigned to.
  v_caps := driver_capabilities(p_driver_id);
  if coalesce(array_length(v_caps, 1), 0) > 0 then
    v_has_strong := true;
  end if;

  select dp.service_types, dp.vehicle_type into v_declared, v_vehicle
  from driver_profiles dp where dp.profile_id = p_driver_id;

  -- Evidence 2: the driver's own list of jobs they take.
  if coalesce(array_length(v_declared, 1), 0) > 0 then
    if p_problem_type = any (v_declared) then
      return 'compatible';
    end if;
    -- They published a list and this job is not on it. That is a statement,
    -- not a gap.
    if not v_has_strong then
      return 'incompatible';
    end if;
  end if;

  if v_has_strong then
    v_ok := (coalesce(array_length(v_req.any_of_capabilities, 1), 0) = 0
             or v_caps && v_req.any_of_capabilities)
            and (coalesce(array_length(v_req.all_of_capabilities, 1), 0) = 0
                 or v_caps @> v_req.all_of_capabilities);
    return case when v_ok then 'compatible' else 'incompatible' end;
  end if;

  -- Evidence 3: weak, grant-only.
  v_caps := vehicle_type_capabilities(v_vehicle);
  if (coalesce(array_length(v_req.any_of_capabilities, 1), 0) = 0
      or v_caps && v_req.any_of_capabilities)
     and (coalesce(array_length(v_req.all_of_capabilities, 1), 0) = 0
          or v_caps @> v_req.all_of_capabilities) then
    return 'compatible';
  end if;

  return 'unknown';
end;
$$;

revoke all on function driver_service_compatibility(uuid, text) from public;
grant execute on function driver_service_compatibility(uuid, text) to authenticated, service_role;

-- ============================================================
-- RATING WITHOUT A FREE 5.0
--
-- driver_profiles.rating defaults to 5.0 and total_services to 0, so a
-- brand-new driver used to score the theoretical maximum on the rating term
-- — better than a driver with two hundred jobs and a 4.8 average. That is
-- not a neutral start, it is a bonus for having no record.
--
-- The fix is shrinkage toward the platform's own mean: an unrated driver is
-- scored exactly as the average rated driver, so they carry neither a bonus
-- nor a penalty, and their real rating takes over as jobs accumulate. When
-- no driver has any history at all, every driver gets the same value and the
-- term drops out of the comparison entirely.
--
-- The smoothing weight is a documented constant in one place, not a tuned
-- parameter and not a rating: it is "how many jobs before a driver's own
-- average outweighs the platform average".
-- ============================================================
create or replace function driver_rating_prior_weight()
returns double precision
language sql
immutable
as $$ select 5.0::double precision $$;

create or replace function driver_rating_population_mean()
returns double precision
language sql
stable
security definer set search_path = public
as $$
  -- Only drivers who actually have a record contribute to the mean; the
  -- default 5.0 on unrated rows would otherwise inflate the very prior it
  -- is supposed to be measured against.
  select coalesce(avg(rating), 4.5)::double precision
  from driver_profiles
  where total_services > 0
$$;

comment on function driver_rating_population_mean() is
  'Mean rating across drivers WITH a record. The 4.5 fallback applies only when the platform has no '
  'rated driver at all, in which case every driver receives it identically and the term cancels out '
  'of every comparison — it is a placeholder, never a rating attributed to anyone.';

create or replace function driver_effective_rating(
  p_rating double precision,
  p_total_services integer,
  p_prior_mean double precision
)
returns double precision
language sql
immutable
as $$
  select (
    coalesce(p_rating, p_prior_mean) * coalesce(p_total_services, 0)
    + p_prior_mean * driver_rating_prior_weight()
  ) / (coalesce(p_total_services, 0) + driver_rating_prior_weight())
$$;

-- ============================================================
-- COMMERCIAL PREFERENCE — deliberately weak, deliberately off.
--
-- A preferred partner gets a head start of at most 60 seconds, and only if
-- they are already a fully eligible candidate and not materially further
-- away than the best one. It cannot make an illegal candidate legal, an
-- incompatible truck compatible, or a non-compliant driver dispatchable:
-- preference is read after every filter has run.
--
-- head_start_seconds defaults to 0, so a row created without an explicit
-- decision changes nothing at all.
-- ============================================================
create table dispatch_partner_preferences (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  -- Optional geographic scope. NULL = wherever the company operates.
  service_area_id uuid references company_service_areas(id) on delete cascade,
  priority integer not null default 100,
  head_start_seconds integer not null default 0
    check (head_start_seconds between 0 and 60),
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index dispatch_partner_preferences_company_idx
  on dispatch_partner_preferences(company_id) where active;

create trigger dispatch_partner_preferences_set_updated_at
  before update on dispatch_partner_preferences
  for each row execute procedure extensions.moddatetime(updated_at);

alter table dispatch_partner_preferences enable row level security;

create policy "partner preferences: company members read own" on dispatch_partner_preferences
  for select using (is_company_member(company_id) or public.is_admin());
create policy "partner preferences: admins full access" on dispatch_partner_preferences
  for all using (public.is_admin()) with check (public.is_admin());

-- How much further a preferred partner may be before preference is dropped.
-- Small on purpose: the customer is at the side of a road.
create or replace function preferred_partner_max_extra_km()
returns double precision
language sql
immutable
as $$ select 3.0::double precision $$;

create or replace function company_preference_head_start(p_company_id uuid)
returns integer
language sql
stable
security definer set search_path = public
as $$
  select coalesce(max(head_start_seconds), 0)
  from dispatch_partner_preferences
  where company_id = p_company_id and active
$$;

revoke all on function company_preference_head_start(uuid) from public;
grant execute on function company_preference_head_start(uuid) to authenticated, service_role;

-- ============================================================
-- dispatch_offers.decision — why this driver, recorded with the offer.
-- ============================================================
alter table dispatch_offers add column decision jsonb;

comment on column dispatch_offers.decision is
  'Snapshot of the eligibility signals that produced this offer: distance, zone authorization, '
  'service compatibility, effective rating, whether commercial preference applied. Written by '
  'dispatch_next_candidate_core().';

-- ============================================================
-- dispatch_candidates() — ONE function produces the candidate list, its
-- eligibility, its reason and its score. Dispatch picks the top row of it;
-- the admin explain view renders all of it. They cannot disagree, because
-- they are the same query.
-- ============================================================
create or replace function dispatch_candidates(
  p_request_id uuid,
  p_radius_km double precision
)
returns table (
  driver_id uuid,
  full_name text,
  distance_km double precision,
  company_id uuid,
  already_offered boolean,
  heartbeat_ok boolean,
  busy boolean,
  compliance_blocked boolean,
  zone_authorized boolean,
  service_compatibility text,
  service_area_ok boolean,
  preferred_partner boolean,
  effective_rating double precision,
  eligible boolean,
  exclusion_reason text,
  score double precision
)
language sql
stable
security definer set search_path = public
as $$
  with req as (
    select r.*, regulated_zone_for_point(r.lat, r.lng) as zone
    from requests r where r.id = p_request_id
  ),
  ctx as (
    select
      (select id from req) as request_id,
      (select lat from req) as lat,
      (select lng from req) as lng,
      (select problem_type from req) as problem_type,
      ((select zone from req)).id as zone_id,
      ((select zone from req)).dispatch_mode as zone_mode,
      driver_rating_population_mean() as prior_mean
  ),
  cand as (
    select
      c.profile_id,
      c.full_name,
      c.distance_km,
      c.rating,
      c.total_services,
      driver_company_id(c.profile_id) as company_id
    from ctx, nearby_drivers(ctx.lat, ctx.lng, p_radius_km, 50) c
  ),
  signals as (
    select
      cand.*,
      ctx.prior_mean,
      ctx.zone_id,
      ctx.zone_mode,
      exists (
        select 1 from dispatch_offers o
        where o.request_id = ctx.request_id and o.driver_id = cand.profile_id
      ) as already_offered,
      -- nearby_drivers() already enforces heartbeat freshness (0017); kept
      -- explicit so the reason is visible in the explain view and so
      -- dispatch stays correct if that function is ever relaxed again.
      (
        select dp.last_heartbeat_at is not null
           and dp.last_heartbeat_at > now() - driver_heartbeat_max_age()
        from driver_profiles dp where dp.profile_id = cand.profile_id
      ) as heartbeat_ok,
      exists (
        select 1 from requests r2
        where r2.driver_id = cand.profile_id
          and r2.status in ('matched', 'en_route', 'arrived', 'in_progress')
      ) as busy,
      driver_dispatch_blocked(cand.profile_id) as compliance_blocked,
      case
        when ctx.zone_id is null then true
        when ctx.zone_mode in ('external_authority_required', 'manual_instruction_only') then false
        when cand.company_id is null then false
        else company_authorized_for_zone(cand.company_id, ctx.zone_id)
      end as zone_authorized,
      driver_service_compatibility(cand.profile_id, ctx.problem_type) as service_compatibility,
      case
        when cand.company_id is null then true
        else company_covers_point(cand.company_id, ctx.lat, ctx.lng)
      end as service_area_ok,
      case
        when cand.company_id is null then false
        else company_preference_head_start(cand.company_id) > 0
      end as preferred_partner,
      driver_effective_rating(cand.rating, cand.total_services, ctx.prior_mean) as effective_rating
    from cand, ctx
  )
  select
    s.profile_id,
    s.full_name,
    s.distance_km,
    s.company_id,
    s.already_offered,
    s.heartbeat_ok,
    s.busy,
    s.compliance_blocked,
    s.zone_authorized,
    s.service_compatibility,
    s.service_area_ok,
    s.preferred_partner,
    s.effective_rating,
    (
      not s.already_offered and s.heartbeat_ok and not s.busy
      and not s.compliance_blocked and s.zone_authorized
      and s.service_compatibility <> 'incompatible'
      and s.service_area_ok
    ) as eligible,
    -- First reason in priority order, so the explanation matches the rule
    -- the product actually states.
    case
      when not s.zone_authorized then 'regulated_zone_not_authorized'
      when s.compliance_blocked then 'documents_not_in_good_standing'
      when s.service_compatibility = 'incompatible' then 'service_not_compatible'
      when not s.service_area_ok then 'outside_company_service_area'
      when s.busy then 'already_on_a_job'
      when not s.heartbeat_ok then 'stale_heartbeat'
      when s.already_offered then 'already_offered_this_request'
      else null
    end as exclusion_reason,
    (
      greatest(0, 1 - (s.distance_km / p_radius_km)) * 0.65
      + (s.effective_rating / 5.0) * 0.20
      + case when s.service_compatibility = 'compatible' then 0.15 else 0 end
    ) as score
  from signals s
  order by
    (
      not s.already_offered and s.heartbeat_ok and not s.busy
      and not s.compliance_blocked and s.zone_authorized
      and s.service_compatibility <> 'incompatible'
      and s.service_area_ok
    ) desc,
    (
      greatest(0, 1 - (s.distance_km / p_radius_km)) * 0.65
      + (s.effective_rating / 5.0) * 0.20
      + case when s.service_compatibility = 'compatible' then 0.15 else 0 end
    ) desc,
    s.distance_km asc
$$;

revoke all on function dispatch_candidates(uuid, double precision) from public;
grant execute on function dispatch_candidates(uuid, double precision) to service_role;

-- ============================================================
-- dispatch_next_candidate_core() — V2. Same signature and same contract as
-- 0017 (returns the created offer, or null), so respond_to_dispatch_offer(),
-- nudge_dispatch() and process_dispatch_timeouts() are untouched.
-- ============================================================
create or replace function dispatch_next_candidate_core(p_request_id uuid)
returns dispatch_offers
language plpgsql
security definer set search_path = public
as $$
declare
  v_request requests;
  v_zone regulated_towing_zones;
  v_best record;
  v_pref record;
  v_chosen record;
  v_offer dispatch_offers;
  v_tier double precision;
  v_head_start integer;
  v_preference_applied boolean := false;
begin
  select * into v_request from requests where id = p_request_id for update;
  if not found then
    raise exception 'Request % not found', p_request_id using errcode = 'P0001';
  end if;

  if v_request.status <> 'pending' or v_request.driver_id is not null then
    return null;
  end if;

  -- ---------------------------------------------------------
  -- 1. REGULATION, before anything else.
  --
  -- Evaluated live rather than from the stamp taken at creation: if a zone
  -- was activated while this request was searching, the new rule applies
  -- from now. Regulation-first means the current rule wins, so the stamp is
  -- refreshed to match rather than the other way round.
  -- ---------------------------------------------------------
  v_zone := regulated_zone_for_point(v_request.lat, v_request.lng);

  if v_zone.id is distinct from v_request.regulated_zone_id then
    perform set_config('towconnect.internal_update', 'true', true);
    update requests
    set regulated_zone_id = v_zone.id,
        regulated_zone_mode = v_zone.dispatch_mode,
        regulated_zone_checked_at = now()
    where id = p_request_id;
    perform set_config('towconnect.internal_update', 'false', true);
  end if;

  if v_zone.id is not null
     and v_zone.dispatch_mode in ('external_authority_required', 'manual_instruction_only') then
    -- TowConnect must not put a truck here. Record the state the customer
    -- screen reads from and stop — no offer, to anyone, ever, for as long as
    -- this rule stands.
    perform set_config('towconnect.internal_update', 'true', true);
    update requests
    set regulated_dispatch_state = case v_zone.dispatch_mode
          when 'external_authority_required' then 'awaiting_external_authority'
          else 'manual_instruction'
        end::regulated_dispatch_state
    where id = p_request_id;
    perform set_config('towconnect.internal_update', 'false', true);
    return null;
  end if;

  -- ---------------------------------------------------------
  -- 2-5. Filters and ranking, widening the radius as V1 did.
  -- ---------------------------------------------------------
  for v_tier in select unnest(array[15, 40, 350]) loop
    select * into v_best
    from dispatch_candidates(p_request_id, v_tier) c
    where c.eligible
    order by c.score desc, c.distance_km asc
    limit 1;

    exit when v_best.driver_id is not null;
  end loop;

  if v_best.driver_id is null then
    -- Nothing available. Inside a regulated zone that means the authorized
    -- providers are saturated, which is a different situation from "no
    -- trucks nearby" and the customer is told so honestly — without a
    -- fabricated wait time, because we do not have one.
    if v_zone.id is not null then
      perform set_config('towconnect.internal_update', 'true', true);
      update requests
      set regulated_dispatch_state = 'restricted_capacity_wait'
      where id = p_request_id;
      perform set_config('towconnect.internal_update', 'false', true);
    end if;
    return null;
  end if;

  v_chosen := v_best;

  -- ---------------------------------------------------------
  -- 6. COMMERCIAL PREFERENCE — last, weakest, and bounded.
  --
  -- Only reached with a legal, compliant, compatible, available winner
  -- already in hand. A preferred partner replaces it only if it is also one
  -- of those, within preferred_partner_max_extra_km() of it, and the request
  -- is still inside the partner's head-start window. Otherwise the customer
  -- keeps the fastest legal truck.
  -- ---------------------------------------------------------
  if v_best.company_id is null or not v_best.preferred_partner then
    select * into v_pref
    from dispatch_candidates(p_request_id, 40) c
    where c.eligible and c.preferred_partner
    order by c.score desc, c.distance_km asc
    limit 1;

    if v_pref.driver_id is not null then
      v_head_start := company_preference_head_start(v_pref.company_id);
      if v_head_start > 0
         and now() < v_request.created_at + make_interval(secs => v_head_start)
         and v_pref.distance_km <= v_best.distance_km + preferred_partner_max_extra_km()
      then
        v_chosen := v_pref;
        v_preference_applied := true;
      end if;
    end if;
  end if;

  perform set_config('towconnect.internal_update', 'true', true);
  update requests
  set driver_id = v_chosen.driver_id,
      regulated_dispatch_state = case
        when v_zone.id is null then 'not_applicable'
        else 'authorized_provider_search'
      end::regulated_dispatch_state
  where id = p_request_id;
  perform set_config('towconnect.internal_update', 'false', true);

  insert into dispatch_offers (request_id, driver_id, status, score, rank, expires_at, decision)
  values (
    p_request_id, v_chosen.driver_id, 'offered', v_chosen.score, 1,
    now() + dispatch_offer_window(),
    jsonb_build_object(
      'distance_km', round(v_chosen.distance_km::numeric, 3),
      'effective_rating', round(v_chosen.effective_rating::numeric, 3),
      'total_services_known', (v_chosen.effective_rating is not null),
      'service_compatibility', v_chosen.service_compatibility,
      'regulated_zone_id', v_zone.id,
      'zone_authorized', v_chosen.zone_authorized,
      'company_id', v_chosen.company_id,
      'commercial_preference_applied', v_preference_applied,
      'radius_km_used', v_tier
    )
  )
  returning * into v_offer;

  return v_offer;
end;
$$;

revoke all on function dispatch_next_candidate_core(uuid) from public;

-- ============================================================
-- explain_dispatch_candidates() — the admin-facing audit view. Same query,
-- widest radius, every candidate with its reason. Admin only: it exposes
-- driver names and company links across the whole platform.
-- ============================================================
create or replace function explain_dispatch_candidates(p_request_id uuid)
returns table (
  driver_id uuid,
  full_name text,
  distance_km double precision,
  company_id uuid,
  eligible boolean,
  exclusion_reason text,
  zone_authorized boolean,
  service_compatibility text,
  compliance_blocked boolean,
  service_area_ok boolean,
  preferred_partner boolean,
  effective_rating double precision,
  score double precision
)
language plpgsql
stable
security definer set search_path = public
as $$
begin
  if not public.is_admin() and auth.role() <> 'service_role' then
    raise exception 'Only an admin can explain dispatch for a request' using errcode = '42501';
  end if;

  return query
  select c.driver_id, c.full_name, c.distance_km, c.company_id, c.eligible,
         c.exclusion_reason, c.zone_authorized, c.service_compatibility,
         c.compliance_blocked, c.service_area_ok, c.preferred_partner,
         c.effective_rating, c.score
  from dispatch_candidates(p_request_id, 350) c;
end;
$$;

revoke all on function explain_dispatch_candidates(uuid) from public;
grant execute on function explain_dispatch_candidates(uuid) to authenticated, service_role;

comment on function dispatch_candidates(uuid, double precision) is
  'The single source of dispatch truth: candidates, per-driver eligibility, the first failing rule '
  'in priority order, and the score. dispatch_next_candidate_core() takes its top eligible row and '
  'explain_dispatch_candidates() renders all of it, so the audit view can never disagree with what '
  'dispatch actually did.';
