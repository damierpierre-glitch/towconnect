-- TowConnect — Phase 6 follow-up: a company can actually see its own people.
-- Additive, run after 0027.
--
-- FOUND BY WALKING THE SCREEN, NOT BY READING THE CODE
-- The business dashboard rendered its driver roster as "— · Hors ligne ·
-- Non assigné" for every driver: the right number of rows, none of the
-- information. Phase 5.1 correctly narrowed `profiles` to matched-request
-- participants, and Phase 6 then asked an employer to display their own
-- staff — a relationship that did not exist when that policy was written.
-- Same for driver_profiles: 0002 scoped live driver data to the driver
-- themself, an admin, or the rider on the active job. An operator's own
-- dispatcher was none of those.
--
-- WHY MANAGERS AND NOT EVERY MEMBER
-- A dispatcher needs a driver's name and phone to run the day. Another
-- driver does not. Members can already read the roster rows themselves
-- (0024), so a driver still sees who is on the team; only the personal
-- details and the live availability are narrowed to the people whose job
-- requires them. That is the smallest widening that makes the feature work,
-- which is the only kind worth making to a privacy policy.

-- A company's owner, admin or dispatcher may read the profile of an active
-- member of that same company. is_company_manager() is SECURITY DEFINER, so
-- this does not recurse through company_members' own policies.
create policy "profiles: company managers read their own roster" on profiles
  for select using (
    exists (
      select 1
      from company_members m
      where m.profile_id = profiles.id
        and m.status = 'active'
        and is_company_manager(m.company_id)
    )
  );

-- Same audience, for the availability half of the dashboard: online state,
-- approval status, heartbeat. Deliberately a SELECT-only policy — nothing
-- here lets a manager write a driver's row, so "the company forced its
-- driver online" remains impossible.
create policy "driver_profiles: company managers read their own drivers" on driver_profiles
  for select using (
    exists (
      select 1
      from company_members m
      where m.profile_id = driver_profiles.profile_id
        and m.status = 'active'
        and m.role = 'driver'
        and is_company_manager(m.company_id)
    )
  );

comment on policy "profiles: company managers read their own roster" on profiles is
  'Phase 6. An employer reads its own staff. Scoped to owner/admin/dispatcher of the SAME company — '
  'a driver still cannot read a colleague''s personal details, and nobody reads another company''s.';
