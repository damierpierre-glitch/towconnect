-- TowConnect — follow-up lockdown, found while writing RLS integration tests.
-- Run this after 0001_init.sql and 0002_hardening.sql.

-- ============================================================
-- Fix 1: rating and total_services had the same self-write gap that
-- approval_status had before 0002 — a driver could update either directly
-- on their own row. Extend the existing approval-status guard trigger to
-- cover all three "system/admin only" fields.
--
-- One legitimate path needs to keep writing total_services: completing a
-- job increments it. That write is moved out of client code (driver.ts) and
-- into a trigger on `requests` below, which marks itself as an internal
-- update via a transaction-local setting so the guard trigger below can
-- tell it apart from a driver editing their own row directly.
-- ============================================================
drop trigger if exists driver_profiles_guard_approval on driver_profiles;
drop function if exists guard_driver_approval_status();

create or replace function guard_driver_privileged_fields()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  -- Set (transaction-local) by bump_driver_total_services() below when it
  -- performs the one legitimate system write to total_services.
  if current_setting('towconnect.internal_update', true) = 'true' then
    return new;
  end if;

  if (
    new.approval_status is distinct from old.approval_status
    or new.rating is distinct from old.rating
    or new.total_services is distinct from old.total_services
  ) and not exists (
    select 1 from profiles p where p.id = auth.uid() and p.role = 'admin'
  ) then
    raise exception 'Only an admin can change approval_status, rating, or total_services'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger driver_profiles_guard_privileged_fields
  before update on driver_profiles
  for each row execute procedure guard_driver_privileged_fields();

-- Completing a job increments the driver's total_services. This used to be
-- a plain client-side update from the driver's own session (see the old
-- advanceRequestStatus() in src/lib/actions/driver.ts) — moved server-side
-- so the field can be locked down above without breaking it.
create or replace function bump_driver_total_services()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if new.status = 'completed' and old.status is distinct from 'completed' and new.driver_id is not null then
    perform set_config('towconnect.internal_update', 'true', true);
    update driver_profiles
    set total_services = total_services + 1
    where profile_id = new.driver_id;
    perform set_config('towconnect.internal_update', 'false', true);
  end if;
  return new;
end;
$$;

create trigger requests_bump_driver_total_services
  after update on requests
  for each row execute procedure bump_driver_total_services();

-- ============================================================
-- Fix 2: a request in 'pending' status was visible to EVERY approved
-- driver, not just the one it was offered to. TowConnect's matching model
-- assigns a single driver_id at creation time (see RequestFlow.tsx /
-- StepDrivers.tsx) rather than broadcasting to all nearby drivers, so
-- "status = 'pending'" being enough to read any row was over-exposure: any
-- driver could read the exact breakdown location of every open request in
-- the system, not just their own offer.
-- ============================================================
drop policy "requests: approved drivers read pending + own assigned" on requests;

create policy "requests: driver reads their own assigned requests" on requests
  for select using (driver_id = auth.uid());

-- Also unused latent surface in the same spirit: this UPDATE policy let any
-- driver blind-claim any unassigned pending request by id (RLS on UPDATE is
-- governed by UPDATE policies alone, independent of what SELECT policies
-- allow — a driver never needed to be able to *see* a row to target it here).
-- No app code path relies on this "broadcast claim" model; TowConnect only
-- ever assigns driver_id at request creation.
drop policy "requests: driver can claim a pending request" on requests;
