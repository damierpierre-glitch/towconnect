-- TowConnect — Phase 7: Stripe Connect account state on a company.
-- Additive, run after 0033. SANDBOX ONLY — see the guard in
-- src/lib/stripe/connect.ts, which refuses to run against a live key.
--
-- WHAT IS AND IS NOT STORED HERE
-- Only Stripe's own identifier and the flags Stripe reports back about the
-- account. No bank account number, no card, no KYC document, no date of
-- birth, no government id. Onboarding happens on Stripe's hosted flow through
-- an Account Link, so those values never touch this application, never travel
-- through our servers, and cannot leak from this table because they are not
-- in it.
--
-- WHY EVERY FLAG IS WRITE-PROTECTED
-- charges_enabled and payouts_enabled decide whether a company can be paid.
-- `companies` already has an owner/admin UPDATE policy with no column
-- restriction, so without the guard below a company owner could mark their own
-- account payouts_enabled and walk straight past onboarding. These columns are
-- Stripe's answer, not ours: only the service role (the webhook and the server
-- actions that just called Stripe) and a platform admin may write them.

create type connect_onboarding_status as enum (
  'not_started',   -- no Stripe account created yet
  'pending',       -- account created, Stripe still wants information
  'restricted',    -- Stripe has restricted the account; requirements are due
  'enabled',       -- charges and payouts both enabled
  'disabled'       -- Stripe disabled it, or we did
);

alter table companies
  add column stripe_account_id text unique,
  add column connect_status connect_onboarding_status not null default 'not_started',
  -- Mirrors of Stripe's own booleans, refreshed from the API and from
  -- account.updated. Never set from a browser.
  add column connect_charges_enabled boolean not null default false,
  add column connect_payouts_enabled boolean not null default false,
  -- What Stripe still wants, so the dashboard can say something specific
  -- instead of "onboarding incomplete".
  add column connect_requirements_due text[] not null default '{}',
  add column connect_disabled_reason text,
  add column connect_updated_at timestamptz;

comment on column companies.stripe_account_id is
  'Stripe Connect account id. The only Stripe identifier stored; no bank, card or KYC data is ever '
  'held by TowConnect - onboarding runs on Stripe''s hosted flow.';

create index companies_stripe_account_idx on companies(stripe_account_id)
  where stripe_account_id is not null;

create or replace function guard_company_connect_fields()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if auth.role() = 'service_role' or public.is_admin() then
    return new;
  end if;

  if new.stripe_account_id is distinct from old.stripe_account_id
     or new.connect_status is distinct from old.connect_status
     or new.connect_charges_enabled is distinct from old.connect_charges_enabled
     or new.connect_payouts_enabled is distinct from old.connect_payouts_enabled
     or new.connect_requirements_due is distinct from old.connect_requirements_due
     or new.connect_disabled_reason is distinct from old.connect_disabled_reason
     or new.connect_updated_at is distinct from old.connect_updated_at
  then
    raise exception 'Stripe Connect state is set by Stripe, not by the company'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger companies_guard_connect_fields
  before update on companies
  for each row execute procedure guard_company_connect_fields();
