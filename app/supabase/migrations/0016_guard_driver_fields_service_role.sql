-- TowConnect — fix found by the first live run of the RLS integration suite
-- (TOWCONNECT_LIVE_VALIDATION_REPORT.md). Additive, run after 0001-0015.
--
-- THE DEFECT
-- guard_driver_privileged_fields() (0003) blocks any change to
-- approval_status / rating / total_services unless the caller is an admin,
-- decided with:
--     not exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'admin')
--
-- Under the service role, auth.uid() is NULL, so that subquery finds nothing
-- and the guard raises 42501. Net effect: the service role — the one
-- identity that legitimately acts as the system — is the single identity
-- that CANNOT approve a driver.
--
-- Why it went unnoticed until now: the in-app admin flow (approveDriver() in
-- lib/actions/admin.ts) runs under the admin *user's* session, where
-- auth.uid() does resolve to an admin profile, so it works. Only
-- service-role callers are affected: back-office/automation scripts, Edge
-- Functions, and the RLS integration harness — which silently produced
-- never-approved, never-online drivers and made ~12 Smart Dispatch
-- assertions fail for what looked like dispatch bugs.
--
-- THE FIX
-- Exempt the service role explicitly, exactly as the two later guards
-- already do: guard_stripe_customer_id() (0013) and
-- guard_request_protected_fields() (0014) both short-circuit on
-- auth.role() = 'service_role'. This restores that consistency; 0003 simply
-- predates the pattern.
--
-- Not a weakening: the service role key is server-only (never shipped to a
-- browser — see lib/supabase/admin.ts and the bundle scan in the report),
-- and anything holding it can already bypass RLS entirely, so refusing it
-- here bought no security while breaking legitimate system writes.
create or replace function guard_driver_privileged_fields()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  -- Set (transaction-local) by bump_driver_total_services() when it performs
  -- the one legitimate system write to total_services.
  if current_setting('towconnect.internal_update', true) = 'true' then
    return new;
  end if;

  -- The system itself, acting server-side.
  if auth.role() = 'service_role' then
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
