// Prints the database and Stripe state for the E2E rider's most recent
// request, side by side. The point of the pairing is the one thing a
// screenshot cannot show: that the amount Stripe actually authorised is the
// price the server computed and froze onto the request, to the cent.
//
//   npx tsx scripts/e2e-inspect.ts
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
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing env vars.');
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

const STATE_PATH = join(dirname(fileURLToPath(import.meta.url)), '.e2e-fixtures.json');
if (!existsSync(STATE_PATH)) {
  console.error('No fixture state. Run: npx tsx scripts/e2e-fixtures.ts up');
  process.exit(1);
}
const state = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as { riderId: string };

async function main() {
  const { data: request, error } = await admin
    .from('requests')
    .select('*')
    .eq('user_id', state.riderId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!request) {
    console.log('No request yet for the E2E rider.');
    return;
  }

  const { data: payment } = await admin
    .from('payments')
    .select('stripe_payment_intent_id, amount, currency, status, failure_reason, commission_amount, partner_amount')
    .eq('request_id', request.id)
    .maybeSingle();

  const { data: offers } = await admin
    .from('dispatch_offers')
    .select('driver_id, status, offered_at, expires_at, responded_at')
    .eq('request_id', request.id)
    .order('offered_at', { ascending: true });

  let intent: Record<string, unknown> | null = null;
  if (stripe && payment?.stripe_payment_intent_id) {
    const pi = await stripe.paymentIntents.retrieve(payment.stripe_payment_intent_id);
    intent = {
      id: pi.id,
      status: pi.status,
      capture_method: pi.capture_method,
      amount: pi.amount,
      amount_capturable: pi.amount_capturable,
      amount_received: pi.amount_received,
      currency: pi.currency,
    };
  }

  const priceCents = Math.round(Number(request.price_estimate) * 100);
  console.log(
    JSON.stringify(
      {
        request: {
          id: request.id,
          status: request.status,
          problem_type: request.problem_type,
          pickup: request.location_text,
          destination_address: request.destination_address,
          destination_lat: request.destination_lat,
          destination_lng: request.destination_lng,
          tow_distance_km: request.tow_distance_km,
          price_base: request.price_base,
          price_distance: request.price_distance,
          price_surcharge: request.price_surcharge,
          price_estimate: request.price_estimate,
          commission_amount: request.commission_amount,
          partner_amount: request.partner_amount,
        },
        payment,
        stripe_payment_intent: intent,
        amount_matches_server_price: intent ? intent.amount === priceCents : null,
        dispatch_offers: offers,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
