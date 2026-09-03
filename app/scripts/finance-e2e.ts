// Phase 7.1 — financial end-to-end validation against REAL Stripe sandbox and
// the REAL project database.
//
// WHAT MAKES THIS DIFFERENT FROM verify:phase7
// verify:phase7 asks "is the schema in the state we think it is". This asks
// "did the system actually perform the cycle": a real card authorization at
// Stripe, a real acceptance that froze real numbers, a real capture, a real
// ledger entry, a real refund, and a real reconciliation to the cent.
//
// HOW IT RUNS THE APP'S OWN CODE
// It imports and calls the actual server actions. Three Next-only modules are
// swapped by tsconfig.e2e.json: `server-only` (a build-time protection that is
// meaningless here), `next/cache` (records revalidations instead of doing
// them) and `@/lib/supabase/server` (builds the client from a signed-in user's
// access token instead of from request cookies).
//
// Only the transport changes. Every action still runs as a genuine
// authenticated user against the real database, so RLS policies, SECURITY
// DEFINER guards and triggers all fire exactly as they do in production — an
// action that would be refused in the app is refused here.
//
//   npm run test:finance
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import Stripe from 'stripe';
import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js';

import { actAs } from './e2e/session';
import { settle } from '@/lib/economics';
import { stripeKeyMode } from '@/lib/stripe/mode';
import {
  activatePricingConfig,
  archivePricingConfig,
  createPricingDraft,
  getPricingStatus,
  quoteProviderCompensation,
} from '@/lib/actions/economics';
import { createRequest, cancelRequest } from '@/lib/actions/requests';
import { POST as webhookHandler } from '@/app/api/stripe/webhook/route';

// Since Phase 10, createRequest() can answer with a refusal instead of a
// request — the pilot gate (0047). Every fixture below runs with the pilot
// off, so a refusal here is a broken test environment rather than an outcome
// worth handling, and it should stop the run loudly instead of producing a
// confusing failure four assertions later.
async function createRequestOrFail(input: Parameters<typeof createRequest>[0]) {
  const result = await createRequest(input);
  if ('refused' in result) {
    throw new Error(
      `The pilot gate refused a fixture request (${result.reason}). ` +
        'Check pilot_config.mode — these fixtures require it to be off.'
    );
  }
  return result;
}
import { acceptRequest, advanceRequestStatus } from '@/lib/actions/driver';
import { proposeSupplement, respondToSupplement } from '@/lib/actions/supplements';
import {
  getAdminFinanceOverview,
  getProviderBalances,
  issueRefund,
  listLedgerEntries,
  preparePayout,
  setPayoutState,
} from '@/lib/actions/finance';
import { getConnectAvailability, refreshConnectStatus, startConnectOnboarding } from '@/lib/actions/connect';

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY!;

// Refuses to run outside sandbox. The same rule the application enforces, and
// for the same reason: this script authorizes cards, captures money and issues
// refunds. Against a live key it would do all of that for real.
if (stripeKeyMode(STRIPE_SECRET_KEY) !== 'test') {
  console.error('Refusing to run: STRIPE_SECRET_KEY is not a test-mode key.');
  process.exit(1);
}

const stripe = new Stripe(STRIPE_SECRET_KEY);
const admin = createSupabaseClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const WEBHOOK_ENDPOINT =
  process.env.WEBHOOK_ENDPOINT_URL ?? 'https://towconnect-chi.vercel.app/api/stripe/webhook';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? '';

const MTL = { lat: 45.5019, lng: -73.5674 };
const FIXTURE_LABEL = 'FIXTURE — Phase 7.1 E2E (NOT a business rate)';

// ---------------------------------------------------------------- reporting

type Status = 'pass' | 'fail' | 'manual' | 'note';
interface Result {
  section: string;
  name: string;
  status: Status;
  detail?: string;
}
const results: Result[] = [];
let section = '';
const sect = (s: string) => {
  section = s;
  console.log(`\n── ${s}`);
};
const record = (status: Status, name: string, detail?: string) => {
  results.push({ section, name, status, detail });
  const mark = status === 'pass' ? '✓' : status === 'fail' ? '✗' : status === 'manual' ? '⊘' : '·';
  console.log(`  ${mark} ${name}${detail ? ` — ${detail}` : ''}`);
};
const ok = (name: string, pass: boolean, detail?: string) =>
  record(pass ? 'pass' : 'fail', name, pass ? undefined : detail);

const money = (v: unknown) => Number(v ?? 0);
const near = (a: number, b: number, tol = 0.005) => Math.abs(a - b) < tol;

// The cleanup block runs as the platform admin, but the actor objects are
// scoped inside main(). This is the one thing cleanup needs from outside.
let adminTokenForCleanup: string | null = null;

/**
 * Re-deliver a real Stripe event to the deployed endpoint, signed correctly.
 *
 * The body is not fabricated: it is fetched back from Stripe's own events API,
 * so what the endpoint receives is the same JSON Stripe sent. Only the
 * delivery is ours, which is the point — Stripe will not re-send an event on
 * demand, and idempotency is exactly the property that only shows up on a
 * second delivery.
 */
// Replay a real Stripe event through the webhook handler.
//
// WHY IN-PROCESS RATHER THAN OVER HTTP
// This used to POST a self-signed payload at the deployed endpoint, which
// only works while the local STRIPE_WEBHOOK_SECRET happens to be the same
// value the deployment holds. Those are two different environments with no
// mechanism keeping them equal, and when they drifted these assertions began
// reporting "Invalid signature" — which reads like a security failure and was
// an environment one.
//
// Stripe never returns an endpoint's signing secret after creation, so the
// two cannot be reconciled by any script. Calling the route handler directly
// removes the question: the signature is made and verified with the same
// secret, and what is under test — verification, idempotency, and the absence
// of a second financial effect — is the handler's behaviour, which is what
// these assertions were always about.
//
// The deployment is still tested, twice, and without needing any secret at
// all: it must reject an unsigned request and a forged one (below), and
// Stripe's own delivery record must show it accepting genuine events.
async function replayEvent(eventId: string): Promise<{ status: number; body: string }> {
  const event = await stripe.events.retrieve(eventId);
  const payload = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', WEBHOOK_SECRET)
    .update(`${timestamp}.${payload}`, 'utf8')
    .digest('hex');

  const response = await webhookHandler(
    new Request(WEBHOOK_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'stripe-signature': `t=${timestamp},v1=${signature}`,
      },
      body: payload,
    })
  );
  return { status: response.status, body: (await response.text()).slice(0, 200) };
}

