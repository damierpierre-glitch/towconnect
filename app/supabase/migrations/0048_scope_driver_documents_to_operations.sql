-- TowConnect — Phase 10 security review finding. Additive, run after 0047.
--
-- WHAT THE REVIEW FOUND
-- 0043 scoped the money and regulatory policies from `is_admin()` to named
-- capabilities, and 0044 removed the grandfather rule so that an admin holds
-- only what they were granted. Driver documents were missed in both.
--
-- The consequence, until this migration: an administrator granted ONLY
-- `finance` — somebody whose job is refunds and payouts — could read every
-- driver's licence, insurance certificate and vehicle registration, both the
-- metadata row and the image itself through a signed URL. Those are identity
-- documents belonging to people who never agreed to show them to the finance
-- function, and the whole point of Phase 8's capability model was that a
-- capability is a boundary rather than a label.
--
-- Nobody has exercised it: today one person holds super_admin and nobody else
-- holds a grant at all. It is fixed now because the pilot is when a second
-- administrator first becomes plausible, and because a gap found before
-- anybody used it is the cheapest kind there is.

-- ============================================================
-- 1. THE METADATA
-- ============================================================
drop policy "driver_documents: admins full access" on driver_documents;

-- Reviewing a document — approving, rejecting, setting an expiry — is
-- operations work, the same function that already owns compliance, zones and
-- dispatch.
create policy "driver_documents: operations full access" on driver_documents
  for all using (public.has_admin_capability('operations'))
  with check (public.has_admin_capability('operations'));

-- Support is deliberately absent. Support needs to know whether a driver is
-- compliant, and driver_compliance_issues() answers that without exposing a
-- single document. "Is this driver allowed to work" and "show me their
-- licence" are different questions, and only the first one is support's.

-- ============================================================
-- 2. THE FILES
-- ============================================================
-- Narrowing the table without narrowing the bucket would fix nothing: the
-- signed URL is created from the caller's own session, so the storage policy
-- is what actually decides who can open the image.
drop policy "driver-documents storage: admins read all" on storage.objects;

create policy "driver-documents storage: operations read all" on storage.objects
  for select using (
    bucket_id = 'driver-documents' and public.has_admin_capability('operations')
  );

comment on table driver_documents is
  'Identity and compliance documents. Readable by the driver who owns them and by administrators '
  'holding the operations capability - not by finance, and not by support, both of which can '
  'establish compliance through driver_compliance_issues() without seeing a document.';
