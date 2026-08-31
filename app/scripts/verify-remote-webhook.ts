// Verifies the DEPLOYED webhook endpoint end to end: Stripe -> Vercel ->
// signature check -> this project's database.
//
// Everything about this path is invisible locally. `stripe listen` forwards
// to localhost with a *different* signing secret, so a green local run says
// nothing about whether the deployed route has STRIPE_WEBHOOK_SECRET,
// STRIPE_SECRET_KEY and SUPABASE_SERVICE_ROLE_KEY set correctly - and a
// webhook that cannot reach the database fails silently, leaving payments
// stuck in whatever state the optimistic UI wrote.
//
// So: create a real (sandbox) PaymentIntent, record it the way the app does,
// confirm it, and then wait for OUR row to change. Nothing here asserts on an
// HTTP status code alone; the real assertion is the database.
//
// Sandbox only - it refuses to run against a live key.
//
//   npm run verify:webhook
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const ENDPOINT = process.env.WEBHOOK_ENDPOINT_URL ?? 'https://towconnect-chi.vercel.app/api/stripe/webhook';

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !STRIPE_SECRET_KEY) {
  console.error('Missing env vars. Need NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and STRIPE_SECRET_KEY.');
  process.exit(1);
}
if (!STRIPE_SECRET_KEY.startsWith('sk_test_') && !STRIPE_SECRET_KEY.startsWith('rk_test_')) {
  console.error('Refusing to run: STRIPE_SECRET_KEY is not a test-mode key.');
  process.exit(1);
}

const stripe = new Stripe(STRIPE_SECRET_KEY);
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

interface Result {
  name: string;
  pass: boolean;
  detail?: string;
}
const results: Result[] = [];
const check = (name: string, pass: boolean, detail?: string) => results.push({ name, pass, detail });

// Stripe delivers asynchronously; a fixed sleep either flakes or wastes time,
// so poll for the state we actually care about.
async function waitFor(what: string, probe: () => Promise<boolean>, timeoutMs = 90_000): Promise<boolean> {
  const started = Date.now();
  for (;;) {
    if (await probe()) return true;
    if (Date.now() - started > timeoutMs) {
      console.log(`  ... gave up waiting for ${what} after ${Math.round((Date.now() - started) / 1000)}s`);
      return false;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function paymentStatus(intentId: string) {
  const { data } = await admin
    .from('payments')
    .select('status')
    .eq('stripe_payment_intent_id', intentId)
    .maybeSingle();
  return data?.status ?? null;
}

async function main() {
  const userIds: string[] = [];
  const requestIds: string[] = [];
  let intentId: string | null = null;

  // The endpoint has to be reachable and refuse unsigned bodies before any of
  // the rest means anything.
  const unsigned = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'evt_forged', type: 'payment_intent.succeeded' }),
  });
  check('deployed endpoint rejects an unsigned body', unsigned.status === 400, `HTTP ${unsigned.status}`);

  const forged = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' },
    body: JSON.stringify({ id: 'evt_forged2', type: 'payment_intent.succeeded' }),
  });
  check('deployed endpoint rejects a forged signature', forged.status === 400, `HTTP ${forged.status}`);

  try {
    const { data: userData, error: userError } = await admin.auth.admin.createUser({
      email: `webhook-test-${Date.now()}@example.com`,
      password: 'test-password-123!',
      email_confirm: true,
      user_metadata: { role: 'user', full_name: 'Remote Webhook Test' },
    });
    if (userError || !userData.user) throw new Error(`setup: ${userError?.message}`);
    userIds.push(userData.user.id);

    const { data: request, error: requestError } = await admin
      .from('requests')
      .insert({
        user_id: userData.user.id,
        problem_type: 'battery',
        location_text: 'Remote webhook verification',
        lat: 45.5,
        lng: -73.5,
        price_estimate: 55,
      })
      .select('id')
      .single();
    if (requestError || !request) throw new Error(`setup: ${requestError?.message}`);
    const requestId = request.id as string;
    requestIds.push(requestId);

    // Authorize-now / capture-later, exactly as createRequest() does.
    const intent = await stripe.paymentIntents.create({
      amount: 5500,
      currency: 'cad',
      capture_method: 'manual',
      payment_method: 'pm_card_visa',
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      metadata: { towconnect_purpose: 'remote webhook verification', request_id: requestId },
    });
    intentId = intent.id;

    // Recorded BEFORE confirming: the webhook can beat us back otherwise, and
    // would then have no row to update - which is exactly the silent failure
    // this script exists to catch.
    const { error: paymentError } = await admin.from('payments').insert({
      request_id: requestId,
      stripe_payment_intent_id: intent.id,
      amount: 55,
      currency: 'cad',
      status: 'requires_payment_method',
    });
    if (paymentError) throw new Error(`setup: could not record payment: ${paymentError.message}`);

    await stripe.paymentIntents.confirm(intent.id);

    const authorized = await waitFor('the authorization webhook', async () => (await paymentStatus(intent.id)) === 'authorized');
    check(
      'Stripe to Vercel to database: authorization reaches our payments row',
      authorized,
      `status=${await paymentStatus(intent.id)}`
    );

    const { count } = await admin
      .from('stripe_webhook_events')
      .select('stripe_event_id', { count: 'exact', head: true })
      .eq('type', 'payment_intent.amount_capturable_updated');
    check(
      'the delivered event is written to the idempotency ledger',
      (count ?? 0) > 0,
      `amount_capturable_updated rows in ledger=${count ?? 0}`
    );

    // Release the hold. This also exercises a second event type over the same
    // remote path, and leaves no authorization outstanding on the card.
    await stripe.paymentIntents.cancel(intent.id);
    const canceled = await waitFor('the cancellation webhook', async () => (await paymentStatus(intent.id)) === 'canceled');
    check(
      'Stripe to Vercel to database: cancellation reaches our payments row',
      canceled,
      `status=${await paymentStatus(intent.id)}`
    );
  } finally {
    if (intentId) {
      const current = await stripe.paymentIntents.retrieve(intentId).catch(() => null);
      // Never leave a hold on a card because a check failed part way through.
      const open = ['requires_capture', 'requires_confirmation', 'requires_action', 'requires_payment_method'];
      if (current && open.includes(current.status)) {
        await stripe.paymentIntents.cancel(intentId).catch(() => {});
      }
    }
    for (const id of requestIds) {
      await admin.from('payments').delete().eq('request_id', id);
      await admin.from('requests').delete().eq('id', id);
    }
    for (const id of userIds) await admin.auth.admin.deleteUser(id).catch(() => {});
  }
}

main()
  .then(() => {
    let failed = 0;
    for (const r of results) {
      if (r.pass) {
        console.log(`OK   ${r.name}`);
      } else {
        failed++;
        console.log(`FAIL ${r.name}${r.detail ? ` - ${r.detail}` : ''}`);
      }
    }
    console.log(`\n${results.length - failed}/${results.length} checks passed`);
    if (failed > 0) {
      console.error('The deployed webhook path is NOT working end to end.');
      process.exit(1);
    }
    console.log('Stripe reaches the deployed endpoint, the signature is verified there, and the database is updated.');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
