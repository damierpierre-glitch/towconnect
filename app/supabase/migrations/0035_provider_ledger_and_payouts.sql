-- TowConnect — Phase 7: an append-only provider ledger, and payouts computed
-- from it. Additive, run after 0034.
--
-- WHY A LEDGER AND NOT A BALANCE COLUMN
-- A balance column is a number somebody can be wrong about. Every question
-- that matters after money moves — why is this partner owed $340, which job
-- was that, what did the refund take back, when did it become payable — is a
-- question about movements, not about a total. So the movements are the
-- record and the totals are derived, which also means the totals cannot drift
-- from the movements that justify them.
--
-- APPEND-ONLY, INCLUDING FOR US
-- No UPDATE, no DELETE, by anyone, enforced by a trigger rather than by the
-- absence of a policy — the service role bypasses RLS, and "the ledger is
-- immutable except when our own code edits it" is not immutability. A payout
-- does not mark earlier rows paid; it writes its own negative row. A reversal
-- does not erase the payout; it writes the opposite row. The history stays
-- readable as what actually happened, including the mistakes.
--
-- NOTHING IS WRITTEN HERE YET while no economic configuration is active: an
-- earning with a NULL amount is not an earning, so no row is created at all.

create type ledger_entry_type as enum (
  'earning',          -- the provider's compensation for a completed job
  'supplement',       -- an extra the customer approved
  'adjustment',       -- a manual correction, always with a reason
  'refund_reversal',  -- money taken back because the customer was refunded
  'payout',           -- money sent to the provider (negative)
  'payout_reversal'   -- a payout that failed or was clawed back (positive)
);

create type payout_state as enum ('pending', 'eligible', 'held', 'paid', 'reversed');

create table provider_payouts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete restrict,
  amount numeric(10,2) not null check (amount > 0),
  currency text not null default 'cad',
  state payout_state not null default 'pending',
  -- Set only when a real (sandbox) transfer is made. NULL means nothing has
  -- been sent, whatever the state says.
  stripe_transfer_id text unique,
  failure_reason text,
  requested_by uuid references profiles(id),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  paid_at timestamptz,
  reversed_at timestamptz
);

create index provider_payouts_company_idx on provider_payouts(company_id, created_at desc);

create trigger provider_payouts_set_updated_at
  before update on provider_payouts
  for each row execute procedure extensions.moddatetime(updated_at);

alter table provider_payouts enable row level security;

-- Owner and company admin only. A dispatcher runs the day; they do not see
-- what the company gets paid, and a driver certainly does not.
create policy "payouts: company owners and admins read own" on provider_payouts
  for select using (is_company_owner_or_admin(company_id) or public.is_admin());
create policy "payouts: admins full access" on provider_payouts
  for all using (public.is_admin()) with check (public.is_admin());
-- No INSERT/UPDATE for a company: a company cannot pay itself. Payouts are
-- created by trusted server code through the service role.

create table provider_ledger_entries (
  id bigserial primary key,
  company_id uuid not null references companies(id) on delete cascade,
  -- Which driver earned it, when that is known. Nullable because an
  -- adjustment or a payout belongs to the company, not to a person.
  driver_id uuid references profiles(id) on delete set null,
  request_id uuid references requests(id) on delete set null,
  payout_id uuid references provider_payouts(id) on delete restrict,

  entry_type ledger_entry_type not null,
  -- Signed. Positive credits the provider, negative takes back or pays out.
  -- Not constrained by type on purpose: an adjustment goes either way, and a
  -- constraint that has to be widened later is a constraint that will be.
  amount numeric(10,2) not null,
  currency text not null default 'cad',

  -- When this credit becomes payable. NULL means "not yet" - the job is not
  -- finished, or the payment has not been captured. There is no 'available'
  -- flag to flip, so nothing can be marked payable by accident.
  available_at timestamptz,

  description text,
  metadata jsonb,
  created_at timestamptz not null default now(),
  created_by uuid references profiles(id)
);

create index provider_ledger_company_idx on provider_ledger_entries(company_id, created_at desc);
create index provider_ledger_request_idx on provider_ledger_entries(request_id);
create index provider_ledger_payout_idx on provider_ledger_entries(payout_id);
-- One earning per job. A double-credited job is the classic ledger bug and
-- this is the cheapest possible defence against it.
create unique index provider_ledger_one_earning_per_request
  on provider_ledger_entries (request_id)
  where entry_type = 'earning' and request_id is not null;

alter table provider_ledger_entries enable row level security;

create policy "ledger: company owners and admins read own" on provider_ledger_entries
  for select using (is_company_owner_or_admin(company_id) or public.is_admin());
create policy "ledger: admins read all" on provider_ledger_entries
  for select using (public.is_admin());
-- A driver may see the entries for their own jobs - what they earned - without
-- seeing the company's whole book.
create policy "ledger: driver reads their own entries" on provider_ledger_entries
  for select using (driver_id = auth.uid());
-- No INSERT/UPDATE/DELETE policy for anyone: written by trusted server code
-- through the service role, and never changed afterwards (see below).

create or replace function guard_ledger_append_only()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  -- An entry's amount can never change. A correction is a new entry, and that
  -- holds for the service role too: "immutable unless our own code decides
  -- otherwise" is not immutable.
  if tg_op = 'UPDATE' then
    raise exception 'The provider ledger is append-only: a correction is a new entry, not an edit'
      using errcode = '42501';
  end if;

  -- DELETE is refused for as long as the company exists, so no single entry
  -- can be picked out of the book. It is allowed only when the company itself
  -- is torn down and the cascade takes the whole book with it - a deletion of
  -- the entity, not a rewrite of its history. Without this the ledger would
  -- make a company undeletable, which is a different kind of wrong.
  if exists (select 1 from companies c where c.id = old.company_id) then
    raise exception 'A ledger entry cannot be deleted while its company exists'
      using errcode = '42501';
  end if;

  return old;
end;
$$;

create trigger provider_ledger_no_update
  before update or delete on provider_ledger_entries
  for each row execute procedure guard_ledger_append_only();

-- ============================================================
-- BALANCES, derived
-- ============================================================
create or replace function provider_balances(p_company_id uuid)
returns table (
  pending numeric,
  available numeric,
  paid_total numeric,
  lifetime_earned numeric
)
language sql
stable
security definer set search_path = public
as $$
  select
    -- Earned but not yet payable.
    coalesce(sum(amount) filter (
      where available_at is null or available_at > now()
    ), 0)::numeric(12,2) as pending,
    -- Payable now: everything released, less everything already paid out.
    coalesce(sum(amount) filter (
      where available_at is not null and available_at <= now()
    ), 0)::numeric(12,2) as available,
    coalesce(-sum(amount) filter (where entry_type = 'payout'), 0)::numeric(12,2) as paid_total,
    coalesce(sum(amount) filter (
      where entry_type in ('earning', 'supplement')
    ), 0)::numeric(12,2) as lifetime_earned
  from provider_ledger_entries
  where company_id = p_company_id
$$;

revoke all on function provider_balances(uuid) from public;
grant execute on function provider_balances(uuid) to authenticated, service_role;

comment on function provider_balances(uuid) is
  'Every figure is derived from the ledger. There is no stored balance to disagree with the '
  'movements that produced it.';
