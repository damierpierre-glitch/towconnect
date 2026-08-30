-- Fix: infinite recursion in RLS policy "profiles: admins read all".
-- Its subquery selected from profiles itself, which re-triggered the same
-- policy, causing Postgres error 42P17 on every authenticated profile read
-- (including the user's own row via "profiles: read own", since Postgres
-- evaluates all applicable SELECT policies and OR-combines them).
-- driver_profiles/requests/request_events had the same inline admin check
-- and would hit the same recursion indirectly (via their own subquery into
-- profiles), so they're fixed the same way for consistency and safety.

create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  );
$$;

grant execute on function public.is_admin() to authenticated;

drop policy "profiles: admins read all" on profiles;
create policy "profiles: admins read all" on profiles
  for select using (public.is_admin());

drop policy "driver_profiles: admins full access" on driver_profiles;
create policy "driver_profiles: admins full access" on driver_profiles
  for all using (public.is_admin());

drop policy "requests: admins full access" on requests;
create policy "requests: admins full access" on requests
  for all using (public.is_admin());

drop policy "request_events: visible to request participants" on request_events;
create policy "request_events: visible to request participants" on request_events
  for select using (
    exists (
      select 1 from requests r
      where r.id = request_events.request_id
        and (r.user_id = auth.uid() or r.driver_id = auth.uid())
    )
    or public.is_admin()
  );
