-- TowConnect — Phase 6, Part F: document compliance. Additive, run after 0024.
-- Placed before Dispatch V2 (0026) so dispatch can call the real compliance
-- check rather than a placeholder it would have to be rewritten around.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
-- It does not decide which documents are legally mandatory. Nobody on this
-- project has verified what Québec, Ontario or anywhere else actually
-- requires of a tow operator, and guessing would be exactly the kind of
-- invented fact this phase is supposed to stop. So document_requirements
-- ships EMPTY: the machinery is complete and enforceable the moment a
-- verified rule is entered, and until then it blocks nobody.
--
-- WHY EXPIRY IS COMPUTED, NOT STORED
-- 0019 added driver_documents.expires_at with a note that nothing enforced
-- it. The obvious fix is a nightly job that flips status to 'expired' — but
-- then enforcement is only ever as fresh as the last job run, and a missed
-- run silently lets an expired licence back on the road. driver_document_
-- effective_status() derives expiry from the date at read time instead, so
-- the answer is correct at the instant it is asked, with no scheduler in the
-- trusted path. expire_driver_documents() still exists to keep the stored
-- status column tidy for the UI, but nothing security-relevant depends on it
-- having run.

-- ============================================================
-- DOCUMENT_REQUIREMENTS — configurable, per province, per document type.
-- ============================================================
create table document_requirements (
  id uuid primary key default gen_random_uuid(),
  -- NULL means "everywhere". A province-specific row wins over a NULL row
  -- for drivers in that province.
  province text,
  document_type driver_document_type not null,

  -- Whether an approved, unexpired document of this type must exist at all.
  required boolean not null default false,
  -- What a missing/expired document costs. Separated on purpose: a
  -- jurisdiction may want a document on file to work at all, while another
  -- only bars it from new dispatch and lets a driver finish the job they are
  -- already on.
  blocks_online boolean not null default false,
  blocks_dispatch boolean not null default false,

  -- Whether an expiry date must be present for the document to count as
  -- valid. An insurance certificate with no expiry on file is not evidence
  -- of current insurance.
  requires_expiry boolean not null default false,
  -- Days after expiry during which the document still counts. Zero unless a
  -- jurisdiction actually grants a grace period.
  grace_days integer not null default 0 check (grace_days >= 0),

  source_url text,
  source_title text,
  last_verified_at timestamptz,
  active boolean not null default true,
  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (province, document_type)
);

create index document_requirements_lookup_idx on document_requirements(document_type, province)
  where active;

create trigger document_requirements_set_updated_at
  before update on document_requirements
  for each row execute procedure extensions.moddatetime(updated_at);

alter table document_requirements enable row level security;

-- Any signed-in user may read the active rules: a driver has to be able to
-- see what is being asked of them and why.
create policy "document requirements: signed-in users read active" on document_requirements
  for select using (active = true);

create policy "document requirements: admins full access" on document_requirements
  for all using (public.is_admin()) with check (public.is_admin());

comment on table document_requirements is
  'Which driver documents are mandatory, per province. Ships EMPTY on purpose — no requirement is '
  'assumed for any jurisdiction until it has been verified against an official source. An empty '
  'table blocks nobody.';

-- ============================================================
-- EFFECTIVE STATUS
-- ============================================================

-- What a document's status actually is right now, regardless of what the
-- stored column says. An approved document past its expiry (plus any grace)
-- is expired, full stop.
create or replace function driver_document_effective_status(
  p_status driver_document_status,
  p_expires_at date,
  p_grace_days integer default 0
)
returns driver_document_status
language sql
immutable
as $$
  select case
    when p_status = 'approved'
         and p_expires_at is not null
         and p_expires_at + make_interval(days => coalesce(p_grace_days, 0)) < current_date
      then 'expired'::driver_document_status
    else p_status
  end
$$;

-- The rule that applies to a driver for one document type: the row for their
-- own province if there is one, otherwise the province-agnostic row.
create or replace function document_requirement_for(
  p_province text,
  p_type driver_document_type
)
returns document_requirements
language sql
stable
security definer set search_path = public
as $$
  select r.*
  from document_requirements r
  where r.active
    and r.document_type = p_type
    and (r.province = p_province or r.province is null)
  order by (r.province is null) asc
  limit 1
$$;

