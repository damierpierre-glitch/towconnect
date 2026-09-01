-- TowConnect — Phase 5.1: close the profile leak found while writing the
-- Phase 5 report. Additive, run after 0001-0021.
--
-- THE DEFECT
-- "profiles: request participants read each other" (0001_init.sql) grants a
-- mutual profile read to anyone on either side of a request:
--
--     (r.user_id = profiles.id or r.driver_id = profiles.id)
--     and (r.user_id = auth.uid() or r.driver_id = auth.uid())
--
-- That was written when a request only ever got a driver_id at acceptance.
-- Smart Dispatch (0006) changed the timing underneath it:
-- dispatch_next_candidate_core() sets `requests.driver_id` when it makes the
-- OFFER, while status is still 'pending' —
--
--     update requests set driver_id = v_best.profile_id where id = p_request_id;
--
-- so a driver who has merely been offered a job already satisfies
-- `r.driver_id = auth.uid()` and can read the rider's full profile — name and
-- phone number — before accepting, and keeps that access for the whole 18s
-- window even if they decline. The UI never shows it; the database allowed
-- it, which is the part that counts. It is symmetric, so the same policy also
-- let a rider read an offered driver's profile row before that driver had
-- agreed to anything.
--
-- WHY NOT JUST `status <> 'pending'`
-- Because driver_id deliberately survives past the offer stage on two paths
-- that never reached acceptance:
--   * expire_offer_on_cancel() (0006) explicitly leaves driver_id in place
--     when a rider cancels — "harmless once status isn't 'pending'".
--   * cleanup_stale() (0002) flips a stale 'pending' request to 'expired'
--     and does not touch driver_id either.
-- A driver who was offered a job and never took it would therefore still
-- gain the rider's profile the moment that request expired or was cancelled.
-- Filtering on status alone moves the leak, it doesn't close it.
--
-- THE DISCRIMINATOR
-- The only fact that actually separates "was offered this job" from "took
-- this job" is whether the request ever reached 'matched'. request_events
-- records exactly that, written by log_request_status_change() — a trigger on
-- `requests` itself, so it captures every path to 'matched' (respond_to_
-- dispatch_offer, a direct accept_request() call, an admin assignment) rather
-- than trusting one function to have bookkept correctly. It is also
-- append-only, so the evidence survives the request moving on to completed,
-- or being cancelled after the driver was already on the job — which is what
-- keeps the receipt and driver-history screens working.
--
-- WHAT THIS DELIBERATELY DOES NOT CHANGE
-- Nothing about dispatch, offers, acceptance, messaging or status
-- transitions. The offer card needs the service type, vehicle description,
-- pickup, destination and distances — all of which live on `requests`, whose
-- own policies are untouched. No application code has to change for this to
-- hold; the database is the enforcement.

-- request_events had no index at all. This policy adds an EXISTS against it
-- to every profiles read, so give it the one it needs first.
create index if not exists request_events_request_status_idx
  on request_events (request_id, status);

drop policy "profiles: request participants read each other" on profiles;

create policy "profiles: matched request participants read each other" on profiles
  for select using (
    exists (
      select 1
      from requests r
      where (r.user_id = profiles.id or r.driver_id = profiles.id)
        and (r.user_id = auth.uid() or r.driver_id = auth.uid())
        and exists (
          select 1
          from request_events e
          where e.request_id = r.id
            and e.status = 'matched'
        )
    )
  );
