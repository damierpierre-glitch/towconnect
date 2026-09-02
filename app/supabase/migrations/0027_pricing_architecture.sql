-- TowConnect — Phase 6, Part D: pricing and partner-compensation
-- architecture, plus customer-approved supplements. Additive, run after 0026.
--
-- THE ONE RULE THIS FILE IS BUILT AROUND
-- The commission rate is not decided. So nothing here contains one. Every
-- money field that would need it is NULL, every rule ships inactive, and the
-- functions that would compute a payout return 'not_configured' rather than
-- a number. A 20% that nobody chose is worse than a blank, because a blank
-- is obviously unfinished and a number looks like a decision.
--
-- That is enforced, not just intended:
--   * platform_pricing_config has exactly one row, and it is all NULLs;
--   * pricing_rules.active defaults to false and a CHECK refuses to activate
--     a rule that has no value in it;
--   * request_economics() returns status='not_configured' and NULL amounts
--     until a rate exists;
--   * the driver-facing "you will receive X" helper returns NULL, and the UI
--     is written to show nothing rather than a placeholder.
--
-- WHY NOT RENAME THE EXISTING COLUMNS
-- requests already carries price_estimate, commission_amount and
-- partner_amount from 0012. Renaming them to the brief's vocabulary would
-- touch the receipt, the webhook, the history screens and the Stripe capture
-- path for no functional gain. Instead the request_economics view exposes
-- exactly the four names the brief asks for, over the columns that already
-- exist, plus the one that was genuinely missing.

-- ============================================================
-- PLATFORM PRICING CONFIG — one row, deliberately empty.
-- ============================================================
create table platform_pricing_config (
  id boolean primary key default true check (id),

  -- TowConnect's cut. Both NULL = not decided. A deployment may later use a
  -- percentage, a fixed amount, or both (percentage with a floor).
  commission_percent numeric(6,4) check (commission_percent >= 0 and commission_percent <= 100),
  commission_fixed numeric(10,2) check (commission_fixed >= 0),

  -- A floor under what a partner receives, whatever the commission maths
  -- says. NULL until the business decides there is one.
  provider_minimum numeric(10,2) check (provider_minimum >= 0),

  -- What the payment processor actually costs, so margin is not quietly
  -- overstated. NULL until measured against real Stripe pricing.
  payment_processing_percent numeric(6,4) check (payment_processing_percent >= 0),
  payment_processing_fixed numeric(10,2) check (payment_processing_fixed >= 0),

  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id)
);

insert into platform_pricing_config (id) values (true);

alter table platform_pricing_config enable row level security;

-- Readable by any signed-in user: a partner is entitled to know the terms.
-- Today that read returns all NULLs, which is the honest answer.
create policy "pricing config: signed-in users read" on platform_pricing_config
  for select using (true);
create policy "pricing config: admins write" on platform_pricing_config
  for all using (public.is_admin()) with check (public.is_admin());

create or replace function pricing_configured()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select coalesce(
    (select commission_percent is not null or commission_fixed is not null
     from platform_pricing_config where id),
    false
  )
$$;

revoke all on function pricing_configured() from public;
grant execute on function pricing_configured() to authenticated, service_role;

comment on table platform_pricing_config is
  'Single-row platform economics. Ships entirely NULL: the commission rate is a business decision '
  'that has not been made, and inventing one here would put a fabricated number in front of partners.';

-- ============================================================
-- PRICING RULES — the shape a future pricing engine needs, with no engine
-- switched on. Architecture only, exactly as the brief asks.
-- ============================================================
create type pricing_target as enum (
  'customer_price',
  'provider_compensation',
  'towconnect_margin',
  'payment_processing'
);

create type pricing_component as enum (
  'base_fee',
  'per_km',
  'minimum',
  'percentage',
  'fixed_amount',
  'cap'
);

create table pricing_rules (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  target pricing_target not null,
  component pricing_component not null,

  -- Exactly one of these carries the value, depending on `component`.
  amount numeric(10,4),
  percent numeric(6,4) check (percent >= 0),

  -- Scope. Every dimension nullable: null means "does not narrow".
  province text,
  regulated_zone_id uuid references regulated_towing_zones(id) on delete cascade,
  company_id uuid references companies(id) on delete cascade,
  problem_type text,
  required_capability service_capability,
  -- 0 = Sunday, matching extract(dow).
  day_of_week smallint check (day_of_week between 0 and 6),
  hour_from smallint check (hour_from between 0 and 23),
  hour_to smallint check (hour_to between 0 and 23),

  priority integer not null default 100,
  effective_from date,
  effective_to date,
  -- Inactive by default. A rule takes effect when somebody decides it does.
  active boolean not null default false,
  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A live rule that says nothing is a trap: it looks configured and does
  -- nothing. Refuse it.
  constraint pricing_rule_active_needs_value check (
    not active or amount is not null or percent is not null
  ),
  constraint pricing_rule_effective_range check (
    effective_to is null or effective_from is null or effective_to >= effective_from
  )
);

