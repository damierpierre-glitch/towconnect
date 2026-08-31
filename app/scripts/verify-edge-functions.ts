// Verifies the two DEPLOYED Edge Functions — not the source in this repo.
//
// Returning HTTP 200 proves only that the request reached the handler. What
// matters is whether the scheduled maintenance actually changes the database:
// a silently abandoned dispatch offer must time out and move to the next
// driver, and a driver whose app stopped pinging must go offline. Both of
// those were broken in production while the functions still answered exactly
// as their code suggested they would — cleanup-stale spent a day deployed and
// rejecting every caller, so "the code is right" was never the question.
//
// This script therefore drives the real HTTPS endpoints with the real cron
// secret and asserts on rows afterwards. It also probes every unauthorized
// path, because a maintenance endpoint that anyone can invoke is its own bug.
//
// It never changes a threshold to make a test pass: it ages the fixtures
// (backdating expires_at / created_at / last_heartbeat_at) and lets the
// shipped 18s offer window, 10-minute request timeout and 3-minute heartbeat
// window judge them.
//
// Usage (from app/, against a disposable project — it creates and deletes
// throwaway users, and takes its own test drivers offline):
//   npm run verify:functions
// Needs NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
// SUPABASE_SERVICE_ROLE_KEY and CRON_SECRET in .env.local.
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE_KEY || !CRON_SECRET) {
  console.error(
    'Missing env vars. Need NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, ' +
      'SUPABASE_SERVICE_ROLE_KEY and CRON_SECRET in .env.local.'
  );
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const FUNCTIONS_BASE = `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/`;

interface Result {
  name: string;
  pass: boolean;
  detail?: string;
}
const results: Result[] = [];
function check(name: string, pass: boolean, detail?: string) {
  results.push({ name, pass, detail });
}

// The secret rides in its own header so Authorization stays free for the JWT
// the platform's "Verify JWT" gate demands. Callers that omit x-cron-secret
// must be refused even when their JWT is perfectly valid.
async function invoke(fn: string, headers: Record<string, string>) {
  const res = await fetch(FUNCTIONS_BASE + fn, { method: 'POST', headers });
  return { status: res.status, body: await res.text() };
}

const authorized = (): Record<string, string> => ({
  Authorization: `Bearer ${ANON_KEY}`,
  'x-cron-secret': CRON_SECRET!,
});

const createdUserIds: string[] = [];
const createdRequestIds: string[] = [];

async function makeOnlineDriver(lat: number, lng: number, heartbeatMinutesAgo = 0) {
  const email = `edgefn-test-driver-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: 'test-password-123!',
    email_confirm: true,
    user_metadata: { role: 'driver', full_name: 'Edge Fn Test Driver' },
  });
  if (error || !data.user) throw new Error(`setup: could not create driver: ${error?.message}`);
  createdUserIds.push(data.user.id);

  const { error: profileError } = await admin
    .from('driver_profiles')
    .update({
      approval_status: 'approved',
      is_online: true,
      current_lat: lat,
      current_lng: lng,
      last_heartbeat_at: new Date(Date.now() - heartbeatMinutesAgo * 60_000).toISOString(),
    })
    .eq('profile_id', data.user.id);
  if (profileError) throw new Error(`setup: could not position driver: ${profileError.message}`);
  return data.user.id;
}

async function makePendingRequest(lat: number, lng: number, minutesAgo = 0) {
  const email = `edgefn-test-user-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: 'test-password-123!',
    email_confirm: true,
    user_metadata: { role: 'user', full_name: 'Edge Fn Test User' },
  });
  if (error || !data.user) throw new Error(`setup: could not create rider: ${error?.message}`);
  createdUserIds.push(data.user.id);

  const { data: request, error: requestError } = await admin
    .from('requests')
    .insert({
      user_id: data.user.id,
      problem_type: 'battery',
      location_text: 'Edge function verification',
      lat,
      lng,
      price_estimate: 55,
      created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    })
    .select('id')
    .single();
  if (requestError || !request) throw new Error(`setup: could not create request: ${requestError?.message}`);
  createdRequestIds.push(request.id as string);
  return request.id as string;
}

async function offersFor(requestId: string) {
  const { data, error } = await admin
    .from('dispatch_offers')
    .select('driver_id, status, expires_at')
    .eq('request_id', requestId)
    .order('offered_at', { ascending: true });
  if (error) throw new Error(`could not read dispatch_offers: ${error.message}`);
  return data ?? [];
}

async function requestRow(requestId: string) {
  const { data, error } = await admin
    .from('requests')
    .select('status, driver_id')
    .eq('id', requestId)
    .single();
  if (error) throw new Error(`could not read request: ${error.message}`);
  return data;
}

