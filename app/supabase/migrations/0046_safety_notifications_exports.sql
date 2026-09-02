-- TowConnect — Phase 9: safety sharing, notifications, trusted contacts and
-- the export audit trail. Additive, run after 0045.
--
-- ONE IDEA RUNS THROUGH ALL OF IT
-- Everything here either shows somebody less than they could see, or tells
-- them something they need to know. Nothing widens a permission. The Safety
-- Link in particular is the first thing in this system readable WITHOUT an
-- account, so it gets its own minimal, hand-written projection rather than
-- access to any table.

-- ============================================================
-- 1. SAFETY LINKS
-- ============================================================
-- A person stranded at the roadside wants somebody to be able to watch. The
-- recipient has no TowConnect account and must never need one.
--
-- THE TOKEN IS NEVER STORED
-- Only its SHA-256 is. A share link is a bearer credential: anybody holding
-- the row would otherwise hold the link, and "the database was read" would
-- become "every active journey was watchable". The plaintext exists once, in
-- the response to the person who created it.
--
-- requests.id is NOT the secret and must never become one — it appears in
-- admin URLs, in support tickets and in logs.
create table safety_links (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references requests(id) on delete cascade,
  token_hash text not null unique,
  created_by uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by uuid references profiles(id) on delete set null,
  -- Whether anybody actually opened it. The customer is entitled to know.
  view_count integer not null default 0,
  last_viewed_at timestamptz
);

create index safety_links_request_idx on safety_links(request_id, created_at desc);
-- One live link per journey. Regenerating revokes the old one first, so a
-- link somebody was given cannot silently keep working beside a new one.
create unique index safety_links_one_live_per_request
  on safety_links(request_id) where revoked_at is null;

alter table safety_links enable row level security;

-- The customer manages their own links. Nobody reads the hash through the
-- API: the view function below is the only path, and it takes a token.
create policy "safety links: customer manages their own" on safety_links
  for all using (
    exists (select 1 from requests r where r.id = safety_links.request_id and r.user_id = auth.uid())
  )
  with check (
    exists (select 1 from requests r where r.id = safety_links.request_id and r.user_id = auth.uid())
  );

create policy "safety links: support and operations read" on safety_links
  for select using (
    public.has_admin_capability('support') or public.has_admin_capability('operations')
  );

-- How long a link outlives the job it describes. An engineering constant,
-- labelled as one: no retention period has been agreed, and a number invented
-- here would be quoted back as policy. Configurable through ops_thresholds.
insert into ops_thresholds (key, value_seconds, origin, description) values
  ('safety_link_lifetime', 21600, 'engineering',
   'How long a Safety Link stays valid: 6 hours from creation, and it stops working once the job '
   'ends plus safety_link_grace. An engineering default, not an agreed retention policy.'),
  ('safety_link_grace', 1800, 'engineering',
   'How long a Safety Link keeps working after the job finishes, so the person watching sees it '
   'end rather than the page simply dying. Engineering default.')
on conflict (key) do nothing;

-- ============================================================
-- safety_link_view() — the entire public surface
-- ============================================================
-- Not a view over tables and not RLS on `requests`: a hand-written projection
-- of exactly the fields somebody watching a rescue needs. Anything not listed
-- here cannot leak, because it is not selected.
--
-- Deliberately absent: any phone number, any money, the saved home address,
-- other jobs, internal notes, driver documents, risk flags, incidents,
-- company internals, TowConnect's margin.
create or replace function safety_link_view(p_token text)
returns table (
  status text,
  operational_state text,
  pickup_lat double precision,
  pickup_lng double precision,
  destination_address text,
  destination_lat double precision,
  destination_lng double precision,
  problem_type text,
  driver_first_name text,
  driver_lat double precision,
  driver_lng double precision,
  driver_location_age_seconds integer,
  company_name text,
  vehicle_type text,
  license_plate text,
  regulated_state text,
  created_at timestamptz,
  expires_at timestamptz
)
language plpgsql
volatile
security definer set search_path = public
as $$
declare
  v_link public.safety_links;
  v_request public.requests;
