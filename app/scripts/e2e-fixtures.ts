// Creates (or tears down) the throwaway accounts a manual end-to-end pass
// needs against a deployed environment: one rider with a saved vehicle, and
// one approved driver sitting online in Montreal.
//
// These are disposable test accounts, not seed data - nothing here exists to
// make the app look populated. `down` deletes every account it created along
// with its requests, and takes the test driver offline first so a stray
// fixture can never win a real dispatch.
//
//   npx tsx scripts/e2e-fixtures.ts up
//   npx tsx scripts/e2e-fixtures.ts down
//
// State lives in scripts/.e2e-fixtures.json (git-ignored).
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const STATE_PATH = join(dirname(fileURLToPath(import.meta.url)), '.e2e-fixtures.json');
const PASSWORD = 'E2ePass!2026';
const MONTREAL = { lat: 45.5019, lng: -73.5674 };

interface State {
  riderId: string;
  riderEmail: string;
  driverId: string;
  driverEmail: string;
  password: string;
}

async function createUser(role: 'user' | 'driver', label: string) {
  const email = `e2e-${role}-${Date.now()}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { role, full_name: label },
  });
  if (error || !data.user) throw new Error(`could not create ${role}: ${error?.message}`);
  return { id: data.user.id, email };
}

async function up() {
  if (existsSync(STATE_PATH)) {
    console.log('Fixtures already exist. Run `down` first.');
    console.log(readFileSync(STATE_PATH, 'utf8'));
    return;
  }

  const rider = await createUser('user', 'E2E Rider');
  const { error: vehicleError } = await admin.from('vehicles').insert({
    user_id: rider.id,
    make: 'Honda',
    model: 'Civic',
    year: 2019,
    color: 'Bleu',
    plate: 'E2E 001',
    is_primary: true,
  });
  if (vehicleError) throw new Error(`could not create vehicle: ${vehicleError.message}`);

  const driver = await createUser('driver', 'E2E Driver');
  const { error: profileError } = await admin
    .from('driver_profiles')
    .update({
      approval_status: 'approved',
      is_online: true,
      current_lat: MONTREAL.lat,
      current_lng: MONTREAL.lng,
      last_heartbeat_at: new Date().toISOString(),
    })
    .eq('profile_id', driver.id);
  if (profileError) throw new Error(`could not set up driver: ${profileError.message}`);

  const state: State = {
    riderId: rider.id,
    riderEmail: rider.email,
    driverId: driver.id,
    driverEmail: driver.email,
    password: PASSWORD,
  };
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  console.log(JSON.stringify(state, null, 2));
}

async function down() {
  if (!existsSync(STATE_PATH)) {
    console.log('No fixture state file - nothing to tear down.');
    return;
  }
  const state: State = JSON.parse(readFileSync(STATE_PATH, 'utf8'));

  // Offline first: a leftover online driver is a valid dispatch candidate.
  await admin.from('driver_profiles').update({ is_online: false }).eq('profile_id', state.driverId);

  const { data: requests } = await admin
    .from('requests')
    .select('id')
    .in('user_id', [state.riderId]);
  for (const r of requests ?? []) {
    await admin.from('messages').delete().eq('request_id', r.id);
    await admin.from('dispatch_offers').delete().eq('request_id', r.id);
    await admin.from('payments').delete().eq('request_id', r.id);
    await admin.from('requests').delete().eq('id', r.id);
  }
  await admin.from('vehicles').delete().eq('user_id', state.riderId);

  for (const id of [state.riderId, state.driverId]) {
    await admin.auth.admin.deleteUser(id).catch(() => {});
  }
  unlinkSync(STATE_PATH);
  console.log('Fixtures removed.');
}

const command = process.argv[2];
const run = command === 'up' ? up : command === 'down' ? down : null;
if (!run) {
  console.error('Usage: npx tsx scripts/e2e-fixtures.ts <up|down>');
  process.exit(1);
}
run().catch((err) => {
  console.error(err);
  process.exit(1);
});
