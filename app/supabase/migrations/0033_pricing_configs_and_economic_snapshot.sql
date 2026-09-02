-- TowConnect — Phase 7: versioned economic configuration, and a frozen
-- economic snapshot on every confirmed request. Additive, run after 0032.
--
-- WHAT PHASE 6 LEFT AND WHY IT IS NOT ENOUGH
-- platform_pricing_config was a single row of NULLs: enough to say "no rate is
-- decided", not enough to run a business on. A single mutable row has no
-- answer to the question that actually matters once money moves — "which rule
-- applied to THIS job?" — because editing the row rewrites the past.
--
-- So configurations are now versioned rows, exactly one of which may be
-- active, and a confirmed request stores which one it was priced under. A
-- commission change tomorrow cannot reprice a job from last week, because last
-- week's job carries its own numbers and a pointer to the version that
-- produced them.
--
-- STILL NO RATE. Every money column below is NULL, no configuration is active,
-- and a CHECK refuses to activate one that says nothing. Choosing the number
-- is a business decision; this phase builds the machine that will hold it and
-- the simulator that will inform it.

create type pricing_config_status as enum ('draft', 'active', 'archived');

create table pricing_configs (
  id uuid primary key default gen_random_uuid(),
  version integer not null unique,
  label text not null,
  status pricing_config_status not null default 'draft',

  -- ---- what TowConnect keeps -------------------------------------------
  -- A deployment may use a percentage, a fixed amount, or both. Both NULL
  -- means undecided, which is the state this ships in.
  commission_percent numeric(6,4) check (commission_percent >= 0 and commission_percent <= 100),
  commission_fixed numeric(10,2) check (commission_fixed >= 0),
  -- Floor and ceiling on TowConnect's own cut. A floor keeps a $60 job from
  -- costing more to process than it earns; a ceiling keeps a $900 heavy
  -- recovery from taking an absurd slice. Both optional.
  commission_min numeric(10,2) check (commission_min >= 0),
  commission_max numeric(10,2) check (commission_max >= 0),

  -- ---- what the partner is guaranteed ----------------------------------
  provider_minimum numeric(10,2) check (provider_minimum >= 0),

  -- ---- what the processor costs ----------------------------------------
  -- Not a guess at Stripe's pricing: NULL until somebody puts the real
  -- numbers from the account in. An estimated processing cost silently
  -- overstates margin, which is the one error nobody catches.
  payment_processing_percent numeric(6,4) check (payment_processing_percent >= 0),
  payment_processing_fixed numeric(10,2) check (payment_processing_fixed >= 0),

  -- ---- cancellation economics (Part E) ---------------------------------
  -- Architecture only. NULL means "no cancellation fee exists", which is the
  -- honest default: inventing one would charge real customers for a rule
  -- nobody agreed to.
  cancellation_fee_customer numeric(10,2) check (cancellation_fee_customer >= 0),
  cancellation_compensation_provider numeric(10,2) check (cancellation_compensation_provider >= 0),

  currency text not null default 'cad',
  notes text,

  created_at timestamptz not null default now(),
  created_by uuid references profiles(id),
  activated_at timestamptz,
  activated_by uuid references profiles(id),
  archived_at timestamptz,

  -- A live configuration that defines no commission is a trap: it looks
  -- configured and computes nothing. Refuse it, the same way 0027 refuses a
  -- live pricing rule with no value.
  constraint pricing_config_active_needs_commission check (
    status <> 'active' or commission_percent is not null or commission_fixed is not null
  ),
  constraint pricing_config_commission_range check (
    commission_min is null or commission_max is null or commission_max >= commission_min
  )
);

-- Exactly one active configuration, enforced by the database rather than by
-- whoever clicks the button.
create unique index pricing_configs_single_active
  on pricing_configs ((status = 'active')) where status = 'active';

create index pricing_configs_status_idx on pricing_configs(status, version desc);

alter table pricing_configs enable row level security;

-- Readable by any signed-in user: a partner is entitled to know the terms
-- they are working under. Today that read returns nothing active, which is
-- the honest answer.
create policy "pricing configs: signed-in users read active" on pricing_configs
  for select using (status = 'active');
create policy "pricing configs: admins full access" on pricing_configs
  for all using (public.is_admin()) with check (public.is_admin());

-- ============================================================
-- AUDIT — who changed the economics, from what, to what, when.
-- Written by a trigger; no role has a policy to delete from it, admins
-- included. The same shape as regulated_zone_audit, for the same reason:
-- the record of a money decision must outlive the person who made it.
-- ============================================================
create table pricing_config_audit (
  id bigserial primary key,
  config_id uuid,
  action text not null check (action in ('insert', 'update', 'delete')),
  actor_id uuid,
  actor_role text,
  old_row jsonb,
  new_row jsonb,
  created_at timestamptz not null default now()
);

create index pricing_config_audit_config_idx on pricing_config_audit(config_id, created_at desc);

alter table pricing_config_audit enable row level security;
create policy "pricing config audit: admins read" on pricing_config_audit
  for select using (public.is_admin());

