// Proves the pg_cron schedule actually runs the Edge Functions — not that a
// job row exists, and not that the functions work when *we* call them
// (verify:functions already covers that).
//
// It plants two things the maintenance functions are supposed to sweep up,
// then deliberately calls nothing and waits. If the state changes, the only
// thing that could have changed it is the scheduler.
//
//   npm run verify:scheduler
//
// Takes a few minutes by nature: the jobs run once a minute, and the point is
// to observe a tick we did not trigger. Disposable project only — it creates
// and deletes throwaway accounts.
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

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

const TIMEOUT_MS = 4 * 60_000;

async function waitFor(what: string, probe: () => Promise<boolean>) {
  const started = Date.now();
  for (;;) {
    if (await probe()) {
      console.log(`  ${what} after ${Math.round((Date.now() - started) / 1000)}s`);
      return true;
    }
    if (Date.now() - started > TIMEOUT_MS) {
      console.log(`  gave up on ${what} after ${Math.round((Date.now() - started) / 1000)}s`);
      return false;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

async function createUser(role: 'user' | 'driver') {
  const { data, error } = await admin.auth.admin.createUser({
    email: `scheduler-test-${role}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
    password: 'test-password-123!',
    email_confirm: true,
    user_metadata: { role, full_name: `Scheduler Test ${role}` },
  });
  if (error || !data.user) throw new Error(`setup: ${error?.message}`);
  return data.user.id;
}

async function main() {
  const userIds: string[] = [];
  const requestIds: string[] = [];

  try {
    // A driver whose app stopped pinging 5 minutes ago, against the shipped
    // 3-minute window. cleanup-stale should take them offline.
    const ghostId = await createUser('driver');
    userIds.push(ghostId);
    const { error: ghostError } = await admin
      .from('driver_profiles')
      .update({
        approval_status: 'approved',
        is_online: true,
        // Null Island: far outside every dispatch radius, so this fixture can
        // never be offered a real request while it sits here.
        current_lat: 0,
        current_lng: 0,
        last_heartbeat_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      })
      .eq('profile_id', ghostId);
    if (ghostError) throw new Error(`setup: ${ghostError.message}`);

    // A request nobody matched, 15 minutes old, against the shipped 10-minute
    // timeout. Placed where no driver is in range so it stays pending.
    const riderId = await createUser('user');
    userIds.push(riderId);
    const { data: request, error: requestError } = await admin
      .from('requests')
      .insert({
        user_id: riderId,
        problem_type: 'battery',
        location_text: 'Scheduler verification',
        lat: 0,
        lng: 0,
        price_estimate: 55,
        created_at: new Date(Date.now() - 15 * 60_000).toISOString(),
      })
      .select('id')
      .single();
    if (requestError || !request) throw new Error(`setup: ${requestError?.message}`);
    requestIds.push(request.id as string);

    console.log('Fixtures planted. Nothing will be invoked from here — waiting for the scheduler.');

    const wentOffline = await waitFor('the scheduler took the stale driver offline', async () => {
      const { data } = await admin
        .from('driver_profiles')
        .select('is_online')
        .eq('profile_id', ghostId)
        .single();
      return data?.is_online === false;
    });
    check('cleanup-stale runs on schedule: stale driver taken offline', wentOffline);

    const expired = await waitFor('the scheduler expired the stale request', async () => {
      const { data } = await admin.from('requests').select('status').eq('id', request.id).single();
      return data?.status === 'expired';
    });
    check('cleanup-stale runs on schedule: unmatched request expired', expired);
  } finally {
    for (const id of requestIds) {
      await admin.from('dispatch_offers').delete().eq('request_id', id);
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
      console.error('The schedule is not actually running the functions.');
      process.exit(1);
    }
    console.log('The scheduler runs the Edge Functions and their effects land in the database.');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
