-- TowConnect — Phase 7: refunds, with an audit trail that names who did it.
-- Additive, run after 0035. Sandbox only.
--
-- WHO MAY REFUND
-- A platform admin, and nobody else. Not the customer, not the driver, not a
-- dispatcher, not a company owner. That is enforced by there being no INSERT
-- policy at all for `authenticated`: refunds are written by trusted server
-- code through the service role, after it has checked is_admin() and after
-- Stripe has answered. The same trust model as `payments` (0013) - a browser
-- session cannot move money, structurally, not because a button is hidden.
--
-- A FUTURE FINANCE ROLE
-- The brief asks for one to be prepared. It is prepared as a table rather than
-- as a new user_role value: adding to the enum would touch handle_new_user(),
-- roleHome and every policy keyed on role, for a role nobody holds yet.
-- refund_authorizers is empty, and is_refund_authorizer() is what the refund
-- path calls - so granting finance access later is inserting a row, not a
-- migration.

create type refund_status as enum ('pending', 'succeeded', 'failed', 'canceled');

create table refunds (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references requests(id) on delete restrict,
  payment_id uuid references payments(id) on delete set null,

  amount numeric(10,2) not null check (amount > 0),
  currency text not null default 'cad',
  -- Free text, required. A refund without a stated reason is an unexplained
  -- movement of somebody's money.
  reason text not null check (length(btrim(reason)) > 0),

  status refund_status not null default 'pending',
  stripe_refund_id text unique,
  failure_reason text,

  created_by uuid not null references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index refunds_request_idx on refunds(request_id, created_at desc);
create index refunds_status_idx on refunds(status) where status = 'pending';

create trigger refunds_set_updated_at
  before update on refunds
  for each row execute procedure extensions.moddatetime(updated_at);

alter table refunds enable row level security;

create policy "refunds: admins full access" on refunds
  for all using (public.is_admin()) with check (public.is_admin());

-- The customer can see that they were refunded, and how much. Being refunded
-- without being told is its own kind of failure.
create policy "refunds: customer reads their own" on refunds
  for select using (
    exists (select 1 from requests r where r.id = refunds.request_id and r.user_id = auth.uid())
  );

-- No INSERT/UPDATE for anyone but an admin. In particular there is no policy
-- that a dispatcher, a company owner or a driver could satisfy.

create table refund_authorizers (
  profile_id uuid primary key references profiles(id) on delete cascade,
  granted_by uuid references profiles(id),
  granted_at timestamptz not null default now(),
  note text
);

alter table refund_authorizers enable row level security;
create policy "refund authorizers: admins manage" on refund_authorizers
  for all using (public.is_admin()) with check (public.is_admin());

create or replace function is_refund_authorizer()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select public.is_admin()
      or exists (select 1 from refund_authorizers a where a.profile_id = auth.uid())
$$;

revoke all on function is_refund_authorizer() from public;
grant execute on function is_refund_authorizer() to authenticated, service_role;

comment on table refund_authorizers is
  'The future finance role, prepared as data rather than as a user_role enum value. Empty: today '
  'only platform admins can refund. Granting it later is an INSERT, not a migration.';

-- ============================================================
-- What has actually been refunded against a request. Used by the receipt and
-- by the ledger reversal, so both read the same number.
-- ============================================================
create or replace function request_refunded_total(p_request_id uuid)
returns numeric
language sql
stable
security definer set search_path = public
as $$
  select coalesce(sum(amount), 0)::numeric(10,2)
  from refunds
  where request_id = p_request_id and status = 'succeeded'
$$;

revoke all on function request_refunded_total(uuid) from public;
grant execute on function request_refunded_total(uuid) to authenticated, service_role;
