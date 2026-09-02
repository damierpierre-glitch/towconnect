-- TowConnect — Phase 8: the operational layer. Additive, run after 0040.
--
-- WHAT THIS IS FOR
-- Everything here exists to answer one question an operator asks all day:
-- "what needs me right now?" Not "how are we doing" — there is no vanity
-- metric in this migration. Each table records a fact somebody has to act on,
-- or the permission to act on it.
--
-- ============================================================
-- 1. FINER ADMIN ROLES — as data, not as a new enum value
-- ============================================================
-- Adding 'operations' / 'finance' / 'support' to user_role would touch
-- handle_new_user(), roleHome(), and every policy keyed on role — for roles
-- nobody holds yet. The same reasoning produced refund_authorizers in 0036,
-- and this generalises it.
--
-- THE GRANDFATHER RULE, AND WHY IT IS THE SAFE DIRECTION
-- Today every admin can do everything, and nobody holds a grant. If "no grant"
-- meant "no access", this migration would instantly lock every existing
-- administrator out of the platform they run. So an admin with NO grants keeps
-- full access, exactly as before; the moment somebody is given their first
-- grant, they are scoped to what they were given. Narrowing is opt-in and
-- explicit, which is the only way to narrow a live system safely.
create type admin_capability as enum (
  'super_admin',  -- everything, including granting capabilities
  'operations',   -- dispatch, drivers, documents, zones, incidents
  'finance',      -- refunds, payouts, pricing configuration
  'support'       -- read-only lookup and timeline; moves no money
);

create table admin_grants (
  profile_id uuid not null references profiles(id) on delete cascade,
  capability admin_capability not null,
  granted_by uuid references profiles(id),
  granted_at timestamptz not null default now(),
  note text,
  primary key (profile_id, capability)
);

alter table admin_grants enable row level security;

-- Defined before the policies that use it: a policy body is validated at
-- creation time, and the function body reads admin_grants, so the order is
-- table -> function -> policies and cannot be anything else.
create or replace function public.has_admin_capability(p_capability admin_capability)
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select
    coalesce(public.is_admin(), false)
    and (
      -- Grandfathered: an admin nobody has scoped yet keeps full access.
      not exists (select 1 from admin_grants g where g.profile_id = auth.uid())
      or exists (
        select 1 from admin_grants g
        where g.profile_id = auth.uid()
          and g.capability in (p_capability, 'super_admin')
      )
    );
$$;

revoke all on function public.has_admin_capability(admin_capability) from public;
grant execute on function public.has_admin_capability(admin_capability) to authenticated, service_role;

comment on function public.has_admin_capability(admin_capability) is
  'True when the caller is an admin AND either holds this capability (or super_admin), or holds no '
  'grant at all — the grandfather rule that keeps existing administrators working until somebody '
  'deliberately scopes them.';

-- Only a super admin may hand out capabilities — and, while nobody holds any
-- grant at all, any admin may, otherwise the first grant could never be made.
create policy "admin grants: admins read" on admin_grants
  for select using (public.is_admin());
create policy "admin grants: super admins write" on admin_grants
  for all using (public.has_admin_capability('super_admin'))
  with check (public.has_admin_capability('super_admin'));

-- Moving money is finance. 0036 defined this as "any admin"; now it is any
-- admin who has not been scoped away from finance, plus the explicit
-- refund_authorizers list that 0036 created for a future finance team.
create or replace function is_refund_authorizer()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select public.has_admin_capability('finance')
      or exists (select 1 from refund_authorizers a where a.profile_id = auth.uid());
$$;

-- ============================================================
-- 2. OPERATIONAL INCIDENTS
-- ============================================================
-- Deliberately small. This is a place to record "a human needs to look at
-- this" and what came of it — not an ITSM. There are no SLAs, no priorities
-- beyond severity, no escalation chains, because none of those have been
-- decided and a field nobody fills in is worse than no field.
create type incident_type as enum (
  'dispatch_failure',
  'payment_issue',
  'customer_safety',
  'driver_issue',
  'regulatory_issue',
  'fraud_suspected',
  'technical_issue'
);

