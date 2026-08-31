// Attaches a test card to the E2E rider's Stripe customer and makes it the
// customer's default, which is the exact end state the in-app SetupIntent
// flow produces. Used only when the Stripe Elements iframe cannot be driven
// from the automation surface in use; the app's own authorization path is
// still exercised normally afterwards.
//
//   npx tsx scripts/e2e-attach-card.ts [pm_card_visa]
//
// Sandbox only.
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !STRIPE_SECRET_KEY) {
  console.error('Missing env vars.');
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

const STATE_PATH = join(dirname(fileURLToPath(import.meta.url)), '.e2e-fixtures.json');
if (!existsSync(STATE_PATH)) {
  console.error('No fixture state. Run: npx tsx scripts/e2e-fixtures.ts up');
  process.exit(1);
}
const state = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as { riderId: string; riderEmail: string };
const token = process.argv[2] ?? 'pm_card_visa';

async function main() {
  const { data: profile, error } = await admin
    .from('profiles')
    .select('stripe_customer_id')
    .eq('id', state.riderId)
    .single();
  if (error) throw new Error(`could not read profile: ${error.message}`);

  let customerId = profile?.stripe_customer_id as string | null;
  if (!customerId) {
    // The app creates this on first visit to the payment page; create it the
    // same way if that has not happened yet.
    const customer = await stripe.customers.create({ metadata: { towconnect_profile_id: state.riderId } });
    customerId = customer.id;
    const { error: updateError } = await admin
      .from('profiles')
      .update({ stripe_customer_id: customerId })
      .eq('id', state.riderId);
    if (updateError) throw new Error(`could not save customer id: ${updateError.message}`);
  }

  const pm = await stripe.paymentMethods.attach(token, { customer: customerId });
  await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: pm.id } });

  console.log(
    JSON.stringify(
      { customerId, paymentMethodId: pm.id, brand: pm.card?.brand, last4: pm.card?.last4 },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