-- Every requirement a driver currently fails, with enough detail for the UI
-- to say something useful instead of "not allowed".
create or replace function driver_compliance_issues(p_driver_id uuid)
returns table (
  document_type driver_document_type,
  reason text,
  blocks_online boolean,
  blocks_dispatch boolean
)
language sql
stable
security definer set search_path = public
as $$
  with province as (
    select coalesce(nullif(dp.province, ''), null) as province
    from driver_profiles dp where dp.profile_id = p_driver_id
  ),
  rules as (
    select r.*
    from document_requirements r, province p
    where r.active
      and r.required
      and (r.province = p.province or r.province is null)
      -- A province-specific rule supersedes the generic one for the same type.
      and not exists (
        select 1 from document_requirements r2, province p2
        where r2.active and r2.required
          and r2.document_type = r.document_type
          and r2.province = p2.province
          and r.province is null
      )
  ),
  best as (
    select
      ru.document_type,
      ru.blocks_online,
      ru.blocks_dispatch,
      ru.requires_expiry,
      -- The most usable document of this type the driver holds.
      (
        select driver_document_effective_status(d.status, d.expires_at, ru.grace_days)
        from driver_documents d
        where d.driver_id = p_driver_id and d.type = ru.document_type
        order by
          case driver_document_effective_status(d.status, d.expires_at, ru.grace_days)
            when 'approved' then 0 when 'pending' then 1 when 'expired' then 2 else 3 end,
          d.uploaded_at desc
        limit 1
      ) as effective_status,
      (
        select d.expires_at
        from driver_documents d
        where d.driver_id = p_driver_id and d.type = ru.document_type
          and driver_document_effective_status(d.status, d.expires_at, ru.grace_days) = 'approved'
        order by d.uploaded_at desc
        limit 1
      ) as approved_expires_at
    from rules ru
  )
  select
    b.document_type,
    case
      when b.effective_status is null then 'missing'
      when b.effective_status = 'expired' then 'expired'
      when b.effective_status <> 'approved' then 'not_approved'
      when b.requires_expiry and b.approved_expires_at is null then 'expiry_date_missing'
    end as reason,
    b.blocks_online,
    b.blocks_dispatch
  from best b
  where b.effective_status is null
     or b.effective_status <> 'approved'
     or (b.requires_expiry and b.approved_expires_at is null)
$$;

revoke all on function driver_compliance_issues(uuid) from public;
grant execute on function driver_compliance_issues(uuid) to authenticated, service_role;

-- The two one-line questions dispatch and the online toggle actually ask.
create or replace function driver_dispatch_blocked(p_driver_id uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (select 1 from driver_compliance_issues(p_driver_id) i where i.blocks_dispatch)
$$;

create or replace function driver_online_blocked(p_driver_id uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (select 1 from driver_compliance_issues(p_driver_id) i where i.blocks_online)
$$;

revoke all on function driver_dispatch_blocked(uuid) from public;
revoke all on function driver_online_blocked(uuid) from public;
grant execute on function driver_dispatch_blocked(uuid) to authenticated, service_role;
grant execute on function driver_online_blocked(uuid) to authenticated, service_role;

-- ============================================================
-- ENFORCEMENT — going online
--
-- Server-side, so it holds whatever the client does. Only fires on the
-- transition into online: a driver already online who lets a document lapse
-- mid-shift is not thrown out of a job they are performing; dispatch simply
-- stops offering them new work (0026).
-- ============================================================
create or replace function guard_driver_online_compliance()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_missing text;
begin
  if new.is_online and not coalesce(old.is_online, false) then
    if driver_online_blocked(new.profile_id) then
      select string_agg(i.document_type::text || ' (' || i.reason || ')', ', ')
      into v_missing
      from driver_compliance_issues(new.profile_id) i
      where i.blocks_online;

      raise exception 'Cannot go online: required document(s) not in good standing: %', v_missing
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

create trigger driver_profiles_guard_online_compliance
  before update on driver_profiles
  for each row execute procedure guard_driver_online_compliance();

-- ============================================================
-- OPTIONAL TIDY-UP — flips the stored status column so the UI reads
-- naturally. Nothing security-relevant depends on this having run; every
-- enforcement path above computes expiry live.
-- ============================================================
create or replace function expire_driver_documents()
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_count integer;
begin
  update driver_documents d
  set status = 'expired'
  where d.status = 'approved'
    and d.expires_at is not null
    and d.expires_at < current_date;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function expire_driver_documents() from public;
grant execute on function expire_driver_documents() to service_role;

comment on function expire_driver_documents() is
  'Cosmetic status maintenance only. Enforcement (driver_dispatch_blocked / driver_online_blocked) '
  'computes expiry from expires_at at read time and does not depend on this ever running.';
