-- TowConnect — Phase 5: driver document verification (license, insurance,
-- registration, ...) and a reason field for a rejected application. Additive,
-- run after 0001-0018.
--
-- Trust model, same shape as payments (0013): the row a rider or driver
-- reads is never the row they can freely write. A driver may see and add
-- their own documents, but only an admin (or the service role) may change a
-- document's status — there is no UPDATE policy for a driver's own session
-- at all, the same "structurally impossible, not just discouraged by the
-- UI" pattern payments uses. Re-review after a rejection means uploading a
-- new document row, not editing the old one; the rejected row stays as the
-- record of what was reviewed and why.

create type driver_document_type as enum ('license', 'insurance', 'registration', 'other');
create type driver_document_status as enum ('pending', 'approved', 'rejected', 'expired');

create table driver_documents (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references profiles(id) on delete cascade,
  type driver_document_type not null,
  -- Path inside the `driver-documents` Storage bucket, always
  -- "<driver_id>/<uuid>.<ext>" — enforced by the storage policies below, not
  -- just convention, since it's what those policies key their own checks on.
  storage_path text not null unique,
  status driver_document_status not null default 'pending',
  rejection_reason text,
  -- Optional and driver-supplied (e.g. a license's printed expiry date).
  -- Nothing server-side currently acts on this — see the note on 'expired'
  -- below.
  expires_at date,
  uploaded_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references profiles(id)
);

create index driver_documents_driver_idx on driver_documents(driver_id, uploaded_at desc);

alter table driver_documents enable row level security;

create policy "driver_documents: driver reads own" on driver_documents
  for select using (auth.uid() = driver_id);

-- A driver may add a document, but only ever as a fresh, unreviewed one —
-- the WITH CHECK below rejects any insert that tries to arrive pre-approved
-- or with review fields already filled in.
create policy "driver_documents: driver inserts own pending" on driver_documents
  for insert with check (
    auth.uid() = driver_id
    and status = 'pending'
    and reviewed_at is null
    and reviewed_by is null
  );

-- A driver may withdraw a document they uploaded by mistake, or a rejected
-- one before re-submitting — but never one an admin has already approved.
-- That row is the verification record; deleting it would let a driver erase
-- evidence of what was actually checked.
create policy "driver_documents: driver deletes own non-approved" on driver_documents
  for delete using (auth.uid() = driver_id and status <> 'approved');

create policy "driver_documents: admins full access" on driver_documents
  for all using (public.is_admin());

-- ============================================================
-- 'expired' is deliberately not enforced by anything server-side yet: there
-- is no scheduled job that walks expires_at and flips status, and adding one
-- means touching the Edge Function / cron surface this phase does not
-- authorize changing. The status value exists so the UI can compute and
-- display "this is past its expiry date" from expires_at without a backend
-- change, and so a future scheduled job has a real value to write into
-- rather than needing its own migration. See TOWCONNECT_PHASE5_REPORT.md.
-- ============================================================

-- ============================================================
-- Storage: a private bucket, one folder per driver. Every policy below keys
-- off the first path segment matching the caller's own auth.uid() — nobody
-- can read or write outside their own folder, admins excepted.
-- ============================================================
insert into storage.buckets (id, name, public)
values ('driver-documents', 'driver-documents', false)
on conflict (id) do nothing;

create policy "driver-documents storage: owner reads own" on storage.objects
  for select using (
    bucket_id = 'driver-documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "driver-documents storage: owner uploads own" on storage.objects
  for insert with check (
    bucket_id = 'driver-documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Mirrors the driver_documents table policy above: cannot delete the file
-- behind an approved document. Only reachable if a driver_documents row
-- already references this path (the normal case); an orphaned upload with
-- no row yet — e.g. the driver_documents insert failed right after a
-- successful file upload — can still be cleaned up by its owner.
create policy "driver-documents storage: owner deletes own non-approved" on storage.objects
  for delete using (
    bucket_id = 'driver-documents'
    and (storage.foldername(name))[1] = auth.uid()::text
    and not exists (
      select 1 from driver_documents dd
      where dd.storage_path = storage.objects.name and dd.status = 'approved'
    )
  );

create policy "driver-documents storage: admins read all" on storage.objects
  for select using (bucket_id = 'driver-documents' and public.is_admin());

-- ============================================================
-- Application-level rejection reason, alongside the document-level one
-- above — this one is for the account as a whole ("why wasn't I approved"),
-- shown on the driver's profile page.
-- ============================================================
alter table driver_profiles
  add column rejection_reason text;

-- Same privileged-field guard as approval_status/rating/total_services
-- (0003, extended for service_role in 0016) — a driver must not be able to
-- write their own rejection reason any more than they can write their own
-- approval_status. Extending the existing trigger function rather than
-- adding a second one, for the same reason 0016 did: one place, one set of
-- rules, and CREATE OR REPLACE is exactly how this function has been
-- evolved twice already.
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
  ) and not exists (
    select 1 from profiles p where p.id = auth.uid() and p.role = 'admin'
  ) then
    raise exception 'Only an admin can change approval_status, rating, total_services, or rejection_reason'
      using errcode = '42501';
  end if;

  return new;
end;
$$;