create index pricing_rules_lookup_idx on pricing_rules(target, priority) where active;

create trigger pricing_rules_set_updated_at
  before update on pricing_rules
  for each row execute procedure extensions.moddatetime(updated_at);

alter table pricing_rules enable row level security;

create policy "pricing rules: admins full access" on pricing_rules
  for all using (public.is_admin()) with check (public.is_admin());

-- A company may read the rules that are specifically about it. It may not
-- read the platform-wide ones, and it may not write any of them.
create policy "pricing rules: company reads its own" on pricing_rules
  for select using (company_id is not null and is_company_member(company_id));

comment on table pricing_rules is
  'Architecture for a future pricing engine: base fee, per-km, minimums, percentages, caps, scoped by '
  'province / zone / company / service / equipment / time. Ships with zero rows and active defaulting '
  'to false — no dynamic pricing is switched on by this phase.';

-- ============================================================
-- REQUESTS — the one economics column that was genuinely missing, plus the
-- vocabulary the brief asks for, as a view over what already exists.
-- ============================================================
alter table requests
  add column payment_processing_cost numeric(8,2);

comment on column requests.payment_processing_cost is
  'What the payment processor took. NULL until platform_pricing_config carries real processor '
  'pricing — never estimated.';

-- ============================================================
-- SUPPLEMENTS — extras that only exist once the customer approves them.
--
-- The product rule is "no surprise supplement". The database rule that
-- makes it true: a supplement is proposed by the assigned driver and can
-- only move to 'approved' by the request's own owner. There is no path for a
-- driver to approve their own supplement, and an approved one is frozen.
-- ============================================================
create type supplement_status as enum ('proposed', 'approved', 'declined', 'cancelled');

create table service_supplement_types (
  key text primary key,
  label_fr text not null,
  label_en text not null,
  active boolean not null default true
);

insert into service_supplement_types (key, label_fr, label_en) values
  ('winch',              'Treuillage',                  'Winching'),
  ('complex_recovery',   'Récupération complexe',       'Complex recovery'),
  ('destination_change', 'Changement de destination',   'Destination change'),
  ('waiting_time',       'Temps d''attente',            'Waiting time'),
  ('other',              'Autre supplément autorisé',   'Other authorized supplement');

alter table service_supplement_types enable row level security;
create policy "supplement types: signed-in users read active" on service_supplement_types
  for select using (active = true);
create policy "supplement types: admins write" on service_supplement_types
  for all using (public.is_admin()) with check (public.is_admin());

