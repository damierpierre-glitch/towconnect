-- TowConnect — Phase 5: minimal, additive groundwork for the future
-- Business/company role. No UI reads or writes this table yet — that
-- dashboard is explicitly out of scope for this phase — this migration only
-- makes sure the *next* phase isn't starting from a schema that has to
-- retrofit multi-driver ownership onto driver_profiles after the fact.
--
-- Scope discipline: no Stripe Connect, no payouts, no fleet/vehicle-pool
-- tables, no owner-facing policies beyond "an owner can read their own
-- company row". Anything beyond that is a Phase 6 decision, made with an
-- actual UI in front of it rather than guessed at here.

create table companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_id uuid not null references profiles(id),
  created_at timestamptz not null default now()
);

alter table companies enable row level security;

create policy "companies: owner reads own" on companies
  for select using (auth.uid() = owner_id);

create policy "companies: admins full access" on companies
  for all using (public.is_admin());

-- No insert/update/delete policy for authenticated at all — same
-- structurally-impossible-not-just-discouraged pattern as payments (0013)
-- and dispatch_offers (0006). Creating a company is an admin/back-office
-- action until there is an actual signup flow for it.

alter table driver_profiles
  add column company_id uuid references companies(id) on delete set null;

create index driver_profiles_company_idx on driver_profiles(company_id);

-- A driver must not be able to attach themself to an arbitrary company any
-- more than they can approve themself — same guard trigger, extended the
-- same way rejection_reason was in 0019.
create or replace function guard_driver_privileged_fields()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if current_setting('towconnect.internal_update', true) = 'true' then
    return new;
  end if;

  if auth.role() = 'service_role' then
    return new;
  end if;

  if (
    new.approval_status is distinct from old.approval_status
    or new.rating is distinct from old.rating
    or new.total_services is distinct from old.total_services
    or new.rejection_reason is distinct from old.rejection_reason
    or new.company_id is distinct from old.company_id
  ) and not exists (
    select 1 from profiles p where p.id = auth.uid() and p.role = 'admin'
  ) then
    raise exception 'Only an admin can change approval_status, rating, total_services, rejection_reason, or company_id'
      using errcode = '42501';
  end if;

  return new;
end;
$$;
