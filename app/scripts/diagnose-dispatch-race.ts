// Reproduce, and NAME, the intermittent failure in test:integration.
//
//   npx tsx scripts/diagnose-dispatch-race.ts [iterations]
//
// The assertion that flickers is "a driver coming online later is picked up
// on the next nudge". Sprint 1 guessed at a race with the pg_cron sweepers.
// A guess is not a root cause, so this runs the scenario in a loop and, the
// moment it fails, prints the state of every input the dispatch engine reads:
// the request, the drivers, and the engine's own explanation of why each
// candidate was or was not chosen.
//
// It creates throwaway accounts and deletes them.
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
const MTL = { lat: 45.5019, lng: -73.5674 };

const createdUserIds: string[] = [];

interface Actor {
  id: string;
  client: SupabaseClient;
}

async function makeUser(role: 'user' | 'driver'): Promise<Actor> {
  const email = `p10-race-${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@towconnect.ca`;
  const password = 'race-probe-123!';
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { role, full_name: `Race ${role}` },
  });
  if (error || !data.user) throw new Error(`could not create ${role}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const client = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`could not sign in ${role}: ${signInError.message}`);
  return { id: data.user.id, client };
}

async function approvedOnlineDriver(): Promise<Actor> {
  const driver = await makeUser('driver');
  const { error } = await admin
    .from('driver_profiles')
    .update({
      approval_status: 'approved',
      is_online: true,
      current_lat: MTL.lat,
      current_lng: MTL.lng,
      last_heartbeat_at: new Date().toISOString(),
    })
    .eq('profile_id', driver.id);
  if (error) throw new Error(`could not approve driver: ${error.message}`);
  return driver;
}

async function dumpState(requestId: string, lateDriverId: string) {
  const { data: request } = await admin
    .from('requests')
    .select('id, status, driver_id, created_at')
    .eq('id', requestId)
    .single();
  console.log('\n  request:', JSON.stringify(request));

  const { data: offers } = await admin
    .from('dispatch_offers')
    .select('driver_id, status, offered_at, expires_at')
    .eq('request_id', requestId)
    .order('offered_at');
  console.log('  offers:', JSON.stringify(offers));

  const { data: driver } = await admin
    .from('driver_profiles')
    .select('profile_id, is_online, approval_status, last_heartbeat_at, current_lat')
    .eq('profile_id', lateDriverId)
    .single();
  const ageSeconds = driver?.last_heartbeat_at
    ? Math.round((Date.now() - new Date(driver.last_heartbeat_at).getTime()) / 1000)
    : null;
  console.log('  late driver:', JSON.stringify({ ...driver, heartbeat_age_seconds: ageSeconds }));

  // The engine's own answer, rather than our reconstruction of it.
  const { data: explained, error: explainError } = await admin.rpc('explain_dispatch_candidates' as never, {
    p_request_id: requestId,
  } as never);
  console.log('  explain:', explainError ? explainError.message : JSON.stringify(explained));

  const { data: blocked } = await admin.rpc('driver_dispatch_blocked' as never, {
    p_driver_id: lateDriverId,
  } as never);
  console.log('  driver_dispatch_blocked:', JSON.stringify(blocked));

  const { data: heartbeatWindow } = await admin.rpc('driver_heartbeat_max_age' as never, {} as never);
  console.log('  driver_heartbeat_max_age:', JSON.stringify(heartbeatWindow));
}

async function oneRun(n: number): Promise<boolean> {
  // Everything else offline, exactly as the suite does.
  await admin.from('driver_profiles').update({ is_online: false }).eq('is_online', true);

  const requester = await makeUser('user');
  const onlyDriver = await approvedOnlineDriver();

  const { data: created, error: createError } = await requester.client
    .from('requests')
    .insert({
      user_id: requester.id,
      problem_type: 'battery',
      location_text: 'dispatch race probe',
      lat: MTL.lat,
      lng: MTL.lng,
      price_estimate: 55,
    })
    .select('id')
    .single();
  if (createError || !created) throw new Error(`could not create request: ${createError?.message}`);
  const requestId = created.id as string;

  await requester.client.rpc('dispatch_next_candidate', { p_request_id: requestId });
  await onlyDriver.client.rpc('respond_to_dispatch_offer', { p_request_id: requestId, p_accept: false });

  const startedLate = Date.now();
  const lateDriver = await approvedOnlineDriver();
  const driverCreationMs = Date.now() - startedLate;

  // With --wait, hold long enough that the every-minute dispatch tick is
  // guaranteed to land first. If the tick advances the request on its own,
  // nudge_dispatch finds a LIVE offer and returns null by design — which is
  // the hypothesis this mode exists to confirm or kill.
  if (process.argv.includes('--wait')) {
    console.log('    holding 70s so the dispatch tick certainly runs first…');
    await new Promise((r) => setTimeout(r, 70_000));
  }

  const { data: lateOffer } = await requester.client.rpc('nudge_dispatch', { p_request_id: requestId });
  const offered = (lateOffer as { driver_id?: string | null } | null)?.driver_id ?? null;

  // The invariant, after the Sprint 2 diagnosis: a driver who comes online
  // once the pool is exhausted must be CONSIDERED AND OFFERED the work. Who
  // delivered it — this nudge, or the every-minute scheduler that is entitled
  // to act on the same request — is not something the test controls, and the
  // old assertion failed whenever the scheduler won the race.
  const { data: offersToLate } = await admin
    .from('dispatch_offers')
    .select('status')
    .eq('request_id', requestId)
    .eq('driver_id', lateDriver.id);
  const passed = offered === lateDriver.id || (offersToLate ?? []).length > 0;
  const by =
    offered === lateDriver.id
      ? 'the nudge'
      : (offersToLate ?? []).length > 0
        ? `the scheduler (offer '${offersToLate![0].status}')`
        : 'nobody';
  console.log(
    `  run ${n}: ${passed ? 'pass' : 'FAIL'}  delivered by ${by}  (creating the late driver took ${driverCreationMs} ms)`
  );
  if (!passed) await dumpState(requestId, lateDriver.id);

  await admin.from('requests').delete().eq('id', requestId);
  return passed;
}

async function main() {
  const iterations = Number(process.argv[2] ?? 6);
  let failures = 0;
  try {
    for (let i = 1; i <= iterations; i++) {
      if (!(await oneRun(i))) failures++;
    }
  } finally {
    for (const id of createdUserIds) await admin.auth.admin.deleteUser(id);
    const { data } = await admin.auth.admin.listUsers({ perPage: 200 });
    const left = data.users.filter((u) => /^p10-race-/.test(u.email ?? ''));
    console.log(`\n  cleanup: ${left.length} fixture account(s) remaining`);
  }
  console.log(`\n${iterations - failures}/${iterations} runs passed.\n`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
