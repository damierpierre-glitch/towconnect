-- TowConnect — Phase 8.1: no capability now means no capability. Additive,
-- run after 0043.
--
-- WHAT 0041 DID, AND WHY IT COULD NOT STAY
-- has_admin_capability() treated "this admin holds no grant at all" as "this
-- admin holds everything". That was a migration strategy, not a permission
-- model: it let fine-grained roles be introduced without locking out the
-- people who run the platform, and it worked.
--
-- It also had a consequence nobody would ever choose deliberately: revoking
-- somebody's LAST capability handed them full access. An administrator being
-- wound down to nothing became an administrator with everything. Least
-- privilege that inverts at zero is not least privilege.
--
-- THE ORDER OF THE TWO STEPS BELOW IS THE WHOLE MIGRATION
-- Step 1 grants super_admin to every existing administrator.
-- Step 2 removes the fallback.
--
-- Reversing them would, for the duration of one statement, leave every
-- administrator of this platform with no access to it — including the only
-- account that can grant capabilities back. The grant has to exist before the
-- rule that requires it does.

-- ============================================================
-- Step 1 — make the implicit access explicit
-- ============================================================
-- Every account that is an admin TODAY keeps exactly what it has today, said
-- out loud. `on conflict do nothing` so re-running changes nothing, and
-- granted_by is NULL because no person granted these: the migration did, and
-- pretending otherwise would put a name against a decision nobody made.
insert into admin_grants (profile_id, capability, note)
select p.id, 'super_admin',
       'Granted by migration 0044: made explicit what the grandfather rule was giving implicitly.'
from profiles p
where p.role = 'admin'
on conflict (profile_id, capability) do nothing;

-- ============================================================
-- Step 2 — remove the fallback
-- ============================================================
-- Now, and only now, "no grant" means what it says.
create or replace function public.has_admin_capability(p_capability admin_capability)
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select
    coalesce(public.is_admin(), false)
    and exists (
      select 1 from admin_grants g
      where g.profile_id = auth.uid()
        and g.capability in (p_capability, 'super_admin')
    );
$$;

revoke all on function public.has_admin_capability(admin_capability) from public;
grant execute on function public.has_admin_capability(admin_capability) to authenticated, service_role;

comment on function public.has_admin_capability(admin_capability) is
  'True when the caller is an admin AND holds this capability, or holds super_admin. An admin with '
  'no grants holds nothing: revoking the last capability revokes access, which is the point. The '
  '0041 grandfather rule was removed in 0044, after every existing administrator had been granted '
  'super_admin explicitly.';

-- ============================================================
-- A platform with no super_admin cannot be administered
-- ============================================================
-- Not a foreign key and not a trigger on admin_grants — a constraint that
-- fires on the last DELETE would be a footgun of its own, and there are
-- legitimate reasons to move the last grant between accounts inside one
-- transaction. This is a question an operator (and verify:operations) can ask.
create or replace function ops_super_admin_count()
returns integer
language sql
stable
security definer set search_path = public
as $$
  select count(*)::integer
  from admin_grants g
  join profiles p on p.id = g.profile_id
  where g.capability = 'super_admin' and p.role = 'admin';
$$;

revoke all on function ops_super_admin_count() from public;
grant execute on function ops_super_admin_count() to authenticated, service_role;

comment on function ops_super_admin_count() is
  'How many administrators can still grant capabilities. Zero means the platform can no longer be '
  'administered by anybody, which is recoverable only with the service role.';
