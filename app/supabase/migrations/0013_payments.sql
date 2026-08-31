-- TowConnect — Phase 4: Stripe payments infrastructure. Additive, run after
-- 0001-0012.
--
-- Trust model for this table: every write to `payments` (and to
-- profiles.stripe_customer_id) happens from trusted Next.js server code
-- using the Supabase *service role* client (src/lib/supabase/admin.ts) —
-- code that only ever runs after a real, verified Stripe API response
-- (creating/confirming/capturing a PaymentIntent, or a signature-verified
-- webhook event). There is deliberately no INSERT/UPDATE policy for
-- `authenticated` on `payments` at all: a user's own browser session can
-- never mark its own payment as paid, full stop — not "discouraged by the
-- UI", structurally absent as a grantable action.

create type payment_status as enum (
  'requires_payment_method',
  'requires_action',
  'authorized',
  'captured',
  'failed',
  'canceled',
  'refunded'
);

create table payments (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references requests(id) on delete cascade,
  -- Stripe's own id is the real idempotency key: creating two PaymentIntents
  -- for the same attempt is a bug, and this makes it impossible to record
  -- twice.
  stripe_payment_intent_id text unique,
  -- Snapshot of requests.price_estimate at authorization time — this row's
  -- amount never changes after creation even if requests' price columns
  -- somehow did (they don't, post-creation — see 0012).
  amount numeric(8,2) not null,
  currency text not null default 'cad',
  status payment_status not null default 'requires_payment_method',
  -- Mirrors requests.commission_amount/partner_amount — same "NULL until a
  -- rate is decided" rule, see 0012's comment.
  commission_amount numeric(8,2),
  partner_amount numeric(8,2),
  -- Short, support-facing reason (e.g. a Stripe decline_code) — never shown
  -- verbatim to the customer, who instead sees a plain-language message
  -- (see PaymentStatus.tsx).
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index payments_request_idx on payments(request_id, created_at desc);

create trigger payments_set_updated_at
  before update on payments
  for each row execute procedure extensions.moddatetime(updated_at);

alter table payments enable row level security;

create policy "payments: owner reads own" on payments
  for select using (
    exists (select 1 from requests r where r.id = payments.request_id and r.user_id = auth.uid())
  );

create policy "payments: admins read all" on payments
  for select using (public.is_admin());

-- No insert/update/delete policy for authenticated — see trust model note
-- above. The assigned driver has no policy here at all: "driver never sees
-- private client payment data" is enforced by the same absence.

alter publication supabase_realtime add table payments;

-- ============================================================
-- Idempotent webhook processing: insert the Stripe event id here (unique
-- constraint) before acting on an event; a conflict means it was already
-- processed, so the handler can skip it. No RLS policy at all — this table
-- is never read or written by anything except the service-role webhook
-- route.
-- ============================================================
create table stripe_webhook_events (
  id uuid primary key default gen_random_uuid(),
  stripe_event_id text not null unique,
  type text not null,
  processed_at timestamptz not null default now()
);

alter table stripe_webhook_events enable row level security;

-- ============================================================
-- profiles.stripe_customer_id — one persistent Stripe Customer per
-- TowConnect account, never the raw email. Guarded the same way
-- approval_status/rating are on driver_profiles (0002/0003): the existing
-- "profiles: update own" policy has no column restriction, so without this
-- trigger a user could point their own profile at *anyone's* Stripe
-- customer id via a plain client update.
-- ============================================================
alter table profiles
  add column stripe_customer_id text unique;

create or replace function guard_stripe_customer_id()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  -- Set only by ensureStripeCustomer() (lib/actions/payments.ts), which
  -- uses the service-role client precisely because this column must never
  -- be settable from a user's own session.
  if auth.role() = 'service_role' then
    return new;
  end if;

  if new.stripe_customer_id is distinct from old.stripe_customer_id then
    raise exception 'stripe_customer_id can only be set by the server' using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger profiles_guard_stripe_customer_id
  before update on profiles
  for each row execute procedure guard_stripe_customer_id();