create type incident_severity as enum ('low', 'medium', 'high', 'critical');
create type incident_status as enum ('open', 'investigating', 'resolved', 'dismissed');

create table operational_incidents (
  id uuid primary key default gen_random_uuid(),
  type incident_type not null,
  severity incident_severity not null default 'medium',
  status incident_status not null default 'open',

  -- Every link is nullable: an incident can be about a request, a company, a
  -- driver, a payment, several of those, or none of them (a technical issue
  -- with no single subject is still an incident).
  request_id uuid references requests(id) on delete set null,
  company_id uuid references companies(id) on delete set null,
  driver_id uuid references profiles(id) on delete set null,
  payment_id uuid references payments(id) on delete set null,

  title text not null check (length(btrim(title)) > 0),
  description text,
  assigned_admin uuid references profiles(id) on delete set null,

  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolution_note text
);

create index operational_incidents_open_idx
  on operational_incidents(created_at desc)
  where status in ('open', 'investigating');
create index operational_incidents_request_idx on operational_incidents(request_id)
  where request_id is not null;
create index operational_incidents_company_idx on operational_incidents(company_id)
  where company_id is not null;
create index operational_incidents_driver_idx on operational_incidents(driver_id)
  where driver_id is not null;

create trigger operational_incidents_set_updated_at
  before update on operational_incidents
  for each row execute procedure extensions.moddatetime(updated_at);

alter table operational_incidents enable row level security;

-- INTERNAL. A customer must never learn that they are the subject of a fraud
-- incident, and a driver must never read the note about their own conduct.
-- There is no policy for them at all, which is stronger than a filter.
create policy "incidents: operations and support read" on operational_incidents
  for select using (
    public.has_admin_capability('operations') or public.has_admin_capability('support')
  );
create policy "incidents: operations write" on operational_incidents
  for all using (public.has_admin_capability('operations'))
  with check (public.has_admin_capability('operations'));

