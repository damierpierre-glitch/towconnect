// Integration test against a REAL Supabase instance (local `supabase start`
// or a disposable test project) — RLS policies can't be verified with
// mocks, since the whole point is what Postgres does or doesn't let through.
//
// Confirms invariants from the hardening review (item 8) and its follow-ups:
//   1. A user cannot read another user's requests.
//   2. A driver cannot approve their own driver_profiles row.
//   3. A driver cannot set their own rating or total_services.
//   4. A driver cannot read a pending request offered to a different driver.
//
// Usage:
//   1. Point env vars at a project you're OK creating/deleting throwaway
//      users on (never production):
//        SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
//      (a local `supabase start` prints all three; NEXT_PUBLIC_SUPABASE_URL /
//      NEXT_PUBLIC_SUPABASE_ANON_KEY from .env.local also work for the first two)
//   2. All three migrations (0001_init.sql, 0002_hardening.sql,
//      0003_lockdown_driver_fields.sql) must already be applied to that instance.
//   3. npm run test:integration
import 'dotenv/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE_KEY) {
  console.error(
    'Missing env vars. Need SUPABASE_URL, SUPABASE_ANON_KEY (or the NEXT_PUBLIC_ ones), ' +
      'and SUPABASE_SERVICE_ROLE_KEY pointed at a disposable Supabase instance.'
  );
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

type TestUser = { id: string; email: string; client: SupabaseClient };