/** Post raw bytes at the DEPLOYED endpoint. Needs no secret, and must fail. */
async function postToDeployedEndpoint(
  body: string,
  headers: Record<string, string>
): Promise<{ status: number; body: string }> {
  const response = await fetch(WEBHOOK_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
  return { status: response.status, body: (await response.text()).slice(0, 200) };
}

// ---------------------------------------------------------------- fixtures

interface Actor {
  id: string;
  email: string;
  token: string;
  client: SupabaseClient;
}
const createdUserIds: string[] = [];
const createdCompanyIds: string[] = [];
const connectAccountIds: string[] = [];

async function makeActor(role: 'user' | 'driver', who: string): Promise<Actor> {
  const email = `p71-${who}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const password = 'test-password-123!';
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { role, full_name: `Phase 7.1 ${who}` },
  });
  if (error || !data.user) throw new Error(`could not create ${who}: ${error?.message}`);
  createdUserIds.push(data.user.id);

  const client = createSupabaseClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Same rate-limit dance as the RLS suite: Supabase Auth caps sign-ins per
  // IP, and hitting that cap is a property of the harness, not a failure of
  // anything under test.
  for (let attempt = 1; ; attempt++) {
    const { error: signInError } = await client.auth.signInWithPassword({ email, password });
    if (!signInError) break;
    if (!/rate limit/i.test(signInError.message) || attempt >= 5) {
      throw new Error(`could not sign in ${who}: ${signInError.message}`);
    }
    console.log(`  … auth rate limit, waiting 65s (${attempt}/4)`);
    await new Promise((r) => setTimeout(r, 65_000));
  }

  const { data: sessionData } = await client.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) throw new Error(`no access token for ${who}`);
  return { id: data.user.id, email, token, client };
}

async function main() {
  const openIntents = new Set<string>();
  let fixtureConfigV1: string | null = null;
  let fixtureConfigV2: string | null = null;

  // ================================================================
  sect('0. Preconditions');
  // ================================================================
  const { data: preexisting } = await admin.from('pricing_configs').select('id').eq('status', 'active');
  ok(
    'no economic configuration is active before the run',
    (preexisting ?? []).length === 0,
    `${(preexisting ?? []).length} active configuration(s) — the run would not be starting from the shipped state`
  );

  const availability = await getConnectAvailability();
  ok('Stripe is configured and in sandbox', availability.sandbox && availability.stripeConfigured);

  // ---- actors ----
  const rider = await makeActor('user', 'rider');
  const driver = await makeActor('driver', 'driver');
  const ownerA = await makeActor('user', 'ownerA');
  const dispatcherA = await makeActor('user', 'dispatcherA');
  const ownerB = await makeActor('user', 'ownerB');
  const platformAdmin = await makeActor('user', 'admin');
  await admin.from('profiles').update({ role: 'admin' }).eq('id', platformAdmin.id);
  // Explicit since 0044. Until then an admin with no grants held everything,
  // and this fixture relied on that; now nothing is implicit and the harness
  // has to say what it is exercising, which is the point of the change.
  await admin
    .from('admin_grants')
    .insert({ profile_id: platformAdmin.id, capability: 'super_admin' } as never);
  adminTokenForCleanup = platformAdmin.token;

  const { error: driverSetupError } = await admin
    .from('driver_profiles')
    .update({
      approval_status: 'approved',
      is_online: true,
      current_lat: MTL.lat,
      current_lng: MTL.lng,
      last_heartbeat_at: new Date().toISOString(),
    })
    .eq('profile_id', driver.id);
  if (driverSetupError) throw new Error(`could not prepare the driver: ${driverSetupError.message}`);

  const { data: companies } = await admin
    .from('companies')
    .insert([
      { name: 'Phase 7.1 Fixture Towing A', owner_id: ownerA.id, status: 'active', province: 'QC' },
      { name: 'Phase 7.1 Fixture Towing B', owner_id: ownerB.id, status: 'active', province: 'QC' },
    ])
    .select('id, name');
  const coA = companies!.find((c) => c.name.endsWith('A'))!.id as string;
  const coB = companies!.find((c) => c.name.endsWith('B'))!.id as string;
  createdCompanyIds.push(coA, coB);

  await admin.from('company_members').insert([
    { company_id: coA, profile_id: ownerA.id, role: 'owner', status: 'active' },
    { company_id: coA, profile_id: dispatcherA.id, role: 'dispatcher', status: 'active' },
    { company_id: coA, profile_id: driver.id, role: 'driver', status: 'active' },
    { company_id: coB, profile_id: ownerB.id, role: 'owner', status: 'active' },
  ]);
  record('note', 'fixtures created', `rider, driver, 2 companies, admin`);

  // The card vault is Stripe's, not ours: the app collects a card through
  // Stripe Elements (an iframe) and never sees the number. The harness does
  // the equivalent through Stripe's API with a test PaymentMethod, which
  // exercises the same saved-card state the app would end up in.
  const customer = await stripe.customers.create({
    email: rider.email,
    metadata: { towconnect_user_id: rider.id, towconnect_fixture: 'phase-7.1' },
  });
  await stripe.paymentMethods.attach('pm_card_visa', { customer: customer.id });
  const pm = (await stripe.customers.listPaymentMethods(customer.id, { type: 'card' })).data[0];
  await stripe.customers.update(customer.id, {
    invoice_settings: { default_payment_method: pm.id },
  });
  await admin.from('profiles').update({ stripe_customer_id: customer.id }).eq('id', rider.id);
  record('note', 'rider has a saved sandbox card', `${pm.card?.brand} ····${pm.card?.last4}`);

  try {
    // ================================================================
    sect('1. Temporary economic configuration (test fixture, not a rate)');
    // ================================================================
    actAs(platformAdmin.token, 'platform admin');
    const draft = await createPricingDraft({
      label: FIXTURE_LABEL,
      commissionPercent: 18,
      commissionFixed: null,
      commissionMin: null,
      commissionMax: null,
      providerMinimum: null,
      paymentProcessingPercent: 2.9,
      paymentProcessingFixed: 0.3,
      // Deliberately NULL. Phase 7.1 asserts that with no cancellation policy
      // configured, nothing is charged and nothing is invented.
      cancellationFeeCustomer: null,
      cancellationCompensationProvider: null,
      notes: 'Created by scripts/finance-e2e.ts. Archived at the end of the run. Not a business decision.',
    });
    fixtureConfigV1 = draft.id;
    ok('a draft can be created by a platform admin', draft.status === 'draft');

    await activatePricingConfig(draft.id);
    const statusAfterActivate = await getPricingStatus();
    ok('the fixture configuration is active', statusAfterActivate.configured === true);

    const { data: auditRows } = await admin
      .from('pricing_config_audit')
      .select('action')
      .eq('config_id', draft.id)
      .order('created_at');
    ok(
      'the activation is recorded in the audit trail',
      (auditRows ?? []).length >= 2,
      `${(auditRows ?? []).length} audit row(s)`
    );

    // ================================================================
    sect('2. Stripe Connect Express (real test-mode account)');
    // ================================================================
    actAs(ownerA.token, 'company A owner');

    // Connect has to be enabled on the PLATFORM's Stripe account before any
    // connected account can exist — a dashboard sign-up, not an API call.
    // When it is not, Stripe refuses account creation outright, and that is
    // recorded here as the human action it is rather than worked around.
    let connectUsable = true;
    try {
      const link = await startConnectOnboarding(coA);
      ok('an Account Link is returned', link.url.startsWith('https://connect.stripe.com/'), link.url.slice(0, 40));

      const { data: companyAfterCreate } = await admin
        .from('companies')
        .select(
          'stripe_account_id, connect_status, connect_charges_enabled, connect_payouts_enabled, connect_requirements_due'
        )
        .eq('id', coA)
        .single();
      const accountId = companyAfterCreate!.stripe_account_id as string;
      ok('a Connect account id is stored on the company', Boolean(accountId), 'no account id was written');

      const account = await stripe.accounts.retrieve(accountId);
      ok('the account really exists at Stripe and is Express', account.type === 'express', String(account.type));
      ok(
        'Stripe agrees the account cannot yet charge or be paid out',
        account.charges_enabled === false && account.payouts_enabled === false,
        `charges ${account.charges_enabled}, payouts ${account.payouts_enabled}`
      );
      ok(
        'our stored flags match what Stripe says',
        companyAfterCreate!.connect_charges_enabled === account.charges_enabled &&
          companyAfterCreate!.connect_payouts_enabled === account.payouts_enabled
      );
      ok(
        'the outstanding requirements are recorded, not summarised away',
        Array.isArray(companyAfterCreate!.connect_requirements_due) &&
          (companyAfterCreate!.connect_requirements_due as string[]).length > 0,
        'no requirements were stored for an account Stripe says is incomplete'
      );

      // Account Links are single-use and short-lived, so a cached one is a
      // broken door. Both URLs are asserted because "came back from Stripe"
      // and "finished onboarding" are different facts.
      const freshLink = await stripe.accountLinks.create({
        account: accountId,
        refresh_url: 'http://localhost:3000/dashboard/business?connect=refresh',
        return_url: 'http://localhost:3000/dashboard/business?connect=return',
        type: 'account_onboarding',
      });
      ok('a fresh Account Link can be generated (they are single-use)', Boolean(freshLink.url));

      await refreshConnectStatus(coA);
      const { data: companyAfterRefresh } = await admin
        .from('companies')
        .select('connect_status, connect_payouts_enabled, connect_updated_at')
        .eq('id', coA)
        .single();
      ok(
        'the status is re-read from Stripe rather than assumed from the redirect',
        companyAfterRefresh!.connect_updated_at != null && companyAfterRefresh!.connect_payouts_enabled === false
      );
      record(
        'manual',
        'completing Express onboarding (identity, bank account) needs Stripe’s hosted form',
        'open the Account Link in a browser and submit Stripe’s documented test values — the API cannot set these fields on an Express account'
      );

      connectAccountIds.push(accountId);
    } catch (e) {
      connectUsable = false;
      const message = e instanceof Error ? e.message : String(e);
      const notSignedUp = /signed up for Connect/i.test(message);
      record(
        'manual',
        notSignedUp
          ? 'Stripe Connect is not enabled on the platform account'
          : 'Connect onboarding could not be exercised',
        notSignedUp
          ? 'enable Connect in test mode at dashboard.stripe.com/connect — until then Stripe refuses to create any connected account, so no onboarding, requirement or payout state can be observed'
          : message.slice(0, 300)
      );
      record(
        'note',
        'getConnectAvailability() reported available while Stripe refuses',
        'it checks the key mode only; whether the platform is signed up for Connect is not knowable without calling Stripe'
      );
    }
    void connectUsable;

    // ================================================================
    sect('3. A real course with real sandbox economics');
    // ================================================================
    actAs(rider.token, 'rider');
    const created = await createRequestOrFail({
      problemType: 'battery',
      locationText: 'Phase 7.1 — main scenario',
      lat: MTL.lat,
      lng: MTL.lng,
      vehicleDesc: 'Fixture vehicle',
      notes: '',
    });
    ok('the card was authorized at Stripe', created.paymentStatus === 'authorized', created.paymentStatus);

    const { data: request1 } = await admin.from('requests').select('*').eq('id', created.requestId).single();
    const customerPrice = money(request1!.price_estimate);
    record('note', 'customer price', `$${customerPrice.toFixed(2)}`);

    const { data: payment1 } = await admin
      .from('payments')
      .select('*')
      .eq('request_id', created.requestId)
      .single();
    if (payment1?.stripe_payment_intent_id) openIntents.add(payment1.stripe_payment_intent_id);
    const intent1 = await stripe.paymentIntents.retrieve(payment1!.stripe_payment_intent_id!);
    ok(
      'Stripe holds the authorization, uncaptured',
      intent1.status === 'requires_capture' && intent1.amount === Math.round(customerPrice * 100),
      `${intent1.status} / ${intent1.amount}`
    );

    // What the driver is told BEFORE accepting.
    actAs(driver.token, 'driver');
    const quoted = await quoteProviderCompensation(customerPrice);
    const expected = settle(customerPrice, {
      commissionPercent: 18,
      paymentProcessingPercent: 2.9,
      paymentProcessingFixed: 0.3,
    });
    ok(
      'the offer quotes the compensation before acceptance',
      quoted != null && near(quoted, expected.providerCompensation!),
      `quoted ${quoted}, expected ${expected.providerCompensation}`
    );

    ok(
      'the request was offered to the fixture driver',
      request1!.driver_id === driver.id,
      `driver_id ${request1!.driver_id}`
    );

    await acceptRequest(created.requestId);
    const { data: accepted } = await admin.from('requests').select('*').eq('id', created.requestId).single();

    ok('the request is matched', accepted!.status === 'matched', accepted!.status);
    ok('economics_frozen_at is set', accepted!.economics_frozen_at != null);
    ok('pricing_config_id points at the fixture configuration', accepted!.pricing_config_id === fixtureConfigV1);
    ok('pricing_config_version is recorded', accepted!.pricing_config_version === draft.version);
    ok(
      'partner_amount matches the model',
      near(money(accepted!.partner_amount), expected.providerCompensation!),
      `${accepted!.partner_amount} vs ${expected.providerCompensation}`
    );
    ok(
      'commission_amount matches the model',
      near(money(accepted!.commission_amount), expected.towconnectMargin!),
      `${accepted!.commission_amount} vs ${expected.towconnectMargin}`
    );
    ok(
      'payment_processing_cost matches the model',
      near(money(accepted!.payment_processing_cost), expected.paymentProcessingCost!),
      `${accepted!.payment_processing_cost} vs ${expected.paymentProcessingCost}`
    );
    ok(
      'the frozen parts add back up to the customer price',
      near(
        money(accepted!.partner_amount) +
          money(accepted!.payment_processing_cost) +
          money(accepted!.commission_amount),
        customerPrice
      ),
      'the identity does not hold on the stored row'
    );

    // ================================================================
    sect('4. Immutability of the promised compensation');
    // ================================================================
    actAs(platformAdmin.token, 'platform admin');
    const frozenBefore = {
      partner: money(accepted!.partner_amount),
      commission: money(accepted!.commission_amount),
      version: accepted!.pricing_config_version,
      configId: accepted!.pricing_config_id,
    };

    const draft2 = await createPricingDraft({
      label: `${FIXTURE_LABEL} v2 (deliberately different)`,
      commissionPercent: 40,
      commissionFixed: null,
      commissionMin: null,
      commissionMax: null,
      providerMinimum: null,
      paymentProcessingPercent: 2.9,
      paymentProcessingFixed: 0.3,
      cancellationFeeCustomer: null,
      cancellationCompensationProvider: null,
      notes: 'Second version, created only to prove an accepted job is not repriced.',
    });
    fixtureConfigV2 = draft2.id;
    await activatePricingConfig(draft2.id);

    const { data: afterRateChange } = await admin
      .from('requests')
      .select('partner_amount, commission_amount, pricing_config_id, pricing_config_version')
      .eq('id', created.requestId)
      .single();
    ok(
      'a rate change does not reprice the accepted job',
      near(money(afterRateChange!.partner_amount), frozenBefore.partner) &&
        near(money(afterRateChange!.commission_amount), frozenBefore.commission),
      `${afterRateChange!.partner_amount} vs ${frozenBefore.partner}`
    );
    ok(
      'the job still points at the version it was priced under',
      afterRateChange!.pricing_config_id === frozenBefore.configId &&
        afterRateChange!.pricing_config_version === frozenBefore.version
    );

    // Put the original back so the rest of the run uses one known rate.
    await activatePricingConfig(fixtureConfigV1);
    const { data: reactivated } = await admin
      .from('pricing_configs')
      .select('status')
      .eq('id', fixtureConfigV1)
      .single();
    ok('the fixture configuration is active again', reactivated!.status === 'active');

    // ================================================================
    sect('6. Supplement (proposed by the driver, approved by the customer)');
    // ================================================================
    actAs(driver.token, 'driver');
    await proposeSupplement(created.requestId, 'winch', 25, 'Phase 7.1 fixture supplement');
    const { data: proposed } = await admin
      .from('request_supplements')
      .select('*')
      .eq('request_id', created.requestId)
      .single();
    ok('the supplement is proposed, not approved', proposed!.status === 'proposed');
    ok('its payment state starts as pending', proposed!.payment_state === 'pending');

    // The driver must not be able to approve their own proposal.
    const { error: selfApprove } = await driver.client
      .from('request_supplements')
      .update({ status: 'approved' })
      .eq('id', proposed!.id);
    const { data: afterSelfApprove } = await admin
      .from('request_supplements')
      .select('status')
      .eq('id', proposed!.id)
      .single();
    ok(
      'the driver cannot approve their own supplement',
      Boolean(selfApprove) || afterSelfApprove!.status === 'proposed',
      'a driver approved their own supplement'
    );

    const intentBeforeSupplement = await stripe.paymentIntents.retrieve(payment1!.stripe_payment_intent_id!);

    actAs(rider.token, 'rider');
    await respondToSupplement(proposed!.id, true);

    const { data: settledSupplement } = await admin
      .from('request_supplements')
      .select('*')
      .eq('id', proposed!.id)
      .single();
    ok('the customer approved it', settledSupplement!.status === 'approved');

    // Phase 8.1: the point of the fallback is that "approved" now leads to
    // "collected". `uncollected` is still a legitimate outcome, but it must be
    // the exception rather than the only path.
    ok(
      'the supplement was collected rather than abandoned',
      settledSupplement!.payment_state === 'settled',
      `payment_state ${settledSupplement!.payment_state}: ${settledSupplement!.payment_note ?? 'no note'}`
    );
    ok(
      'it was collected on a PaymentIntent of its own',
      settledSupplement!.collection_method === 'separate_payment_intent',
      String(settledSupplement!.collection_method)
    );
    record(
      'note',
      'incremental authorization was attempted first and refused',
      'this account is not eligible for the feature — see TOWCONNECT_PHASE7_1_REPORT.md §4'
    );

    const supplementIntentId = settledSupplement!.stripe_payment_intent_id as string;
    ok('a supplement PaymentIntent id was stored', Boolean(supplementIntentId));

    const supplementIntent = await stripe.paymentIntents.retrieve(supplementIntentId);
    ok(
      'Stripe confirms the supplement charge succeeded for the right amount',
      supplementIntent.status === 'succeeded' && supplementIntent.amount === 2500,
      `${supplementIntent.status} / ${supplementIntent.amount}`
    );
    ok(
      'the supplement intent carries the metadata that routes its webhooks',
      supplementIntent.metadata?.towconnect_supplement_id === proposed!.id
    );

    const intentAfterSupplement = await stripe.paymentIntents.retrieve(payment1!.stripe_payment_intent_id!);
    ok(
      'the fare authorization was left exactly as it was',
      intentAfterSupplement.amount === intentBeforeSupplement.amount,
      `${intentBeforeSupplement.amount} -> ${intentAfterSupplement.amount}`
    );

    // ---- the provider is credited once, from the FROZEN configuration ----
    const supplementExpected = settle(customerPrice + 25, {
      commissionPercent: 18,
      paymentProcessingPercent: 2.9,
      paymentProcessingFixed: 0.3,
    });
    const expectedSupplementShare =
      Math.round((supplementExpected.providerCompensation! - expected.providerCompensation!) * 100) / 100;

    const { data: supplementEntries } = await admin
      .from('provider_ledger_entries')
      .select('*')
      .eq('supplement_id', proposed!.id);
    ok(
      'exactly one ledger entry exists for the supplement',
      (supplementEntries ?? []).length === 1,
      `${(supplementEntries ?? []).length} entries`
    );
    ok(
      "the credit uses the job's frozen configuration, not today's",
      (supplementEntries ?? []).length === 1 &&
        near(money(supplementEntries![0].amount), expectedSupplementShare),
      `${supplementEntries?.[0]?.amount} vs ${expectedSupplementShare}`
    );
    ok(
      'the supplement credit is payable, because the money was actually taken',
      (supplementEntries ?? []).length === 1 && supplementEntries![0].available_at != null
    );

    // Replaying the credit must write nothing: the unique index on
    // supplement_id is what makes that structural rather than remembered.
    const { creditSettledSupplement } = await import('@/lib/actions/finance');
    await creditSettledSupplement(proposed!.id);
    const { data: afterReplayCredit } = await admin
      .from('provider_ledger_entries')
      .select('id')
      .eq('supplement_id', proposed!.id);
    ok(
      'crediting the same supplement twice writes nothing the second time',
      (afterReplayCredit ?? []).length === 1,
      `${(afterReplayCredit ?? []).length} entries after replay`
    );

    // Settling it again must not create a second charge either.
    const { settleApprovedSupplement } = await import('@/lib/actions/finance');
    await settleApprovedSupplement(proposed!.id);
    const { data: afterReplaySettle } = await admin
      .from('request_supplements')
      .select('stripe_payment_intent_id')
      .eq('id', proposed!.id)
      .single();
    ok(
      'settling an already-collected supplement does not charge the customer twice',
      afterReplaySettle!.stripe_payment_intent_id === supplementIntentId,
      `${supplementIntentId} -> ${afterReplaySettle!.stripe_payment_intent_id}`
    );

    // ---- the customer's receipt tells the truth about it ----------------
    const { data: receiptSupplements } = await admin
      .from('request_supplements')
      .select('amount, status, payment_state')
      .eq('request_id', created.requestId);
    const chargedOnReceipt = (receiptSupplements ?? [])
      .filter((x) => x.status === 'approved' && (x.payment_state === 'settled' || x.payment_state === 'authorized'))
      .reduce((sum, x) => sum + money(x.amount), 0);
    ok(
      'the receipt would show the supplement as charged',
      near(chargedOnReceipt, 25),
      `$${chargedOnReceipt.toFixed(2)} shown as charged`
    );

    // ================================================================
    sect('5. Completion, capture and the provider ledger');
    // ================================================================
    actAs(driver.token, 'driver');
    for (const next of ['en_route', 'arrived', 'in_progress', 'completed'] as const) {
      await advanceRequestStatus(created.requestId, next);
    }

    const intentAfterCapture = await stripe.paymentIntents.retrieve(payment1!.stripe_payment_intent_id!);
    ok('Stripe captured the payment', intentAfterCapture.status === 'succeeded', intentAfterCapture.status);

    // Stripe delivers its own events to the DEPLOYED endpoint while this runs,
    // and it does not promise delivery order. The first run of this harness
    // caught a late authorization event rewriting a captured payment as
    // merely authorized — so the row is polled rather than read once, and the
    // events actually delivered are printed as evidence either way.
    let paymentStatus = '';
    for (let attempt = 0; attempt < 10; attempt++) {
      const { data: row } = await admin.from('payments').select('status').eq('id', payment1!.id).single();
      paymentStatus = row!.status as string;
      if (paymentStatus === 'captured') break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    ok('our payments row settles on captured', paymentStatus === 'captured', `final status ${paymentStatus}`);

    const { data: delivered } = await admin
      .from('stripe_webhook_events')
      .select('type, processed_at')
      .order('processed_at', { ascending: false })
      .limit(8);
    record(
      'note',
      'webhook events delivered around the capture',
      (delivered ?? []).map((e) => e.type).join(', ') || 'none recorded'
    );
    openIntents.delete(payment1!.stripe_payment_intent_id!);

    const { data: ledger1 } = await admin
      .from('provider_ledger_entries')
      .select('*')
      .eq('request_id', created.requestId)
      .order('id');
    const earnings = (ledger1 ?? []).filter((e) => e.entry_type === 'earning');
    ok('exactly one earning entry was written', earnings.length === 1, `${earnings.length} earning entries`);
    ok(
      'the earning equals the frozen compensation',
      earnings.length === 1 && near(money(earnings[0].amount), frozenBefore.partner),
      `${earnings[0]?.amount} vs ${frozenBefore.partner}`
    );
    ok(
      'the earning is payable because the capture succeeded',
      earnings.length === 1 && earnings[0].available_at != null,
      'the earning was left pending after a successful capture'
    );
    const ledgerSupplements = (ledger1 ?? []).filter((e) => e.entry_type === 'supplement');
    ok(
      'the collected supplement credited the provider exactly once',
      ledgerSupplements.length === 1,
      `${ledgerSupplements.length} supplement entries`
    );
    ok(
      'every supplement credit is keyed to the supplement it paid for',
      ledgerSupplements.every((e) => e.supplement_id != null),
      'a supplement entry has no supplement_id, so a replay could duplicate it'
    );

    // Replay: running the credit again must not double-pay.
    const { recordJobEarning } = await import('@/lib/actions/finance');
    await recordJobEarning(created.requestId);
    const { data: ledgerAfterReplay } = await admin
      .from('provider_ledger_entries')
      .select('id')
      .eq('request_id', created.requestId)
      .eq('entry_type', 'earning');
    ok(
      'crediting the same job twice writes nothing the second time',
      (ledgerAfterReplay ?? []).length === 1,
      `${(ledgerAfterReplay ?? []).length} earning entries after replay`
    );

    // Balances must be the sum of the entries, not a stored number.
    actAs(ownerA.token, 'company A owner');
    const balances1 = await getProviderBalances(coA);
    const { data: allEntriesA } = await admin
      .from('provider_ledger_entries')
      .select('amount, available_at, entry_type')
      .eq('company_id', coA);
    const expectedAvailable = (allEntriesA ?? [])
      .filter((e) => e.available_at && new Date(e.available_at).getTime() <= Date.now())
      .reduce((s, e) => s + money(e.amount), 0);
    ok(
      'provider_balances() reconciles exactly with the ledger',
      near(money(balances1.available), expectedAvailable),
      `${balances1.available} vs ${expectedAvailable.toFixed(2)}`
    );

    // ================================================================
    sect('7. Partial refund');
    // ================================================================
    actAs(platformAdmin.token, 'platform admin');
    const partialAmount = Math.round(customerPrice * 0.4 * 100) / 100;
    const refund = await issueRefund({
      requestId: created.requestId,
      amount: partialAmount,
      reason: 'Phase 7.1 — partial refund fixture',
    });
    ok('the refund row was created', Boolean(refund.id));
    ok('Stripe returned a refund id', Boolean(refund.stripe_refund_id), 'no stripe_refund_id was stored');
    ok('the refund succeeded', refund.status === 'succeeded', refund.status as string);

    const stripeRefund = await stripe.refunds.retrieve(refund.stripe_refund_id!);
    ok(
      'Stripe agrees on the amount refunded',
      stripeRefund.amount === Math.round(partialAmount * 100),
      `${stripeRefund.amount} vs ${Math.round(partialAmount * 100)}`
    );

    const { data: paymentAfterPartial } = await admin
      .from('payments')
      .select('status')
      .eq('id', payment1!.id)
      .single();
    ok(
      'a partial refund does not mark the payment fully refunded',
      paymentAfterPartial!.status === 'captured',
      paymentAfterPartial!.status
    );

    const { data: reversals } = await admin
      .from('provider_ledger_entries')
      .select('*')
      .eq('request_id', created.requestId)
      .eq('entry_type', 'refund_reversal');
    record('note', 'partial refund is against the fare, not the supplement', 'the supplement has its own charge and its own refund path');
    const providerShare = frozenBefore.partner / customerPrice;
    const expectedClawback = Math.round(partialAmount * providerShare * 100) / 100;
    ok('exactly one reversal entry was written', (reversals ?? []).length === 1);
    ok(
      "the reversal takes back the provider's proportional share",
      (reversals ?? []).length === 1 && near(Math.abs(money(reversals![0].amount)), expectedClawback),
      `${reversals?.[0]?.amount} vs -${expectedClawback}`
    );
    ok(
      'the reversal is negative, and the original earning is untouched',
      (reversals ?? []).length === 1 && money(reversals![0].amount) < 0 && earnings.length === 1
    );

    // Idempotency of the refund itself: the same request cannot be refunded
    // past what is left.
    let overRefundRefused = false;
    try {
      await issueRefund({
        requestId: created.requestId,
        amount: customerPrice,
        reason: 'Phase 7.1 — deliberate over-refund attempt',
      });
    } catch {
      overRefundRefused = true;
    }
    ok('refunding more than remains is refused', overRefundRefused);

    // ================================================================
    sect('7c. Refunding a supplement on its own charge');
    // ================================================================
    // The supplement has its own PaymentIntent, so it must be refundable
    // without touching the fare the customer already accepted — and refunding
    // it must claw back only the provider's share OF THAT SUPPLEMENT.
    actAs(platformAdmin.token, 'platform admin');
    const supplementRefundAmount = 10;
    const supplementRefund = await issueRefund({
      requestId: created.requestId,
      supplementId: proposed!.id,
      amount: supplementRefundAmount,
      reason: 'Phase 8.1 — partial supplement refund',
    });
    ok('the supplement refund succeeded', supplementRefund.status === 'succeeded', supplementRefund.status as string);
    ok('the refund row names the supplement it belongs to', supplementRefund.supplement_id === proposed!.id);

    const supplementStripeRefund = await stripe.refunds.retrieve(supplementRefund.stripe_refund_id!);
    ok(
      'Stripe refunded it against the supplement intent, not the fare',
      supplementStripeRefund.payment_intent === supplementIntentId,
      String(supplementStripeRefund.payment_intent)
    );

    const fareIntentAfterSupplementRefund = await stripe.paymentIntents.retrieve(
      payment1!.stripe_payment_intent_id!
    );
    ok(
      'the fare charge was untouched by the supplement refund',
      fareIntentAfterSupplementRefund.amount_received === intentAfterCapture.amount_received,
      `${intentAfterCapture.amount_received} -> ${fareIntentAfterSupplementRefund.amount_received}`
    );

    const { data: supplementReversals } = await admin
      .from('provider_ledger_entries')
      .select('amount, metadata')
      .eq('request_id', created.requestId)
      .eq('entry_type', 'refund_reversal');
    const supplementClawback = supplementReversals?.find(
      (e) => (e.metadata as { supplement_id?: string } | null)?.supplement_id === proposed!.id
    );
    const expectedSupplementClawback =
      Math.round(supplementRefundAmount * (expectedSupplementShare / 25) * 100) / 100;
    ok(
      "the clawback is proportional to the provider's share of that supplement",
      supplementClawback != null && near(Math.abs(money(supplementClawback.amount)), expectedSupplementClawback),
      `${supplementClawback?.amount} vs -${expectedSupplementClawback}`
    );

    let overRefundSupplementRefused = false;
    try {
      await issueRefund({
        requestId: created.requestId,
        supplementId: proposed!.id,
        amount: 25,
        reason: 'Phase 8.1 — deliberate over-refund of a supplement',
      });
    } catch {
      overRefundSupplementRefused = true;
    }
    ok('refunding more than the supplement is worth is refused', overRefundSupplementRefused);

    // ================================================================
    sect('7b. Webhook replay and idempotency');
    // ================================================================
    // Wait for Stripe's own delivery first: replaying an event the endpoint
    // has never seen would prove the handler works, not that it deduplicates.
    let refundEventId: string | null = null;
    for (let attempt = 0; attempt < 12 && !refundEventId; attempt++) {
      const events = await stripe.events.list({ type: 'charge.refunded', limit: 10 });
      const match = events.data.find((e) => {
        const charge = e.data.object as Stripe.Charge;
        return charge.payment_intent === payment1!.stripe_payment_intent_id;
      });
      if (match) {
        refundEventId = match.id;
        break;
      }
      await new Promise((r) => setTimeout(r, 2500));
    }

    if (!refundEventId || !WEBHOOK_SECRET) {
      record(
        'manual',
        'webhook replay could not run',
        !WEBHOOK_SECRET
          ? 'STRIPE_WEBHOOK_SECRET is not configured'
          : 'Stripe had not produced a charge.refunded event for this payment yet'
      );
    } else {
      const { data: ledgerBeforeReplay } = await admin
        .from('provider_ledger_entries')
        .select('id')
        .eq('request_id', created.requestId);
      const { data: refundsBeforeReplay } = await admin
        .from('refunds')
        .select('id')
        .eq('request_id', created.requestId);

      const first = await replayEvent(refundEventId);
      ok(
        'a correctly signed replay is accepted (the signature really verifies)',
        first.status === 200,
        `${first.status} ${first.body}`
      );
      const second = await replayEvent(refundEventId);
      ok(
        'the same event delivered again is deduplicated',
        second.status === 200 && /deduplicated/.test(second.body),
        `${second.status} ${second.body}`
      );

      const { data: ledgerAfterReplay } = await admin
        .from('provider_ledger_entries')
        .select('id')
        .eq('request_id', created.requestId);
      const { data: refundsAfterReplay } = await admin
        .from('refunds')
        .select('id')
        .eq('request_id', created.requestId);
      ok(
        'replaying the event wrote no second ledger entry',
        (ledgerAfterReplay ?? []).length === (ledgerBeforeReplay ?? []).length,
        `${(ledgerBeforeReplay ?? []).length} -> ${(ledgerAfterReplay ?? []).length}`
      );
      ok(
        'replaying the event wrote no second refund row',
        (refundsAfterReplay ?? []).length === (refundsBeforeReplay ?? []).length,
        `${(refundsBeforeReplay ?? []).length} -> ${(refundsAfterReplay ?? []).length}`
      );

      const { data: eventRow } = await admin
        .from('stripe_webhook_events')
        .select('stripe_event_id')
        .eq('stripe_event_id', refundEventId)
        .maybeSingle();
      ok('the event id is in the idempotency ledger exactly once', eventRow != null);
    }

    // ---- the DEPLOYED endpoint, without needing any secret ----------
    // Three questions the in-process replay above cannot answer, because it
    // never leaves this machine: does the live endpoint refuse unsigned
    // traffic, does it refuse a forgery, and does it hold the right signing
    // secret. The first two are asked directly; the third is answered by
    // Stripe's own delivery record, which is better evidence than anything
    // this suite could construct.
    // A handler with no secret must refuse rather than fall through. Checked
    // by taking the secret away for one call and putting it back — the only
    // way to exercise a branch that should never be reachable in production.
    const heldSecret = process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const noSecret = await webhookHandler(
      new Request(WEBHOOK_ENDPOINT, {
        method: 'POST',
        headers: { 'stripe-signature': 't=1,v1=deadbeef' },
        body: '{}',
      })
    );
    process.env.STRIPE_WEBHOOK_SECRET = heldSecret;
    ok(
      'the handler refuses to run at all with no signing secret configured',
      noSecret.status === 503,
      String(noSecret.status)
    );
    ok(
      'and the signing secret is back in place for the rest of the run',
      process.env.STRIPE_WEBHOOK_SECRET === heldSecret
    );

    const unsigned = await postToDeployedEndpoint(JSON.stringify({ id: 'evt_forged', type: 'ping' }), {});
    ok(
      'the deployed endpoint refuses an unsigned request',
      unsigned.status === 400,
      `${unsigned.status} ${unsigned.body}`
    );
    ok('and says the signature was missing', /Missing signature/i.test(unsigned.body), unsigned.body);

    const forged = await postToDeployedEndpoint(JSON.stringify({ id: 'evt_forged', type: 'ping' }), {
      'stripe-signature': `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}`,
    });
    ok(
      'the deployed endpoint refuses a forged signature',
      forged.status === 400,
      `${forged.status} ${forged.body}`
    );
    ok('and says the signature was invalid', /Invalid signature/i.test(forged.body), forged.body);

    // THE PARITY CHECK THAT REPLACED THE SECRET COMPARISON.
    // Stripe signs every delivery with the endpoint's own secret. An event
    // that is no longer pending is an event the deployment verified and
    // accepted — so "the deployment holds the right secret" is answered by
    // Stripe rather than asserted by us, and it keeps being answered every
    // time this suite runs.
    const dayAgo = Math.floor(Date.now() / 1000) - 24 * 3600;
    const recentEvents = await stripe.events.list({ limit: 100, created: { gte: dayAgo } });
    const stuck = recentEvents.data.filter((e) => (e.pending_webhooks ?? 0) > 0);
    ok(
      'Stripe has no event still pending delivery to the endpoint',
      stuck.length === 0,
      stuck.length
        ? `${stuck.length} event(s) undelivered — the deployment is rejecting Stripe's signatures, ` +
          'which means its STRIPE_WEBHOOK_SECRET is not the one on the endpoint'
        : `${recentEvents.data.length} event(s) in 24h, all delivered`
    );

    const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
    const live = endpoints.data.filter((e) => e.status === 'enabled');
    ok(
      'exactly one enabled endpoint is configured',
      live.length === 1,
      live.map((e) => e.url).join(', ')
    );
    ok(
      'and it points at the deployment this suite tested',
      live[0]?.url === WEBHOOK_ENDPOINT,
      `${live[0]?.url} vs ${WEBHOOK_ENDPOINT}`
    );

    // ================================================================
    sect('9. Cancellations');
    // ================================================================
    actAs(rider.token, 'rider');
    const beforeMatch = await createRequestOrFail({
      problemType: 'battery',
      locationText: 'Phase 7.1 — cancel before match',
      lat: MTL.lat,
      lng: MTL.lng,
      vehicleDesc: 'Fixture vehicle',
      notes: '',
    });
    const { data: bmPayment } = await admin
      .from('payments')
      .select('*')
      .eq('request_id', beforeMatch.requestId)
      .single();
    if (bmPayment?.stripe_payment_intent_id) openIntents.add(bmPayment.stripe_payment_intent_id);

    await cancelRequest(beforeMatch.requestId);
    const { data: bmRequest } = await admin
      .from('requests')
      .select('status, cancellation_fee_charged, cancellation_compensation, cancellation_settled_at')
      .eq('id', beforeMatch.requestId)
      .single();
    ok('the request is cancelled', bmRequest!.status === 'cancelled');
    // Zero here is a DECISION, not a gap: nobody performed any work, so
    // nothing is owed either way. That is different from the NULL recorded
    // after matching below, which means "no cancellation policy exists".
    ok(
      'cancelling before matching charges nothing and pays nothing',
      money(bmRequest!.cancellation_fee_charged) === 0 && money(bmRequest!.cancellation_compensation) === 0,
      `fee ${bmRequest!.cancellation_fee_charged}, compensation ${bmRequest!.cancellation_compensation}`
    );
    ok(
      'and it is recorded as settled rather than left unanswered',
      bmRequest!.cancellation_settled_at != null
    );
    if (bmPayment?.stripe_payment_intent_id) {
      const bmIntent = await stripe.paymentIntents.retrieve(bmPayment.stripe_payment_intent_id);
      ok('the authorization hold was released', bmIntent.status === 'canceled', bmIntent.status);
      if (bmIntent.status === 'canceled') openIntents.delete(bmPayment.stripe_payment_intent_id);
    }

    // After matching, with no cancellation policy configured.
    const afterMatch = await createRequestOrFail({
      problemType: 'battery',
      locationText: 'Phase 7.1 — cancel after match',
      lat: MTL.lat,
      lng: MTL.lng,
      vehicleDesc: 'Fixture vehicle',
      notes: '',
    });
    const { data: amPayment } = await admin
      .from('payments')
      .select('*')
      .eq('request_id', afterMatch.requestId)
      .single();
    if (amPayment?.stripe_payment_intent_id) openIntents.add(amPayment.stripe_payment_intent_id);

    actAs(driver.token, 'driver');
    await acceptRequest(afterMatch.requestId);
    actAs(rider.token, 'rider');
    await cancelRequest(afterMatch.requestId);

    const { data: amRequest } = await admin
      .from('requests')
      .select('status, cancellation_fee_charged, cancellation_compensation, partner_amount')
      .eq('id', afterMatch.requestId)
      .single();
    ok('the matched request is cancelled', amRequest!.status === 'cancelled');
    // NULL, not zero: after matching a fee COULD be owed, and whether it is
    // depends on a policy nobody has written. Recording zero would be
    // inventing the answer.
    ok(
      'after matching, with no policy configured, nothing is decided and nothing is charged',
      amRequest!.cancellation_fee_charged == null && amRequest!.cancellation_compensation == null,
      `fee ${amRequest!.cancellation_fee_charged}, compensation ${amRequest!.cancellation_compensation}`
    );
    const { data: amLedger } = await admin
      .from('provider_ledger_entries')
      .select('id')
      .eq('request_id', afterMatch.requestId);
    ok('a cancelled job credits the provider nothing', (amLedger ?? []).length === 0);
    if (amPayment?.stripe_payment_intent_id) {
      const amIntent = await stripe.paymentIntents.retrieve(amPayment.stripe_payment_intent_id);
      ok('the hold on the cancelled matched job was released', amIntent.status === 'canceled', amIntent.status);
      if (amIntent.status === 'canceled') openIntents.delete(amPayment.stripe_payment_intent_id);
    }

    // ================================================================
    sect('8. Full refund on a separate fixture');
    // ================================================================
    actAs(rider.token, 'rider');
    const full = await createRequestOrFail({
      problemType: 'battery',
      locationText: 'Phase 7.1 — full refund fixture',
      lat: MTL.lat,
      lng: MTL.lng,
      vehicleDesc: 'Fixture vehicle',
      notes: '',
    });
    const { data: fullRequest } = await admin.from('requests').select('*').eq('id', full.requestId).single();
    const fullPrice = money(fullRequest!.price_estimate);
    const { data: fullPayment } = await admin
      .from('payments')
      .select('*')
      .eq('request_id', full.requestId)
      .single();
    if (fullPayment?.stripe_payment_intent_id) openIntents.add(fullPayment.stripe_payment_intent_id);

    actAs(driver.token, 'driver');
    await acceptRequest(full.requestId);
    for (const next of ['en_route', 'arrived', 'in_progress', 'completed'] as const) {
      await advanceRequestStatus(full.requestId, next);
    }
    openIntents.delete(fullPayment!.stripe_payment_intent_id!);

    const { data: fullFrozen } = await admin
      .from('requests')
      .select('partner_amount')
      .eq('id', full.requestId)
      .single();

    actAs(platformAdmin.token, 'platform admin');
    const fullRefund = await issueRefund({
      requestId: full.requestId,
      amount: fullPrice,
      reason: 'Phase 7.1 — full refund fixture',
    });
    ok('the full refund succeeded', fullRefund.status === 'succeeded', fullRefund.status as string);

    const { data: fullPaymentAfter } = await admin
      .from('payments')
      .select('status')
      .eq('id', fullPayment!.id)
      .single();
    ok(
      'a full refund marks the payment refunded',
      fullPaymentAfter!.status === 'refunded',
      fullPaymentAfter!.status
    );

    const { data: fullLedger } = await admin
      .from('provider_ledger_entries')
      .select('amount, entry_type')
      .eq('request_id', full.requestId);
    const fullNet = (fullLedger ?? []).reduce((s, e) => s + money(e.amount), 0);
    ok(
      'a fully refunded job leaves the provider with nothing',
      near(fullNet, 0, 0.02),
      `net ${fullNet.toFixed(2)} (earning ${fullFrozen!.partner_amount})`
    );

    // ================================================================
    sect('10. Payout (prepared internally — not executed by Stripe)');
    // ================================================================
    actAs(ownerA.token, 'company A owner');
    const balancesBeforePayout = await getProviderBalances(coA);
    const available = money(balancesBeforePayout.available);
    record('note', 'available balance before payout', `$${available.toFixed(2)}`);

    actAs(platformAdmin.token, 'platform admin');
    let payoutId: string | null = null;
    if (available > 0.01) {
      const payout = await preparePayout(coA, Math.round(available * 100) / 100);
      payoutId = payout.id;
      ok('a payout row is created in state pending', payout.state === 'pending', payout.state);
      ok('no Stripe transfer id is claimed', payout.stripe_transfer_id == null);

      const { data: payoutEntry } = await admin
        .from('provider_ledger_entries')
        .select('amount, entry_type')
        .eq('payout_id', payout.id)
        .single();
      ok(
        'a matching negative ledger entry was written',
        payoutEntry!.entry_type === 'payout' && near(money(payoutEntry!.amount), -available),
        `${payoutEntry!.amount} vs -${available.toFixed(2)}`
      );

      actAs(ownerA.token, 'company A owner');
      const balancesAfterPayout = await getProviderBalances(coA);
      ok(
        'the available balance drops by exactly the payout',
        near(money(balancesAfterPayout.available), 0, 0.02),
        `available is now ${balancesAfterPayout.available}`
      );
      ok(
        'the paid total rises by exactly the payout',
        near(money(balancesAfterPayout.paid_total), available),
        `${balancesAfterPayout.paid_total} vs ${available.toFixed(2)}`
      );

      actAs(platformAdmin.token, 'platform admin');
      let secondPayoutRefused = false;
      try {
        await preparePayout(coA, available);
      } catch {
        secondPayoutRefused = true;
      }
      ok('a second payout of the same money is refused', secondPayoutRefused);
    } else {
      record('fail', 'a payout could be prepared', 'no available balance existed to pay out');
    }
    record(
      'note',
      'payout status: PREPARED INTERNALLY, not executed by Stripe',
      'no Transfer or Payout API call is implemented in Phase 7 — the row and the ledger entry are the whole mechanism'
    );

    // ================================================================
    sect('11. Permissions, with real sessions');
    // ================================================================
    const denied = async (what: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
        ok(what, false, 'the action was allowed');
      } catch {
        ok(what, true);
      }
    };

    actAs(driver.token, 'driver');
    await denied("a driver cannot read their company's balances", () => getProviderBalances(coA));
    await denied('a driver cannot issue a refund', () =>
      issueRefund({ requestId: created.requestId, amount: 1, reason: 'attempt' })
    );
    await denied('a driver cannot prepare a payout', () => preparePayout(coA, 1));
    await denied('a driver cannot read the platform finance overview', () => getAdminFinanceOverview());

    actAs(dispatcherA.token, 'company A dispatcher');
    await denied('a dispatcher cannot issue a refund', () =>
      issueRefund({ requestId: created.requestId, amount: 1, reason: 'attempt' })
    );
    await denied('a dispatcher cannot prepare a payout', () => preparePayout(coA, 1));
    await denied("a dispatcher cannot read their company's balances", () => getProviderBalances(coA));

    actAs(ownerB.token, 'company B owner');
    await denied("a company owner cannot read another company's balances", () => getProviderBalances(coA));
    const crossLedger = await listLedgerEntries(coA);
    ok("a company owner sees none of another company's ledger", crossLedger.length === 0, `${crossLedger.length} rows`);

    actAs(rider.token, 'rider');
    await denied('a customer cannot issue a refund', () =>
      issueRefund({ requestId: created.requestId, amount: 1, reason: 'attempt' })
    );

    actAs(ownerA.token, 'company A owner');
    const ownBalances = await getProviderBalances(coA);
    ok('a company owner can read their own balances', ownBalances != null);
    const ownLedger = await listLedgerEntries(coA);
    ok('a company owner can read their own ledger', ownLedger.length > 0, `${ownLedger.length} rows`);

    actAs(platformAdmin.token, 'platform admin');
    const overview = await getAdminFinanceOverview();
    ok('a platform admin can read the finance overview', overview.companies.length > 0);

    // ================================================================
    sect('13. Failure injection');
    // ================================================================
    const realKey = process.env.STRIPE_SECRET_KEY;
    const { assertSandbox } = await import('@/lib/stripe/mode');

    for (const [label, key] of [
      ['a live key', 'sk_live_notarealkey'],
      ['an unclassifiable key', 'definitely-not-a-stripe-key'],
      ['no key at all', undefined],
    ] as [string, string | undefined][]) {
      process.env.STRIPE_SECRET_KEY = key;
      let refused = false;
      try {
        assertSandbox();
      } catch {
        refused = true;
      }
      ok(`${label} is refused before any Stripe call`, refused);
    }
    process.env.STRIPE_SECRET_KEY = realKey;
    ok('the real test key is restored', stripeKeyMode(process.env.STRIPE_SECRET_KEY) === 'test');

    actAs(platformAdmin.token, 'platform admin');
    let payoutOverBalanceRefused = false;
    try {
      await preparePayout(coB, 500);
    } catch {
      payoutOverBalanceRefused = true;
    }
    ok('a payout larger than the balance is refused', payoutOverBalanceRefused);

    let refundOnUncapturedRefused = false;
    try {
      await issueRefund({
        requestId: beforeMatch.requestId,
        amount: 5,
        reason: 'Phase 7.1 — refund on a cancelled request',
      });
    } catch {
      refundOnUncapturedRefused = true;
    }
    ok('a refund on a payment that was never captured is refused', refundOnUncapturedRefused);

    let emptyReasonRefused = false;
    try {
      await issueRefund({ requestId: created.requestId, amount: 1, reason: '   ' });
    } catch {
      emptyReasonRefused = true;
    }
    ok('a refund with no stated reason is refused', emptyReasonRefused);

    if (payoutId) {
      await setPayoutState(payoutId, 'reversed', 'Phase 7.1 — reversal fixture');
      const { data: reversalEntry } = await admin
        .from('provider_ledger_entries')
        .select('amount, entry_type')
        .eq('payout_id', payoutId)
        .eq('entry_type', 'payout_reversal')
        .maybeSingle();
      ok(
        'a reversed payout puts the money back with a new entry',
        reversalEntry != null && money(reversalEntry.amount) > 0,
        'no payout_reversal entry was written'
      );
    }

    // ================================================================
    sect('12. Reconciliation, to the cent');
    // ================================================================
    const reconcile = async (requestId: string, label: string) => {
      const { data: r } = await admin
        .from('requests')
        .select('price_estimate, partner_amount, commission_amount, payment_processing_cost, status')
        .eq('id', requestId)
        .single();
      if (!r || r.partner_amount == null) {
        record('note', `${label}: no frozen economics`, 'nothing to reconcile');
        return;
      }
      const price = money(r.price_estimate);
      const sum = money(r.partner_amount) + money(r.commission_amount) + money(r.payment_processing_cost);
      const drift = Math.abs(sum - price);
      record(
        drift < 0.005 ? 'pass' : 'fail',
        `${label}: customer = provider + TowConnect + processing`,
        `$${price.toFixed(2)} vs $${sum.toFixed(2)} (drift $${drift.toFixed(4)})`
      );

      // The fare and each supplement are separate charges with separate
      // refunds, so the expected net has to be built the same way rather than
      // treating every refund as if it came out of the fare.
      const { data: refundRows } = await admin
        .from('refunds')
        .select('amount, status, supplement_id')
        .eq('request_id', requestId);
      const succeeded = (refundRows ?? []).filter((x) => x.status === 'succeeded');

      const { data: entries } = await admin
        .from('provider_ledger_entries')
        .select('amount, entry_type, supplement_id')
        .eq('request_id', requestId);
      const providerNet = (entries ?? []).reduce((s, e) => s + money(e.amount), 0);

      // A job that never completed was priced but never earned.
      const earned = r.status === 'completed' ? money(r.partner_amount) : 0;
      const fareRefunded = succeeded
        .filter((x) => x.supplement_id == null)
        .reduce((s, x) => s + money(x.amount), 0);
      let expectedNet = earned - Math.round(fareRefunded * (earned / price) * 100) / 100;

      const { data: supplementRows } = await admin
        .from('request_supplements')
        .select('id, amount, payment_state')
        .eq('request_id', requestId);
      for (const supplement of supplementRows ?? []) {
        const credit = (entries ?? []).find((e) => e.supplement_id === supplement.id);
        if (!credit) continue;
        const creditAmount = money(credit.amount);
        const refundedHere = succeeded
          .filter((x) => x.supplement_id === supplement.id)
          .reduce((s, x) => s + money(x.amount), 0);
        const clawback =
          Math.round(refundedHere * (creditAmount / money(supplement.amount)) * 100) / 100;
        expectedNet += creditAmount - clawback;
      }

      record(
        near(providerNet, expectedNet, 0.02) ? 'pass' : 'fail',
        `${label}: provider net after refunds`,
        `ledger $${providerNet.toFixed(2)} vs expected $${expectedNet.toFixed(2)} ` +
          `(fare refunded $${fareRefunded.toFixed(2)}, total refunded $${succeeded
            .reduce((s, x) => s + money(x.amount), 0)
            .toFixed(2)})`
      );

      // Each supplement obeys the same identity as the fare, on the job's
      // FROZEN configuration — to the cent.
      for (const supplement of supplementRows ?? []) {
        if (supplement.payment_state !== 'settled') continue;
        const credit = (entries ?? []).find((e) => e.supplement_id === supplement.id);
        if (!credit) continue;
        const amount = money(supplement.amount);
        const providerPart = money(credit.amount);
        const frozen = {
          commissionPercent: 18,
          paymentProcessingPercent: 2.9,
          paymentProcessingFixed: 0.3,
        };
        // Marginal by construction: with the supplement, minus without it.
        const withThis = settle(price + amount, frozen);
        const without = settle(price, frozen);
        const expectedProvider =
          Math.round((withThis.providerCompensation! - without.providerCompensation!) * 100) / 100;
        const expectedProcessing =
          Math.round((withThis.paymentProcessingCost! - without.paymentProcessingCost!) * 100) / 100;
        const expectedMargin =
          Math.round((withThis.towconnectMargin! - without.towconnectMargin!) * 100) / 100;
        const sum = expectedProvider + expectedProcessing + expectedMargin;
        record(
          near(providerPart, expectedProvider) && near(sum, amount, 0.02) ? 'pass' : 'fail',
          `${label}: supplement identity`,
          `customer $${amount.toFixed(2)} = provider $${expectedProvider.toFixed(2)} ` +
            `+ TowConnect $${expectedMargin.toFixed(2)} + processing $${expectedProcessing.toFixed(2)} ` +
            `(ledger credited $${providerPart.toFixed(2)})`
        );
      }
    };

    await reconcile(created.requestId, 'main course');
    await reconcile(full.requestId, 'fully refunded course');
    await reconcile(afterMatch.requestId, 'cancelled after match');

    // ================================================================
    sect('12b. The standalone reconciler, run against the live fixture data');
    // ================================================================
    // verify:finance is the cheap, repeatable check meant to be run after any
    // deploy. Running it HERE, before cleanup, is the only moment it has real
    // money to look at — against an empty database it would pass vacuously.
    try {
      const output = execFileSync('npx', ['tsx', 'scripts/verify-finance.ts'], {
        encoding: 'utf8',
        shell: process.platform === 'win32',
        env: { ...process.env, VERIFY_FINANCE_ALLOW_ACTIVE: '1' },
      });
      const lines = output.trim().split(String.fromCharCode(10));
      const summary = lines[lines.length - 1].trim();
      const failed = /✗/.test(output);
      ok('verify:finance reconciles the fixture data', !failed, output.slice(-600));
      record('note', 'verify:finance', summary);
    } catch (e) {
      const output = (e as { stdout?: string }).stdout ?? String(e);
      ok('verify:finance reconciles the fixture data', false, String(output).slice(-600));
    }

    // ================================================================
    sect('14. Cleanup');
    // ================================================================
  } finally {
    // Whatever happened above, the commercial state must come back to where
    // it started: no rate configured, no fixture money left hanging.
    actAs(adminTokenForCleanup, 'platform admin');

    for (const accountId of connectAccountIds) {
      try {
        // A test-mode connected account left behind is clutter in someone's
        // Stripe dashboard, and this one was created by a fixture company
        // that is about to stop existing.
        await stripe.accounts.del(accountId);
      } catch {
        // Already gone, or Stripe refuses — reported by the listing below.
      }
    }

    for (const intentId of openIntents) {
      try {
        await stripe.paymentIntents.cancel(intentId);
      } catch {
        // Already captured, refunded or cancelled — nothing left to release.
      }
    }

    if (fixtureConfigV1) {
      try {
        await archivePricingConfig(fixtureConfigV1);
      } catch {
        await admin.from('pricing_configs').update({ status: 'archived' }).eq('id', fixtureConfigV1);
      }
    }
    if (fixtureConfigV2) {
      await admin.from('pricing_configs').update({ status: 'archived' }).eq('id', fixtureConfigV2);
    }

    // ---- order matters, and it is not the obvious one ----------------
    // Every fixture row is chained: a request points at the pricing config, a
    // ledger entry points at the company, a payout points at both, and the
    // config points at the admin who authored it. Deleting in the wrong order
    // does not error loudly — each delete just quietly affects nothing, and
    // the residue only shows up when somebody counts the rows afterwards.
    // Which is exactly what happened: configs were deleted first, the fixture
    // requests still referenced them, and the run left an admin account and
    // two configurations behind while reporting a clean cleanup.
    //
    // Companies before their money, users before their configurations.

    if (createdCompanyIds.length) {
      await admin.from('company_members').delete().in('company_id', createdCompanyIds);
    }
    for (const userId of createdUserIds) {
      await admin.from('refunds').delete().eq('created_by', userId);
    }
    const { data: fixtureRequests } = await admin
      .from('requests')
      .select('id')
      .in('user_id', createdUserIds.length ? createdUserIds : ['00000000-0000-0000-0000-000000000000']);
    const fixtureRequestIds = (fixtureRequests ?? []).map((r) => r.id);
    if (fixtureRequestIds.length) {
      await admin.from('refunds').delete().in('request_id', fixtureRequestIds);
      await admin.from('request_supplements').delete().in('request_id', fixtureRequestIds);
    }
    // Companies take their ledger and their payouts with them (0035, 0040).
    // That cascade is the only way a ledger entry may ever leave.
    if (createdCompanyIds.length) {
      await admin.from('companies').delete().in('id', createdCompanyIds);
    }

    // A fixture account must not keep the privilege even if it keeps existing.
    for (const userId of createdUserIds) {
      await admin.from('profiles').update({ role: 'user' }).eq('id', userId);
      await admin.auth.admin.deleteUser(userId);
    }

    // Now nothing points at the fixture configurations: their requests went
    // with the deleted profiles. Archiving is not enough — a fixture version
    // holds a version NUMBER, so leaving ten of them would make the first real
    // configuration v11 and the history read as ten abandoned pricing
    // decisions. pricing_config_audit has no foreign key precisely so the
    // record of what happened outlives the rows it described.
    const { error: configDeleteError } = await admin
      .from('pricing_configs')
      .delete()
      .ilike('label', 'FIXTURE%');

    // Second pass: an account blocked a moment ago by the configuration it
    // authored is deletable now that the configuration is gone.
    const undeletable: string[] = [];
    for (const userId of createdUserIds) {
      await admin.from('admin_grants').delete().eq('profile_id', userId);
      const { data: stillThere } = await admin.from('profiles').select('id').eq('id', userId).maybeSingle();
      if (!stillThere) continue;
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error) undeletable.push(userId);
    }

    section = '14. Cleanup';
    const { data: stillActive } = await admin.from('pricing_configs').select('id').eq('status', 'active');
    const { data: configuredNow } = await admin.rpc('pricing_configured' as never, {} as never);
    const { data: fixtureConfigsLeft } = await admin
      .from('pricing_configs')
      .select('id')
      .ilike('label', 'FIXTURE%');

    ok('no economic configuration is left active', (stillActive ?? []).length === 0);
    ok('pricing_configured() is false again', configuredNow === false, String(configuredNow));
    ok(
      'no fixture configuration is left in the table',
      (fixtureConfigsLeft ?? []).length === 0,
      `${(fixtureConfigsLeft ?? []).length} left${configDeleteError ? ` (${configDeleteError.message})` : ''}`
    );
    ok('every fixture account was deleted', undeletable.length === 0, `${undeletable.length} left`);
    ok(
      'no fixture account is left holding admin rights',
      (await admin.from('profiles').select('id').in('id', createdUserIds).eq('role', 'admin')).data?.length === 0
    );

    const { data: leftoverEntries } = await admin
      .from('provider_ledger_entries')
      .select('id')
      .in('company_id', createdCompanyIds.length ? createdCompanyIds : ['00000000-0000-0000-0000-000000000000']);
    ok('no fixture ledger entry survives its company', (leftoverEntries ?? []).length === 0);
  }
}

main()
  .then(() => {
    const fails = results.filter((r) => r.status === 'fail');
    const passes = results.filter((r) => r.status === 'pass');
    const manual = results.filter((r) => r.status === 'manual');
    console.log(`\n${passes.length} passed, ${fails.length} failed, ${manual.length} require a human.`);
    if (fails.length) {
      console.log('\nFailures:');
      for (const f of fails) console.log(`  ✗ [${f.section}] ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
      process.exit(1);
    }
  })
  .catch((err) => {
    console.error('\nFinancial E2E crashed:', err);
    process.exit(1);
  });