-- The history of an incident is append-only: "who changed this to dismissed,
-- and when" is exactly the thing somebody will want six months later.
create table incident_events (
  id bigserial primary key,
  incident_id uuid not null references operational_incidents(id) on delete cascade,
  from_status incident_status,
  to_status incident_status not null,
  note text,
  actor_id uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index incident_events_incident_idx on incident_events(incident_id, created_at);

alter table incident_events enable row level security;
create policy "incident events: operations and support read" on incident_events
  for select using (
    public.has_admin_capability('operations') or public.has_admin_capability('support')
  );
-- No INSERT policy: written by the trigger below, which runs as definer.

create or replace function log_incident_status_change()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into incident_events (incident_id, from_status, to_status, note, actor_id)
    values (new.id, null, new.status, 'opened', auth.uid());
    return new;
  end if;

  if new.status is distinct from old.status then
    insert into incident_events (incident_id, from_status, to_status, note, actor_id)
    values (new.id, old.status, new.status, new.resolution_note, auth.uid());
  end if;
  return new;
end;
$$;

create trigger operational_incidents_log_status
  after insert or update on operational_incidents
  for each row execute procedure log_incident_status_change();

-- resolved_at is derived from the status, not typed in beside it: two fields
-- that can disagree eventually do.
create or replace function sync_incident_resolved_at()
returns trigger
language plpgsql
as $$
begin
  if new.status in ('resolved', 'dismissed') and old.status not in ('resolved', 'dismissed') then
    new.resolved_at := now();
  elsif new.status in ('open', 'investigating') then
    new.resolved_at := null;
  end if;
  return new;
end;
$$;

create trigger operational_incidents_sync_resolved
  before update on operational_incidents
  for each row execute procedure sync_incident_resolved_at();

-- ============================================================
-- 3. RISK FLAGS — signals, never verdicts
-- ============================================================
-- Objective, countable observations only. No score, no model, and nothing
-- here bans anybody: a flag is a reason for a person to look, and the row
-- records what was observed so that person can disagree with it.
create type risk_flag_kind as enum (
  'repeated_refunds',
  'repeated_cancellations',
  'repeated_payment_failures',
  'shared_payment_method',
  'driver_behaviour_anomaly'
);

create table risk_flags (
  id bigserial primary key,
  kind risk_flag_kind not null,
  subject_profile_id uuid references profiles(id) on delete cascade,
  subject_company_id uuid references companies(id) on delete cascade,
  -- The numbers behind the signal, so a human can check the arithmetic
  -- instead of trusting the label.
  observation jsonb not null,
  note text,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  -- An acknowledged flag stays on the record. Dismissing it is a new fact
  -- about the flag, not the deletion of the observation.
  acknowledged_at timestamptz,
  acknowledged_by uuid references profiles(id) on delete set null,
  check (subject_profile_id is not null or subject_company_id is not null)
);

create index risk_flags_subject_idx on risk_flags(subject_profile_id, created_at desc);
create index risk_flags_open_idx on risk_flags(created_at desc) where acknowledged_at is null;

alter table risk_flags enable row level security;

-- Internal only, same as incidents: the subject of a flag must not be able to
-- read it. Only acknowledgement may be written, and only by operations.
create policy "risk flags: operations read" on risk_flags
  for select using (public.has_admin_capability('operations'));
create policy "risk flags: operations acknowledge" on risk_flags
  for update using (public.has_admin_capability('operations'))
  with check (public.has_admin_capability('operations'));

create or replace function guard_risk_flag_immutable()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  -- Acknowledging is the only permitted edit. The observation itself is what
  -- somebody will be judged on, so it must read the same later as it did when
  -- it was made.
  if new.kind is distinct from old.kind
     or new.subject_profile_id is distinct from old.subject_profile_id
     or new.subject_company_id is distinct from old.subject_company_id
     or new.observation is distinct from old.observation
     or new.created_at is distinct from old.created_at then
    raise exception 'A risk flag records an observation; only its acknowledgement may change'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger risk_flags_guard_immutable
  before update on risk_flags
  for each row execute procedure guard_risk_flag_immutable();

-- ============================================================
-- 4. OPERATIONAL THRESHOLDS — engineering parameters, stated as such
-- ============================================================
-- Two of these are DERIVED from rules the dispatch engine already enforces,
-- so the alert cannot disagree with the behaviour it is describing. The rest
-- are engineering defaults, labelled as engineering defaults, because no
-- service-level commitment has been made and inventing one here would create
-- a number people quote back as policy.
create table ops_thresholds (
  key text primary key,
  value_seconds integer not null check (value_seconds > 0),
  -- 'derived'  : mirrors a rule already enforced elsewhere in the system
  -- 'engineering' : a default chosen to make the queue useful, not a promise
  origin text not null check (origin in ('derived', 'engineering')),
  description text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id)
);

alter table ops_thresholds enable row level security;
create policy "ops thresholds: admins read" on ops_thresholds
  for select using (public.is_admin());
create policy "ops thresholds: operations write" on ops_thresholds
  for all using (public.has_admin_capability('operations'))
  with check (public.has_admin_capability('operations'));

insert into ops_thresholds (key, value_seconds, origin, description) values
  ('driver_stale_heartbeat', 120, 'derived',
   'Mirrors the dispatch engine''s own filter (last_heartbeat_at > now() - interval ''2 minutes''). '
   'A driver the engine will not offer work to is a driver operations should see as stale.'),
  ('offer_ttl', 18, 'derived',
   'dispatch_offer_ttl(). An offer older than this has already lapsed.'),
  ('pending_without_match', 300, 'engineering',
   'How long a request may sit unmatched before it is surfaced. An engineering default, NOT a '
   'service-level commitment: no SLA has been agreed, and this number must not be quoted as one.'),
  ('payment_unresolved', 3600, 'engineering',
   'How long a payment may stay in a non-terminal state before somebody looks. Engineering default.')
on conflict (key) do nothing;

create or replace function ops_threshold(p_key text)
returns interval
language sql
stable
security definer set search_path = public
as $$
  select make_interval(secs => value_seconds) from ops_thresholds where key = p_key;
$$;

revoke all on function ops_threshold(text) from public;
grant execute on function ops_threshold(text) to authenticated, service_role;
