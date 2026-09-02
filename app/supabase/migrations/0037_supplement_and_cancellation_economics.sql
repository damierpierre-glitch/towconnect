-- TowConnect — Phase 7: what an approved supplement and a cancellation do to
-- the money. Additive, run after 0036. Sandbox only.
--
-- THE PROBLEM THIS SOLVES
-- 0033 froze a job's economics at acceptance, which is right: a commission
-- change must never reprice a job somebody already agreed to. But two things
-- legitimately happen after acceptance — the customer approves a supplement,
-- and either party cancels — and both move money. They cannot be handled by
-- editing the frozen numbers, because that would erase the freeze.
--
-- So they are handled the way the ledger already handles everything else:
-- as additional, separate facts. requests.partner_amount stays exactly what
-- it was at acceptance; a supplement's provider share is its own ledger entry
-- and its own row state, and a cancellation's fee and compensation are their
-- own columns. What the provider is owed in total is a sum, never an edit.

-- ============================================================
-- Supplements: did the extra money actually get collected?
-- ============================================================
-- An approved supplement is a promise, not a payment. The authorization taken
-- when the request was confirmed covers price_estimate and nothing more, and
-- Stripe will not always let an existing authorization be increased. Recording
-- 'approved' without recording whether the money was secured is how a provider
-- ends up credited for cash that never arrived.
alter table request_supplements
  add column if not exists payment_state text not null default 'pending'
    check (payment_state in ('pending', 'authorized', 'uncollected', 'settled')),
  add column if not exists payment_note text,
  add column if not exists payment_settled_at timestamptz;

comment on column request_supplements.payment_state is
  'pending: approved but not yet secured. authorized: added to the existing hold. '
  'uncollected: the authorization could not be increased — must be collected separately. '
  'settled: captured. Only the service role writes this.';

-- The customer approves; the platform records what happened to the money.
-- Neither party may write that themselves — a driver who could set
-- payment_state to ''settled'' would be crediting their own ledger.
create or replace function guard_supplement_payment_state()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if auth.role() = 'service_role' or public.is_admin() then
    return new;
  end if;
  if new.payment_state is distinct from old.payment_state
     or new.payment_note is distinct from old.payment_note
     or new.payment_settled_at is distinct from old.payment_settled_at then
    raise exception 'Only TowConnect records what happened to a supplement''s payment'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists request_supplements_guard_payment_state on request_supplements;
create trigger request_supplements_guard_payment_state
  before update on request_supplements
  for each row execute procedure guard_supplement_payment_state();

-- ============================================================
-- Cancellations
-- ============================================================
-- Both numbers are nullable and ship NULL. NULL means "no cancellation policy
-- was configured", which is a different fact from "the fee was zero" — and the
-- second is a decision nobody has made yet.
alter table requests
  add column if not exists cancellation_fee_charged numeric(10,2)
    check (cancellation_fee_charged >= 0),
  add column if not exists cancellation_compensation numeric(10,2)
    check (cancellation_compensation >= 0),
  add column if not exists cancellation_settled_at timestamptz;

comment on column requests.cancellation_fee_charged is
  'What the customer was actually charged for cancelling. NULL = no cancellation policy configured.';

-- Same protection as every other money column on requests: a driver may only
-- move the status.
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
       or new.payment_processing_cost is distinct from old.payment_processing_cost
       or new.pricing_config_id is distinct from old.pricing_config_id
       or new.pricing_config_version is distinct from old.pricing_config_version
       or new.pricing_rule_ids is distinct from old.pricing_rule_ids
       or new.economics_frozen_at is distinct from old.economics_frozen_at
       -- Added in 0037.
       or new.cancellation_fee_charged is distinct from old.cancellation_fee_charged
       or new.cancellation_compensation is distinct from old.cancellation_compensation
       or new.cancellation_settled_at is distinct from old.cancellation_settled_at
    then
      raise exception 'A driver may only update a request''s status' using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

-- ============================================================
-- Totals, derived — never stored
-- ============================================================
-- The customer's total is the frozen price plus whatever they approved on top
-- of it. Stored nowhere, so it cannot drift from the supplements it is made of.
create or replace function request_total_customer_price(p_request_id uuid)
returns numeric
language plpgsql
stable
security definer set search_path = public
as $$
declare
  v_request requests;
  v_supplements numeric;
begin
  select * into v_request from requests where id = p_request_id;
  if not found then
    return null;
  end if;

  if auth.role() <> 'service_role'
     and not public.is_admin()
     and auth.uid() is distinct from v_request.driver_id
     and auth.uid() is distinct from v_request.user_id then
    raise exception 'Not authorized to read this request''s economics' using errcode = '42501';
  end if;

  select coalesce(sum(s.amount), 0) into v_supplements
  from request_supplements s
  where s.request_id = p_request_id and s.status = 'approved';

  return round(coalesce(v_request.price_estimate, 0) + v_supplements, 2);
end;
$$;

revoke all on function request_total_customer_price(uuid) from public;
grant execute on function request_total_customer_price(uuid) to authenticated, service_role;

-- What the provider is owed for this job, all in: the amount frozen at
-- acceptance plus every later movement recorded against the job. Returns NULL
-- when nothing was frozen, because "no configuration was active" must not
-- come back looking like zero.
create or replace function request_total_provider_compensation(p_request_id uuid)
returns numeric
language plpgsql
stable
security definer set search_path = public
as $$
declare
  v_request requests;
  v_extra numeric;
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

  if v_request.partner_amount is null then
    return null;
  end if;

  select coalesce(sum(e.amount), 0) into v_extra
  from provider_ledger_entries e
  where e.request_id = p_request_id
    and e.entry_type in ('supplement', 'adjustment', 'refund_reversal');

  return round(v_request.partner_amount + v_extra, 2);
end;
$$;

revoke all on function request_total_provider_compensation(uuid) from public;
grant execute on function request_total_provider_compensation(uuid) to authenticated, service_role;

comment on function request_total_provider_compensation(uuid) is
  'Phase 7: frozen compensation plus later ledger movements for the same job. NULL means no '
  'configuration was active at acceptance — render nothing, never a zero.';