begin
  -- Compare on the hash. A token that does not resolve is simply not found;
  -- there is no distinction between "wrong", "revoked" and "expired" in what
  -- comes back, because that distinction is only useful to somebody guessing.
  --
  -- EVERY COLUMN IS QUALIFIED. This function's OUT parameters are named after
  -- the very columns it reads (`status`, `expires_at`, `created_at`), and an
  -- unqualified reference resolves to the parameter, not the column — which
  -- fails at runtime, not at creation.
  select sl.* into v_link
  from public.safety_links sl
  where sl.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
    and sl.revoked_at is null
    and sl.expires_at > now();
  if not found then
    return;
  end if;

  select r.* into v_request from public.requests r where r.id = v_link.request_id;
  if not found then
    return;
  end if;

  update public.safety_links sl
  set view_count = sl.view_count + 1, last_viewed_at = now()
  where sl.id = v_link.id;

  return query
  select
    v_request.status::text,
    -- The same operational vocabulary the command centre uses, so a customer
    -- and an operator are looking at the same fact.
    case
      when v_request.status = 'pending'
        and v_request.regulated_dispatch_state = 'restricted_capacity_wait' then 'restricted_capacity_wait'
      when v_request.status = 'pending'
        and v_request.regulated_dispatch_state = 'awaiting_external_authority' then 'awaiting_external_authority'
      when v_request.status = 'pending' and exists (
        select 1 from public.dispatch_offers o
        where o.request_id = v_request.id and o.status = 'offered' and o.expires_at > now()
      ) then 'searching'
      else v_request.status::text
    end,
    v_request.lat,
    v_request.lng,
    v_request.destination_address,
    v_request.destination_lat,
    v_request.destination_lng,
    v_request.problem_type,
    -- First name only. Enough to recognise who is arriving, and nothing that
    -- follows the driver around the internet afterwards.
    case
      when v_request.driver_id is null then null
      else split_part(coalesce(nullif(p.full_name, ''), 'Driver'), ' ', 1)
    end,
    dp.current_lat,
    dp.current_lng,
    case
      when dp.last_heartbeat_at is null then null
      else extract(epoch from (now() - dp.last_heartbeat_at))::integer
    end,
    coalesce(c.display_name, c.name),
    dp.vehicle_type::text,
    dp.license_plate,
    v_request.regulated_dispatch_state::text,
    v_request.created_at,
    v_link.expires_at
  from (select 1) as _
  left join public.profiles p on p.id = v_request.driver_id
  left join public.driver_profiles dp on dp.profile_id = v_request.driver_id
  left join public.companies c on c.id = public.driver_company_id(v_request.driver_id);
end;
$$;

revoke all on function safety_link_view(text) from public;
-- anon is the point: the recipient has no account.
grant execute on function safety_link_view(text) to anon, authenticated, service_role;

comment on function safety_link_view(text) is
  'The entire public surface of a Safety Link. A hand-written projection, not a view over tables: '
  'anything not selected here cannot leak. Takes the token, never a request id.';

-- ============================================================
-- 2. NOTIFICATIONS
-- ============================================================
-- Stored as a type plus a payload, never as pre-rendered text — the same
-- reasoning as messages.template_key (0008): a rider and a driver read the
-- same event in their own language.
create type notification_type as enum (
  'driver_found',
  'driver_en_route',
  'driver_arrived',
  'job_in_progress',
  'job_completed',
  'job_cancelled',
  'message_received',
  'supplement_proposed',
  'supplement_needs_authentication',
  'payment_action_required',
  'refund_issued'
);

-- Which notifications a person may switch off, and which they may not.
-- Turning off "your driver has arrived" during an active rescue would break
-- the journey the product exists to deliver, so those categories are not
-- offered as a choice at all.
create type notification_category as enum ('job_progress', 'messages', 'payment', 'account');