async function main() {
  // Far from anywhere this project's other fixtures sit, so a driver left
  // online by an earlier session can never win these matches: dispatch's
  // widest radius tier is 350km.
  const NORTH = { lat: 60.0, lng: -100.0 };
  // Null Island. No driver is ever within range, so a request placed here
  // stays pending and driverless — which is exactly what cleanup-stale is
  // supposed to sweep up.
  const NOWHERE = { lat: 0, lng: 0 };

  try {
    // ---- Authorization: every path that isn't the scheduler is refused ----
    for (const fn of ['dispatch-tick', 'cleanup-stale']) {
      const noAuth = await invoke(fn, {});
      check(`${fn}: rejects a caller with no Authorization`, noAuth.status === 401, `HTTP ${noAuth.status}`);

      const anonOnly = await invoke(fn, { Authorization: `Bearer ${ANON_KEY}` });
      check(`${fn}: rejects a valid JWT with no cron secret`, anonOnly.status === 401, `HTTP ${anonOnly.status}`);

      const wrongSecret = await invoke(fn, {
        Authorization: `Bearer ${ANON_KEY}`,
        'x-cron-secret': 'not-the-secret-value',
      });
      check(`${fn}: rejects a wrong cron secret`, wrongSecret.status === 401, `HTTP ${wrongSecret.status}`);

      const ok = await invoke(fn, authorized());
      check(`${fn}: accepts the scheduler`, ok.status === 200, `HTTP ${ok.status} ${ok.body.slice(0, 80)}`);
    }

    // ---- dispatch-tick actually advances a silently abandoned offer ----
    const nearDriver = await makeOnlineDriver(NORTH.lat, NORTH.lng);
    const farDriver = await makeOnlineDriver(NORTH.lat + 0.05, NORTH.lng); // ~5.5km further out
    const requestId = await makePendingRequest(NORTH.lat, NORTH.lng);

    // First tick: the request is pending with no driver, so the function
    // should offer it to the nearer of the two.
    const firstTick = await invoke('dispatch-tick', authorized());
    const afterFirst = await offersFor(requestId);
    const firstOffer = afterFirst.at(-1);
    check(
      'dispatch-tick: offers a driverless pending request to the nearest driver',
      firstTick.status === 200 && afterFirst.length === 1 && firstOffer?.driver_id === nearDriver && firstOffer?.status === 'offered',
      `offers=${afterFirst.length} status=${firstOffer?.status} nearest=${firstOffer?.driver_id === nearDriver}`
    );
    check(
      'dispatch-tick: the request now points at that driver',
      (await requestRow(requestId)).driver_id === nearDriver
    );

    // Age the offer past its window rather than sleeping through it — the 18s
    // threshold itself is left exactly as shipped.
    const { error: ageError } = await admin
      .from('dispatch_offers')
      .update({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .eq('request_id', requestId)
      .eq('status', 'offered');
    if (ageError) throw new Error(`could not age the offer: ${ageError.message}`);

    // Second tick: nobody responded. This is the case the scheduler exists
    // for — no browser tab is open, so only the cron can move it along.
    const secondTick = await invoke('dispatch-tick', authorized());
    const afterSecond = await offersFor(requestId);
    const timedOut = afterSecond.filter((o) => o.status === 'timeout');
    const stillOffered = afterSecond.filter((o) => o.status === 'offered');
    check(
      'dispatch-tick: an expired offer is marked timeout in the database',
      secondTick.status === 200 && timedOut.length === 1 && timedOut[0].driver_id === nearDriver,
      `timeout rows=${timedOut.length}`
    );
    check(
      'dispatch-tick: the request is re-offered to the next candidate',
      stillOffered.length === 1 && stillOffered[0].driver_id === farDriver,
      `offered rows=${stillOffered.length} isNextDriver=${stillOffered[0]?.driver_id === farDriver}`
    );
    check(
      'dispatch-tick: the request follows the new offer',
      (await requestRow(requestId)).driver_id === farDriver
    );

    // ---- cleanup-stale actually expires and takes things offline ----
    // 15 minutes old, against the shipped 10-minute request timeout.
    const staleRequestId = await makePendingRequest(NOWHERE.lat, NOWHERE.lng, 15);
    // 5 minutes since the last ping, against the shipped 3-minute window.
    const ghostDriver = await makeOnlineDriver(NORTH.lat, NORTH.lng, 5);

    const beforeCleanup = await requestRow(staleRequestId);
    check(
      'cleanup-stale: fixture starts pending (nothing else already expired it)',
      beforeCleanup.status === 'pending',
      `status=${beforeCleanup.status}`
    );

    const cleanup = await invoke('cleanup-stale', authorized());
    check('cleanup-stale: scheduler call succeeds', cleanup.status === 200, `HTTP ${cleanup.status}`);

    const afterCleanup = await requestRow(staleRequestId);
    check(
      'cleanup-stale: a long-unmatched pending request is expired',
      afterCleanup.status === 'expired',
      `status=${afterCleanup.status}`
    );

    const { data: ghost } = await admin
      .from('driver_profiles')
      .select('is_online')
      .eq('profile_id', ghostDriver)
      .single();
    check(
      'cleanup-stale: a driver with a stale heartbeat is taken offline',
      ghost?.is_online === false,
      `is_online=${ghost?.is_online}`
    );
  } finally {
    // Leave nothing online or half-dispatched behind.
    for (const id of createdRequestIds) {
      await admin.from('dispatch_offers').delete().eq('request_id', id);
      await admin.from('requests').delete().eq('id', id);
    }
    for (const id of createdUserIds) {
      await admin.auth.admin.deleteUser(id).catch(() => {});
    }
  }
}

main()
  .then(() => {
    let failed = 0;
    for (const r of results) {
      if (r.pass) {
        console.log(`✓ ${r.name}`);
      } else {
        failed++;
        console.log(`✗ ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
      }
    }
    console.log(`\n${results.length - failed}/${results.length} checks passed`);
    if (failed > 0) {
      console.error('Deployed Edge Functions are NOT behaving correctly.');
      process.exit(1);
    }
    console.log('Both deployed Edge Functions authenticate correctly and change the database as intended.');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
