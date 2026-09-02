-- TowConnect — Phase 6.1: two gaps Phase 6 left open. Additive, run after 0029.
--
-- 1. A DISPATCHER COULD NOT SEE THEIR OWN COMPANY'S WORK
-- The Business dashboard's "Courses" tab resolved jobs through the company's
-- driver roster, because `requests` is readable only by its rider, its
-- assigned driver, or a platform admin — and a dispatcher is none of those.
-- The tab therefore came back empty for exactly the person whose job it is to
-- run the day. Phase 6 recorded that as a known limitation rather than
-- widening a policy in passing; this is the widening, done deliberately.
--
-- WHAT IT DOES AND DOES NOT EXPOSE
-- A company manager can read a request that is assigned to one of their own
-- active drivers: the service type, pickup, destination, status and price —
-- the things a dispatcher needs. It does NOT expose the customer's identity:
-- `profiles` is still governed by the Phase 5.1 rule, which requires being a
-- participant in a matched request, and a dispatcher is not a participant. So
-- a dispatcher sees the job without seeing who the customer is, which is the
-- right split for a back-office role.
--
-- There is no cross-company path: driver_company_id() resolves the driver's
-- own company from company_members, and is_company_manager() is true only for
-- an owner/admin/dispatcher of that same company. A driver with no company
-- gives NULL, and is_company_manager(NULL) is false.
create policy "requests: company managers read their company's jobs" on requests
  for select using (
    driver_id is not null
    and is_company_manager(driver_company_id(driver_id))
  );

comment on policy "requests: company managers read their company's jobs" on requests is
  'Phase 6.1. Read-only, and only for requests assigned to an active driver of the same company. '
  'Deliberately does not widen `profiles`: a dispatcher sees the job, not the customer''s identity.';

-- 2. ONTARIO REQUIRES A CERTIFICATE THAT HAD NOWHERE TO GO
-- Under the Towing and Storage Safety and Enforcement Act, 2021, an Ontario
-- tow truck driver must hold a tow driver certificate and carry it, together
-- with the operator's certificate, while operating. driver_document_type had
-- no value for that, and filing it under 'other' would have shown a driver
-- "Other document" where the law names a specific one.
--
-- Added as its own statement: Postgres refuses to use a new enum value in the
-- same transaction that adds it, so anything that references
-- 'tow_certificate' has to come after this has committed.
alter type driver_document_type add value if not exists 'tow_certificate';
