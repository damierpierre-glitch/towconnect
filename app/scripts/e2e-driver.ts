// The driver half of a manual end-to-end pass, run as a real authenticated
// driver session rather than with the service role - so every RLS policy and
// status-transition guard applies exactly as it would in the driver's browser.
//
// It exists because the rider and driver sides share one origin: signing in as
// the driver in a second tab would replace the rider's session.
//
//   npx tsx scripts/e2e-driver.ts heartbeat            keep the driver online
//   npx tsx scripts/e2e-driver.ts accept               accept the current offer
//   npx tsx scripts/e2e-driver.ts status <next-status> advance the intervention
//   npx tsx scripts/e2e-driver.ts show                 print what the driver sees
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !ANON_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY.');
  process.exit(1);
}

const STATE_PATH = join(dirname(fileURLToPath(import.meta.url)), '.e2e-fixtures.json');
if (!existsSync(STATE_PATH)) {
  console.error('No fixture state. Run: npx tsx scripts/e2e-fixtures.ts up');
  process.exit(1);
}
const state = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as {
  driverId: string;
  driverEmail: string;
  password: string;
};

const MONTREAL = { lat: 45.5019, lng: -73.5674 };

async function driverClient() {
  const client = createClient(SUPABASE_URL!, ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({
    email: state.driverEmail,
    password: state.password,
  });
  if (error) throw new Error(`could not sign in as the test driver: ${error.message}`);
  return client;
}

async function heartbeat() {
  const client = await driverClient();
  // Exactly what the driver dashboard sends while the app is open. Runs until
  // interrupted so the driver stays a valid dispatch candidate for the pass.
  for (;;) {
    const { error } = await client
      .from('driver_profiles')
      .update({
        is_online: true,
        current_lat: MONTREAL.lat,
        current_lng: MONTREAL.lng,
        last_heartbeat_at: new Date().toISOString(),
      })
      .eq('profile_id', state.driverId);
    const stamp = new Date().toISOString().slice(11, 19);
    console.log(error ? `${stamp} heartbeat failed: ${error.message}` : `${stamp} heartbeat ok`);
    await new Promise((r) => setTimeout(r, 20_000));
  }
}

async function show() {
  const client = await driverClient();
  const { data: offers } = await client
    .from('dispatch_offers')
    .select('request_id, status, offered_at, expires_at')
    .order('offered_at', { ascending: false })
    .limit(5);
  const { data: requests } = await client
    .from('requests')
    .select('id, status, problem_type, location_text, destination_address, tow_distance_km, price_estimate, price_base, price_distance, price_surcharge')
    .order('created_at', { ascending: false })
    .limit(5);
  console.log(JSON.stringify({ offers, requests }, null, 2));
}

async function accept() {
  const client = await driverClient();
  const { data: offer, error: offerError } = await client
    .from('dispatch_offers')
    .select('request_id, expires_at')
    .eq('status', 'offered')
    .order('offered_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (offerError) throw new Error(offerError.message);
  if (!offer) {
    console.log('No offer is currently open for this driver.');
    return;
  }
  const { data, error } = await client.rpc('respond_to_dispatch_offer', {
    p_request_id: offer.request_id,
    p_accept: true,
  });
  if (error) throw new Error(`accept failed: ${error.message}`);
  console.log(JSON.stringify({ accepted: offer.request_id, request: data }, null, 2));
}

async function setStatus(next: string) {
  const client = await driverClient();
  const { data: current, error: readError } = await client
    .from('requests')
    .select('id, status')
    .eq('driver_id', state.driverId)
    .not('status', 'in', '(completed,cancelled,expired)')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (readError) throw new Error(readError.message);
  if (!current) {
    console.log('This driver has no active job.');
    return;
  }
  const { error } = await client.from('requests').update({ status: next }).eq('id', current.id);
  if (error) throw new Error(`could not move ${current.status} -> ${next}: ${error.message}`);
  console.log(`${current.id}: ${current.status} -> ${next}`);
}

const [command, arg] = process.argv.slice(2);
const run =
  command === 'heartbeat' ? heartbeat
  : command === 'accept' ? accept
  : command === 'show' ? show
  : command === 'status' && arg ? () => setStatus(arg)
  : null;

if (!run) {
  console.error('Usage: npx tsx scripts/e2e-driver.ts <heartbeat|accept|show|status <next>>');
  process.exit(1);
}
run().catch((err) => {
  console.error(err);
  process.exit(1);
});