create table notifications (
  id bigserial primary key,
  recipient_id uuid not null references profiles(id) on delete cascade,
  type notification_type not null,
  category notification_category not null,
  request_id uuid references requests(id) on delete cascade,
  -- Facts the renderer needs (a driver's first name, an amount), never a
  -- finished sentence.
  payload jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index notifications_unread_idx
  on notifications(recipient_id, created_at desc)
  where read_at is null;
create index notifications_recipient_idx on notifications(recipient_id, created_at desc);
create index notifications_request_idx on notifications(request_id) where request_id is not null;

alter table notifications enable row level security;

-- A notification is visible to exactly one person. There is no admin policy:
-- support reads the job, not somebody's inbox.
create policy "notifications: recipient reads own" on notifications
  for select using (recipient_id = auth.uid());
create policy "notifications: recipient marks own read" on notifications
  for update using (recipient_id = auth.uid()) with check (recipient_id = auth.uid());
-- No INSERT policy for anybody: notifications are written by triggers and by
-- trusted server code, so nobody can put a message in someone else's inbox.

-- Only read_at may change. A notification whose text could be rewritten after
-- delivery is not a record of anything.
create or replace function guard_notification_immutable()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if new.type is distinct from old.type
     or new.category is distinct from old.category
     or new.recipient_id is distinct from old.recipient_id
     or new.request_id is distinct from old.request_id
     or new.payload is distinct from old.payload
     or new.created_at is distinct from old.created_at then
    raise exception 'A notification records an event; only its read state may change'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger notifications_guard_immutable
  before update on notifications
  for each row execute procedure guard_notification_immutable();

create table notification_preferences (
  profile_id uuid not null references profiles(id) on delete cascade,
  category notification_category not null,
  in_app boolean not null default true,
  push boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (profile_id, category)
);

alter table notification_preferences enable row level security;
create policy "notification preferences: own" on notification_preferences
  for all using (profile_id = auth.uid()) with check (profile_id = auth.uid());

-- The two categories that carry an active rescue cannot be switched off
-- in-app. Not a UI decision — a person who silenced "your driver has arrived"
-- three months ago must not miss it tonight.
create or replace function guard_critical_notification_categories()
returns trigger
language plpgsql
as $$
begin
  if new.category in ('job_progress', 'payment') and new.in_app = false then
    raise exception 'Notifications about an active job and its payment cannot be switched off in-app'
      using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger notification_preferences_guard_critical
  before insert or update on notification_preferences
  for each row execute procedure guard_critical_notification_categories();

-- ============================================================
-- notify() — one writer, used by every trigger below
-- ============================================================
create or replace function notify_user(
  p_recipient uuid,
  p_type notification_type,
  p_category notification_category,
  p_request_id uuid,
  p_payload jsonb
)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if p_recipient is null then
    return;
  end if;
  -- Respect the preference where one exists and the category allows it.
  if exists (
    select 1 from notification_preferences np
    where np.profile_id = p_recipient and np.category = p_category and np.in_app = false
  ) then
    return;
  end if;
  insert into notifications (recipient_id, type, category, request_id, payload)
  values (p_recipient, p_type, p_category, p_request_id, coalesce(p_payload, '{}'::jsonb));
end;
$$;

revoke all on function notify_user(uuid, notification_type, notification_category, uuid, jsonb) from public;
grant execute on function notify_user(uuid, notification_type, notification_category, uuid, jsonb) to service_role;

-- ---- emitted from the same place the fact is recorded -------------------
-- On `requests` itself, exactly like request_events (0001): a trigger on the
-- table captures every path to a status, including the ones the application
-- forgot about.
create or replace function notify_on_request_status()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_driver_name text;
begin
  if tg_op <> 'UPDATE' or new.status is not distinct from old.status then
    return new;
  end if;

  select split_part(coalesce(nullif(p.full_name, ''), 'Driver'), ' ', 1)
  into v_driver_name
  from profiles p where p.id = new.driver_id;

  if new.status = 'matched' then
    perform notify_user(new.user_id, 'driver_found', 'job_progress', new.id,
                        jsonb_build_object('driver_first_name', v_driver_name));
  elsif new.status = 'en_route' then
    perform notify_user(new.user_id, 'driver_en_route', 'job_progress', new.id,
                        jsonb_build_object('driver_first_name', v_driver_name));
  elsif new.status = 'arrived' then
    perform notify_user(new.user_id, 'driver_arrived', 'job_progress', new.id,
                        jsonb_build_object('driver_first_name', v_driver_name));
  elsif new.status = 'in_progress' then
    perform notify_user(new.user_id, 'job_in_progress', 'job_progress', new.id, '{}'::jsonb);
  elsif new.status = 'completed' then
    perform notify_user(new.user_id, 'job_completed', 'job_progress', new.id, '{}'::jsonb);
  elsif new.status = 'cancelled' then
    -- The driver is told too: they may be on their way to it.
    perform notify_user(new.driver_id, 'job_cancelled', 'job_progress', new.id, '{}'::jsonb);
  end if;

  return new;
end;
$$;

create trigger requests_notify_status
  after update on requests
  for each row execute procedure notify_on_request_status();

create or replace function notify_on_message()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_request requests;
  v_recipient uuid;
begin
  select * into v_request from requests where id = new.request_id;
  if not found then
    return new;
  end if;
  -- Whoever did not send it.
  v_recipient := case when new.sender_id = v_request.user_id then v_request.driver_id else v_request.user_id end;
  perform notify_user(v_recipient, 'message_received', 'messages', new.request_id, '{}'::jsonb);
  return new;
end;
$$;

create trigger messages_notify
  after insert on messages
  for each row execute procedure notify_on_message();

create or replace function notify_on_supplement()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_request requests;
begin
  select * into v_request from requests where id = new.request_id;
  if not found then
    return new;
  end if;

  if tg_op = 'INSERT' and new.status = 'proposed' then
    perform notify_user(v_request.user_id, 'supplement_proposed', 'payment', new.request_id,
                        jsonb_build_object('amount', new.amount, 'type_key', new.type_key));
  elsif tg_op = 'UPDATE'
        and new.payment_state = 'requires_action'
        and old.payment_state is distinct from 'requires_action' then
    perform notify_user(v_request.user_id, 'supplement_needs_authentication', 'payment', new.request_id,
                        jsonb_build_object('amount', new.amount, 'type_key', new.type_key));
  end if;
  return new;
end;
$$;

create trigger request_supplements_notify
  after insert or update on request_supplements
  for each row execute procedure notify_on_supplement();

create or replace function notify_on_refund()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_request requests;
begin
  if new.status <> 'succeeded' or (tg_op = 'UPDATE' and old.status = 'succeeded') then
    return new;
  end if;
  select * into v_request from requests where id = new.request_id;
  if found then
    perform notify_user(v_request.user_id, 'refund_issued', 'payment', new.request_id,
                        jsonb_build_object('amount', new.amount));
  end if;
  return new;
end;
$$;

create trigger refunds_notify
  after insert or update on refunds
  for each row execute procedure notify_on_refund();

-- ============================================================
-- 3. TRUSTED CONTACTS — remembered, never auto-shared
-- ============================================================
-- Somewhere to keep the person you would send a Safety Link to. Storing a
-- contact grants that contact nothing: sharing stays an explicit act, every
-- time, because "my sister can see all my journeys forever" is a different
-- product decision and nobody has made it.
create table trusted_contacts (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  label text not null check (length(btrim(label)) > 0),
  phone text,
  email text,
  created_at timestamptz not null default now(),
  check (phone is not null or email is not null)
);

create index trusted_contacts_profile_idx on trusted_contacts(profile_id, created_at);

alter table trusted_contacts enable row level security;
create policy "trusted contacts: own" on trusted_contacts
  for all using (profile_id = auth.uid()) with check (profile_id = auth.uid());

-- ============================================================
-- 4. EXPORT AUDIT
-- ============================================================
-- What was taken out of the system, by whom, under which capability. The
-- FILE is never stored: keeping a copy of every export would turn the audit
-- trail into a second, unguarded copy of the data it exists to police.
create table export_audit (
  id bigserial primary key,
  actor_id uuid not null references profiles(id) on delete set null,
  capability admin_capability not null,
  dataset text not null,
  format text not null check (format in ('csv', 'xlsx')),
  filters jsonb not null default '{}'::jsonb,
  row_count integer not null,
  created_at timestamptz not null default now()
);

create index export_audit_actor_idx on export_audit(actor_id, created_at desc);
create index export_audit_created_idx on export_audit(created_at desc);

alter table export_audit enable row level security;

-- Readable by super admins only: who exported what is itself sensitive.
create policy "export audit: super admins read" on export_audit
  for select using (public.has_admin_capability('super_admin'));
-- No INSERT policy: written by the export path through the service role.

comment on table export_audit is
  'Every sensitive export, with who ran it and under which capability. The file itself is never '
  'stored — a log holding copies of exports would be a second unguarded copy of the data.';