create table request_supplements (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references requests(id) on delete cascade,
  type_key text not null references service_supplement_types(key),
  amount numeric(8,2) not null check (amount >= 0),
  note text,
  status supplement_status not null default 'proposed',
  proposed_by uuid not null references profiles(id),
  responded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index request_supplements_request_idx on request_supplements(request_id, status);

create trigger request_supplements_set_updated_at
  before update on request_supplements
  for each row execute procedure extensions.moddatetime(updated_at);

alter table request_supplements enable row level security;

create policy "supplements: request participants read" on request_supplements
  for select using (
    exists (
      select 1 from requests r
      where r.id = request_supplements.request_id
        and (r.user_id = auth.uid() or r.driver_id = auth.uid())
    )
    or public.is_admin()
  );

-- Only the assigned driver may propose, only ever as 'proposed', only ever
-- under their own name.
create policy "supplements: assigned driver proposes" on request_supplements
  for insert with check (
    proposed_by = auth.uid()
    and status = 'proposed'
    and responded_at is null
    and exists (
      select 1 from requests r
      where r.id = request_supplements.request_id
        and r.driver_id = auth.uid()
        and r.status in ('matched', 'en_route', 'arrived', 'in_progress')
    )
  );

-- The customer answers. The driver may withdraw their own untouched
-- proposal. Which of the two you are decides which transitions the trigger
-- below will let through.
create policy "supplements: participants respond" on request_supplements
  for update using (
    exists (
      select 1 from requests r
      where r.id = request_supplements.request_id
        and (r.user_id = auth.uid() or r.driver_id = auth.uid())
    )
  )
  with check (
    exists (
      select 1 from requests r
      where r.id = request_supplements.request_id
        and (r.user_id = auth.uid() or r.driver_id = auth.uid())
    )
  );

create policy "supplements: admins full access" on request_supplements
  for all using (public.is_admin()) with check (public.is_admin());

create or replace function guard_request_supplement()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_request requests;
  v_is_owner boolean;
  v_is_driver boolean;
begin
  select * into v_request from requests where id = new.request_id;
  v_is_owner := (auth.uid() = v_request.user_id);
  v_is_driver := (auth.uid() = v_request.driver_id);

  if auth.role() = 'service_role' or public.is_admin() then
    return new;
  end if;

  -- An approved supplement is money the customer agreed to. It is frozen.
  if old.status = 'approved' then
    raise exception 'An approved supplement cannot be modified' using errcode = '42501';
  end if;

  if new.amount is distinct from old.amount
     or new.type_key is distinct from old.type_key
     or new.request_id is distinct from old.request_id
     or new.proposed_by is distinct from old.proposed_by then
    raise exception 'A supplement''s amount, type and origin are fixed once proposed'
      using errcode = '42501';
  end if;

  if new.status is distinct from old.status then
    if new.status in ('approved', 'declined') then
      -- THE invariant: only the person paying can say yes.
      if not v_is_owner then
        raise exception 'Only the customer can approve or decline a supplement' using errcode = '42501';
      end if;
      new.responded_at := now();
    elsif new.status = 'cancelled' then
      if not v_is_driver then
        raise exception 'Only the driver who proposed it can withdraw a supplement' using errcode = '42501';
      end if;
      new.responded_at := now();
    else
      raise exception 'Invalid supplement transition % -> %', old.status, new.status
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

create trigger request_supplements_guard
  before update on request_supplements
  for each row execute procedure guard_request_supplement();

alter publication supabase_realtime add table request_supplements;

-- ============================================================
-- REQUEST ECONOMICS — the four names the brief asks for, over the columns
-- that already carry them. Defined here rather than beside the requests
-- ALTER above because it reads request_supplements, which has to exist
-- first.
-- ============================================================
create or replace view request_economics as
select
  r.id as request_id,
  r.user_id,
  r.driver_id,
  -- The frozen total the customer agreed to, from 0012.
  r.price_estimate as customer_price,
  r.partner_amount as provider_compensation,
  r.commission_amount as towconnect_margin,
  r.payment_processing_cost,
  -- Supplements the customer actually approved, never the proposed ones.
  coalesce((
    select sum(s.amount) from request_supplements s
    where s.request_id = r.id and s.status = 'approved'
  ), 0)::numeric(10,2) as approved_supplements,
  (r.price_estimate + coalesce((
    select sum(s.amount) from request_supplements s
    where s.request_id = r.id and s.status = 'approved'
  ), 0))::numeric(10,2) as customer_total,
  case
    when r.commission_amount is null and r.partner_amount is null then 'not_configured'
    else 'computed'
  end as economics_status
from requests r;

comment on view request_economics is
  'The four money concepts the Phase 6 brief names, over the columns that already carry them. '
  'economics_status distinguishes "no commission rate has been decided" from "computed and zero".';


-- ============================================================
-- WHAT A PARTNER WOULD BE PAID — and why it says nothing today.
-- ============================================================
create or replace function request_provider_compensation(p_request_id uuid)
returns numeric
language plpgsql
stable
security definer set search_path = public
as $$
declare
  v_cfg platform_pricing_config;
  v_request requests;
  v_supplements numeric;
  v_gross numeric;
  v_commission numeric;
  v_net numeric;
begin
  select * into v_request from requests where id = p_request_id;
  if not found then
    return null;
  end if;

  -- Nobody but the two parties and an admin gets to ask.
  if auth.role() <> 'service_role'
     and not public.is_admin()
     and auth.uid() is distinct from v_request.driver_id
     and auth.uid() is distinct from v_request.user_id then
    raise exception 'Not authorized to read this request''s economics' using errcode = '42501';
  end if;

  -- Already settled and stored: return the real number.
  if v_request.partner_amount is not null then
    return v_request.partner_amount;
  end if;

  select * into v_cfg from platform_pricing_config where id;
  if v_cfg.commission_percent is null and v_cfg.commission_fixed is null then
    -- No rate exists. Return NULL so every caller has to decide what to show
    -- for "unknown" — the driver UI shows nothing at all — instead of being
    -- handed a plausible-looking zero.
    return null;
  end if;

  select coalesce(sum(s.amount), 0) into v_supplements
  from request_supplements s
  where s.request_id = p_request_id and s.status = 'approved';

  v_gross := v_request.price_estimate + v_supplements;
  v_commission := coalesce(v_gross * coalesce(v_cfg.commission_percent, 0) / 100, 0)
                  + coalesce(v_cfg.commission_fixed, 0);
  v_net := v_gross - v_commission;

  if v_cfg.provider_minimum is not null then
    v_net := greatest(v_net, v_cfg.provider_minimum);
  end if;

  return round(v_net, 2);
end;
$$;

revoke all on function request_provider_compensation(uuid) from public;
grant execute on function request_provider_compensation(uuid) to authenticated, service_role;

comment on function request_provider_compensation(uuid) is
  'Returns NULL while no commission rate is configured. Callers must render nothing in that case — '
  'never a zero, never an estimate. See TOWCONNECT_PHASE6_REPORT.md.';