create or replace function log_pricing_config_change()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into pricing_config_audit (config_id, action, actor_id, actor_role, old_row, new_row)
  values (
    case when tg_op = 'DELETE' then old.id else new.id end,
    lower(tg_op),
    auth.uid(),
    auth.role(),
    case when tg_op = 'INSERT' then null else to_jsonb(old) end,
    case when tg_op = 'DELETE' then null else to_jsonb(new) end
  );
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger pricing_configs_audit
  after insert or update or delete on pricing_configs
  for each row execute procedure log_pricing_config_change();

-- ============================================================
-- THE ACTIVE CONFIGURATION
-- ============================================================
create or replace function active_pricing_config()
returns pricing_configs
language sql
stable
security definer set search_path = public
as $$
  select * from pricing_configs where status = 'active' limit 1
$$;

revoke all on function active_pricing_config() from public;
grant execute on function active_pricing_config() to authenticated, service_role;

create or replace function pricing_configured()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from pricing_configs
    where status = 'active'
      and (commission_percent is not null or commission_fixed is not null)
  )
$$;

-- platform_pricing_config (0027) was the single-row precursor. It is replaced
-- by a view over the active configuration so that everything already reading
-- it keeps working and keeps getting the right answer — including the
-- all-NULL row it should see while nothing is active.
drop table if exists platform_pricing_config cascade;

create view platform_pricing_config as
select
  true as id,
  c.commission_percent,
  c.commission_fixed,
  c.provider_minimum,
  c.payment_processing_percent,
  c.payment_processing_fixed,
  coalesce(c.activated_at, now()) as updated_at,
  c.activated_by as updated_by
from (select 1) one
left join pricing_configs c on c.status = 'active';

comment on view platform_pricing_config is
  'Compatibility view over the active pricing_configs row. Always returns exactly one row: all-NULL '
  'while no configuration is active, which is the honest answer to "what is the commission rate".';

-- ============================================================
-- THE SNAPSHOT ON A REQUEST
--
-- requests already carries price_estimate (customer price), commission_amount
-- (TowConnect margin), partner_amount (provider compensation) and
-- payment_processing_cost from 0012/0027. What was missing is WHICH RULE
-- produced them, and when they stopped being able to change.
-- ============================================================
alter table requests
  add column pricing_config_id uuid references pricing_configs(id),
  add column pricing_config_version integer,
  add column pricing_rule_ids uuid[] not null default '{}',
  add column economics_frozen_at timestamptz;

comment on column requests.economics_frozen_at is
  'Set when the driver accepts. After this, the money on this row is what the partner agreed to and '
  'what the customer was quoted; a later configuration change must not touch it.';
comment on column requests.partner_amount is
  'Provider compensation, frozen at acceptance. NULL means no economic configuration was active, '
  'which is different from zero and must be rendered as "not configured", never as $0.';

-- Extend the 0014 lockdown. A driver session may still only ever change
-- `status`; the economics of their own job are as off-limits as the price.
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
       or new.regulated_zone_id is distinct from old.regulated_zone_id
       or new.regulated_zone_mode is distinct from old.regulated_zone_mode
       or new.regulated_dispatch_state is distinct from old.regulated_dispatch_state
       or new.regulated_zone_checked_at is distinct from old.regulated_zone_checked_at
       -- Added in 0033.
       or new.payment_processing_cost is distinct from old.payment_processing_cost
       or new.pricing_config_id is distinct from old.pricing_config_id
       or new.pricing_config_version is distinct from old.pricing_config_version
       or new.pricing_rule_ids is distinct from old.pricing_rule_ids
       or new.economics_frozen_at is distinct from old.economics_frozen_at
    then
      raise exception 'A driver may only update a request''s status' using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

-- ============================================================
-- WHAT THE PARTNER WILL BE PAID
--
-- Phase 6's version recomputed from the live configuration when the stored
-- amount was null. That is now wrong on purpose: after acceptance the frozen
-- number is the only correct answer, and before acceptance the answer comes
-- from the simulator in application code, which is also what quotes the
-- driver. One rule, computed once, stored once.
-- ============================================================
create or replace function request_provider_compensation(p_request_id uuid)
returns numeric
language plpgsql
stable
security definer set search_path = public
as $$
declare
  v_request requests;
begin
  select * into v_request from requests where id = p_request_id;
  if not found then
    return null;
  end if;

  if auth.role() <> 'service_role'
     and not public.is_admin()
     and auth.uid() is distinct from v_request.driver_id
     and auth.uid() is distinct from v_request.user_id
     and not is_company_manager(driver_company_id(v_request.driver_id)) then
    raise exception 'Not authorized to read this request''s economics' using errcode = '42501';
  end if;

  -- Frozen or nothing. NULL means no economic configuration was active when
  -- this job was accepted; the caller must render that as "not configured",
  -- never as zero.
  return v_request.partner_amount;
end;
$$;

revoke all on function request_provider_compensation(uuid) from public;
grant execute on function request_provider_compensation(uuid) to authenticated, service_role;

comment on function request_provider_compensation(uuid) is
  'Phase 7: returns the FROZEN provider compensation, never a recomputation. NULL means no '
  'configuration was active at acceptance — render nothing, never a zero.';