async function createTestUser(role: 'user' | 'driver'): Promise<TestUser> {
  const email = `rls-test-${role}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const password = 'test-password-123!';

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { role, full_name: `RLS Test ${role}` },
  });
  if (error || !data.user) throw new Error(`Failed to create test user: ${error?.message}`);

  const client = createClient(SUPABASE_URL!, ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`Failed to sign in test user: ${signInError.message}`);

  return { id: data.user.id, email, client };
}

async function deleteTestUser(id: string) {
  await admin.auth.admin.deleteUser(id);
}

interface Result {
  name: string;
  pass: boolean;
  detail?: string;
}

async function run(): Promise<Result[]> {
  const results: Result[] = [];
  const createdUserIds: string[] = [];

  try {
    // ---- Setup: two regular users ----
    const userA = await createTestUser('user');
    createdUserIds.push(userA.id);
    const userB = await createTestUser('user');
    createdUserIds.push(userB.id);

    const { data: insertedRequest, error: insertError } = await userA.client
      .from('requests')
      .insert({
        user_id: userA.id,
        problem_type: 'battery',
        location_text: 'RLS test location',
        lat: 45.5,
        lng: -73.5,
        price_estimate: 50,
      })
      .select('id')
      .single();

    if (insertError || !insertedRequest) {
      results.push({ name: 'setup: user A can create a request', pass: false, detail: insertError?.message });
    } else {
      results.push({ name: 'setup: user A can create a request', pass: true });

      // Sanity check: user A can read their own request back.
      const { data: ownRead } = await userA.client
        .from('requests')
        .select('id')
        .eq('id', insertedRequest.id)
        .maybeSingle();
      results.push({
        name: 'user A can read their own request',
        pass: ownRead?.id === insertedRequest.id,
      });

      // The actual invariant under test: user B must NOT see user A's request.
      const { data: crossRead, error: crossError } = await userB.client
        .from('requests')
        .select('id')
        .eq('id', insertedRequest.id)
        .maybeSingle();
      results.push({
        name: "user B cannot read user A's request",
        pass: !crossError && crossRead === null,
        detail: crossError ? crossError.message : crossRead ? 'row was visible!' : undefined,
      });
    }

    // ---- Driver self-approval ----
    const driver = await createTestUser('driver');
    createdUserIds.push(driver.id);

    const { data: beforeApproval } = await admin
      .from('driver_profiles')
      .select('approval_status')
      .eq('profile_id', driver.id)
      .single();

    const { error: selfApproveError } = await driver.client
      .from('driver_profiles')
      .update({ approval_status: 'approved' })
      .eq('profile_id', driver.id);

    const { data: afterApproval } = await admin
      .from('driver_profiles')
      .select('approval_status')
      .eq('profile_id', driver.id)
      .single();

    results.push({
      name: 'driver cannot self-approve',
      pass: Boolean(selfApproveError) && afterApproval?.approval_status === beforeApproval?.approval_status,
      detail: selfApproveError
        ? undefined
        : `expected an error and status to stay '${beforeApproval?.approval_status}', got no error and status '${afterApproval?.approval_status}'`,
    });

    // Sanity check: an admin performing the same update DOES work — proves
    // the block above is specific to the driver, not a broken function.
    const { error: adminApproveError } = await admin
      .from('driver_profiles')
      .update({ approval_status: 'approved' })
      .eq('profile_id', driver.id);
    const { data: afterAdminApproval } = await admin
      .from('driver_profiles')
      .select('approval_status')
      .eq('profile_id', driver.id)
      .single();
    results.push({
      name: 'admin (service role) can approve a driver',
      pass: !adminApproveError && afterAdminApproval?.approval_status === 'approved',
      detail: adminApproveError?.message,
    });

    // ---- Driver cannot self-inflate rating / total_services ----
    const { data: beforeStats } = await admin
      .from('driver_profiles')
      .select('rating, total_services')
      .eq('profile_id', driver.id)
      .single();

    const { error: selfStatsError } = await driver.client
      .from('driver_profiles')
      .update({ rating: 5.0, total_services: 9999 })
      .eq('profile_id', driver.id);

    const { data: afterStats } = await admin
      .from('driver_profiles')
      .select('rating, total_services')
      .eq('profile_id', driver.id)
      .single();

    results.push({
      name: 'driver cannot set their own rating/total_services',
      pass:
        Boolean(selfStatsError) &&
        afterStats?.rating === beforeStats?.rating &&
        afterStats?.total_services === beforeStats?.total_services,
      detail: selfStatsError
        ? undefined
        : `expected an error and unchanged stats, got no error and rating=${afterStats?.rating} total_services=${afterStats?.total_services}`,
    });

    // ---- Driver cannot read a pending request offered to another driver ----
    const requester = await createTestUser('user');
    createdUserIds.push(requester.id);
    const otherDriver = await createTestUser('driver');
    createdUserIds.push(otherDriver.id);

    const { data: offeredRequest, error: offerError } = await requester.client
      .from('requests')
      .insert({
        user_id: requester.id,
        driver_id: driver.id,
        problem_type: 'flat_tire',
        location_text: 'RLS test — offered to driver A only',
        lat: 45.5,
        lng: -73.5,
        price_estimate: 60,
      })
      .select('id')
      .single();

    if (offerError || !offeredRequest) {
      results.push({ name: 'setup: create a request offered to one driver', pass: false, detail: offerError?.message });
    } else {
      const { data: assignedRead } = await driver.client
        .from('requests')
        .select('id')
        .eq('id', offeredRequest.id)
        .maybeSingle();
      results.push({
        name: 'the assigned driver can read the request offered to them',
        pass: assignedRead?.id === offeredRequest.id,
      });

      const { data: otherDriverRead, error: otherDriverError } = await otherDriver.client
        .from('requests')
        .select('id')
        .eq('id', offeredRequest.id)
        .maybeSingle();
      results.push({
        name: 'a different driver cannot read a pending request offered to someone else',
        pass: !otherDriverError && otherDriverRead === null,
        detail: otherDriverError ? otherDriverError.message : otherDriverRead ? 'row was visible!' : undefined,
      });
    }
  } finally {
    for (const id of createdUserIds) {
      await deleteTestUser(id);
    }
  }

  return results;
}

run()
  .then((results) => {
    console.log('\nRLS integration test results:\n');
    let allPass = true;
    for (const r of results) {
      console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
      if (!r.pass) allPass = false;
    }
    console.log('');
    if (!allPass) {
      console.error('FAILED — one or more RLS invariants did not hold.');
      process.exit(1);
    }
    console.log('All RLS invariants held.');
  })
  .catch((err) => {
    console.error('Integration test crashed:', err);
    process.exit(1);
  });
