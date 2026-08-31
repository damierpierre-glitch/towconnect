-- TowConnect — Phase 3: in-app messaging between a rider and the driver
-- assigned to their request. Additive, run after 0001-0007.

create table messages (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references requests(id) on delete cascade,
  sender_id uuid not null references profiles(id) on delete cascade,
  -- A message is either free text or a quick-message template, never
  -- neither. template_key is resolved to localized text client-side (see
  -- QUICK_MESSAGES in src/lib/constants.ts) — never stored pre-resolved, so
  -- a rider and a driver each see it in their own language.
  body text,
  template_key text,
  created_at timestamptz not null default now(),
  -- Present for future read-receipt UI; deliberately not wired into any
  -- policy or app code this phase — see TOWCONNECT_PHASE3_REPORT.md.
  read_at timestamptz,
  constraint messages_body_or_template check (body is not null or template_key is not null)
);

create index messages_request_created_idx on messages(request_id, created_at);

alter table messages enable row level security;

-- Only the two participants of a request (its owner and its currently
-- assigned driver) can read its messages, plus admins. An unassigned driver
-- has driver_id = null on the request, which never equals their own
-- auth.uid() — so "a request with no driver yet lets any driver read/write
-- to it" is structurally impossible, not just discouraged.
create policy "messages: participants read" on messages
  for select using (
    exists (
      select 1 from requests r
      where r.id = messages.request_id
        and (r.user_id = auth.uid() or r.driver_id = auth.uid())
    )
    or public.is_admin()
  );

create policy "messages: participants send" on messages
  for insert with check (
    sender_id = auth.uid()
    and exists (
      select 1 from requests r
      where r.id = messages.request_id
        and (r.user_id = auth.uid() or r.driver_id = auth.uid())
    )
  );

-- No update/delete policy: messages are immutable once sent, same pattern
-- as request_events. Nobody — not even the sender — can edit or retract a
-- message after the fact in V1.

alter publication supabase_realtime add table messages;
