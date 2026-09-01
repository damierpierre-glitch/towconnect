// Integration test against a REAL Supabase instance (local `supabase start`
// or a disposable test project) — RLS policies can't be verified with
// mocks, since the whole point is what Postgres does or doesn't let through.
//
// Confirms invariants from the hardening review (item 8) and its follow-ups,
// plus the Vehicles (Phase 1), Smart Dispatch (Phase 2/2.5), and Messaging +
// intervention status (Phase 3) RLS/concurrency invariants:
//   1. A user cannot read another user's requests.
//   2. A driver cannot approve their own driver_profiles row.
//   3. A driver cannot set their own rating or total_services.
//   4. A driver cannot read a pending request offered to a different driver.
//   5. Vehicles are fully owner-scoped (read/write/delete), and a user can
//      have at most one primary vehicle.
//   6. Smart Dispatch: the best real candidate is picked (offline/stale/busy
//      drivers excluded), offers are sequential and exclusive (one 'offered'
//      row per request, enforced at the DB level), an expired offer can
//      never be accepted, a driver can never touch another driver's offer, a
//      rider can never write dispatch_offers directly, and cancelling a
//      request while an offer is outstanding resolves it immediately. A
//      decline advances dispatch in the same call (no cron dependency), and
//      nudge_dispatch() is a scoped, authorized-only, idempotent timeout
//      advance.
//   7. Messages: only a request's owner and its currently assigned driver
//      can read or send messages for it (never a third party, never an
//      unassigned driver, never with a spoofed sender_id), admins can read
//      for support/audit, and the row-level checks hold across every
//      relevant status.
//   8. Request status: the driver-facing progression
//      (matched->en_route->arrived->in_progress->completed) is enforced
//      server-side — a driver can't skip a state, move backwards, or touch
//      another driver's request — and 'in_progress' is treated as an active
//      job everywhere 'matched'/'en_route'/'arrived' already were (dispatch
//      exclusion, one-active-job unique index, driver_profiles visibility).
//   9. Request field lockdown (Phase 4): the assigned driver's own session
//      may change `status` and nothing else — price, destination, pickup,
//      vehicle, user_id, driver_id are all rejected server-side.
//   10. Payments (Phase 4): only the request's owner can read its payment
//       (never another rider, never the assigned driver), nobody can insert
//       or update a payments row from the browser (no policy grants it — a
//       rider marking their own payment "captured" is structurally
//       impossible), the Stripe webhook idempotency ledger rejects a
//       duplicate event id, and profiles.stripe_customer_id can't be set
//       from a user's own session.
//
// Usage:
//   1. Point env vars at a project you're OK creating/deleting throwaway
//      users on (never production):
//        SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
//      (a local `supabase start` prints all three; NEXT_PUBLIC_SUPABASE_URL /
//      NEXT_PUBLIC_SUPABASE_ANON_KEY from .env.local also work for the first two)
//   2. All migrations through 0015_fix_nudge_dispatch_guard.sql must already
//      be applied to that instance. This script never calls Stripe itself —
//      the payments tests use the service-role client to fabricate rows
//      directly, so no Stripe keys are needed to run it.
//   3. npm run test:integration
// `.env.local` first (where Next.js keeps them, and where this project's
// credentials actually live), then `.env` as a fallback. Plain
// `dotenv/config` only reads `.env`, which silently left every var unset.
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();
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

  // This suite signs in ~25 throwaway users in quick succession, which is
  // enough to trip Supabase Auth's "sign-ups and sign-ins" rate limit (30
  // per 5 minutes per IP by default). That's a property of the harness, not
  // a failure of anything under test — so wait out the window and retry
  // rather than reporting a bogus RLS failure. Raising the project's limit
  // helps but doesn't help a window already in progress.
  const MAX_ATTEMPTS = 6;
  const WAIT_MS = 65_000;
  for (let attempt = 1; ; attempt++) {
    const { error: signInError } = await client.auth.signInWithPassword({ email, password });
    if (!signInError) break;

    const rateLimited = /rate limit/i.test(signInError.message);
    if (!rateLimited || attempt >= MAX_ATTEMPTS) {
      throw new Error(`Failed to sign in test user: ${signInError.message}`);
    }
    console.log(`  … auth rate limit hit, waiting ${WAIT_MS / 1000}s (attempt ${attempt}/${MAX_ATTEMPTS - 1})`);
    await new Promise((r) => setTimeout(r, WAIT_MS));
  }

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

    // ---- Vehicles RLS ----
    const vehicleOwner = await createTestUser('user');
    createdUserIds.push(vehicleOwner.id);
    const otherUser = await createTestUser('user');
    createdUserIds.push(otherUser.id);

    const { data: insertedVehicle, error: vehicleInsertError } = await vehicleOwner.client
      .from('vehicles')
      .insert({ user_id: vehicleOwner.id, make: 'Honda', model: 'Civic', year: 2019 })
      .select('id, is_primary')
      .single();

    if (vehicleInsertError || !insertedVehicle) {
      results.push({ name: 'user A can create their own vehicle', pass: false, detail: vehicleInsertError?.message });
    } else {
      results.push({ name: 'user A can create their own vehicle', pass: true });

      const { data: ownVehicleRead } = await vehicleOwner.client
        .from('vehicles')
        .select('id')
        .eq('id', insertedVehicle.id)
        .maybeSingle();
      results.push({
        name: 'user A can read their own vehicle',
        pass: ownVehicleRead?.id === insertedVehicle.id,
      });

      const { data: crossVehicleRead, error: crossVehicleError } = await otherUser.client
        .from('vehicles')
        .select('id')
        .eq('id', insertedVehicle.id)
        .maybeSingle();
      results.push({
        name: "user B cannot read user A's vehicle",
        pass: !crossVehicleError && crossVehicleRead === null,
        detail: crossVehicleError ? crossVehicleError.message : crossVehicleRead ? 'row was visible!' : undefined,
      });

      const { error: crossVehicleUpdateError } = await otherUser.client
        .from('vehicles')
        .update({ model: 'Hacked' })
        .eq('id', insertedVehicle.id);
      const { data: vehicleAfterCrossUpdate } = await admin
        .from('vehicles')
        .select('model')
        .eq('id', insertedVehicle.id)
        .single();
      results.push({
        name: "user B cannot modify user A's vehicle",
        pass: vehicleAfterCrossUpdate?.model === 'Civic',
        detail: crossVehicleUpdateError
          ? undefined
          : `expected model to stay 'Civic', got '${vehicleAfterCrossUpdate?.model}'`,
      });

      const { error: crossVehicleDeleteError } = await otherUser.client
        .from('vehicles')
        .delete()
        .eq('id', insertedVehicle.id);
      const { data: vehicleAfterCrossDelete } = await admin
        .from('vehicles')
        .select('id')
        .eq('id', insertedVehicle.id)
        .maybeSingle();
      results.push({
        name: "user B cannot delete user A's vehicle",
        pass: vehicleAfterCrossDelete?.id === insertedVehicle.id,
        detail: crossVehicleDeleteError ? undefined : 'row was deleted by a non-owner!',
      });

      const { error: ownUpdateError } = await vehicleOwner.client
        .from('vehicles')
        .update({ color: 'Red' })
        .eq('id', insertedVehicle.id);
      const { data: vehicleAfterOwnUpdate } = await admin
        .from('vehicles')
        .select('color')
        .eq('id', insertedVehicle.id)
        .single();
      results.push({
        name: 'user A can modify their own vehicle',
        pass: !ownUpdateError && vehicleAfterOwnUpdate?.color === 'Red',
        detail: ownUpdateError?.message,
      });

      // Auto-promoting the first vehicle to primary is APPLICATION-layer
      // behaviour (createVehicle() in lib/actions/vehicles.ts counts the
      // user's existing vehicles and sets is_primary accordingly). The
      // database itself only guarantees "at most one primary per user" —
      // a raw insert like this one correctly defaults is_primary to false.
      // The original assertion here expected the app behaviour from a raw
      // insert and was simply wrong about which layer owns it.
      results.push({
        name: 'a raw vehicle insert defaults to is_primary = false (auto-primary is app-layer)',
        pass: insertedVehicle.is_primary === false,
        detail: `is_primary was ${insertedVehicle.is_primary}`,
      });

      // ---- Only one primary vehicle per user (DB-enforced) ----
      const { data: secondVehicle, error: secondVehicleError } = await vehicleOwner.client
        .from('vehicles')
        .insert({ user_id: vehicleOwner.id, make: 'Toyota', model: 'Corolla', year: 2021 })
        .select('id, is_primary')
        .single();

      if (secondVehicleError || !secondVehicle) {
        results.push({ name: 'setup: user A creates a second vehicle', pass: false, detail: secondVehicleError?.message });
      } else {
        results.push({
          name: 'a second vehicle for the same account is not auto-primary',
          pass: secondVehicle.is_primary === false,
        });

        // Establish a real primary first — the partial unique index only
        // conflicts when a primary already exists. The original version of
        // this test relied on the first vehicle already being primary, which
        // a raw insert never makes it (see the note above), so nothing
        // conflicted and the assertion failed for the wrong reason.
        const { error: firstPrimaryError } = await vehicleOwner.client
          .from('vehicles')
          .update({ is_primary: true })
          .eq('id', insertedVehicle.id);
        results.push({
          name: 'setup: user A marks their first vehicle as primary',
          pass: !firstPrimaryError,
          detail: firstPrimaryError?.message,
        });

        const { error: dualPrimaryError } = await vehicleOwner.client
          .from('vehicles')
          .update({ is_primary: true })
          .eq('id', secondVehicle.id);
        results.push({
          name: 'the DB rejects a second primary vehicle for the same user',
          pass: Boolean(dualPrimaryError),
          detail: dualPrimaryError ? undefined : 'expected a unique_violation, update succeeded instead',
        });

        // The correct client-side flow: clear the old primary first, then set
        // the new one — mirrors setPrimaryVehicle() in lib/actions/vehicles.ts.
        await vehicleOwner.client
          .from('vehicles')
          .update({ is_primary: false })
          .eq('user_id', vehicleOwner.id)
          .eq('is_primary', true);
        const { error: swapPrimaryError } = await vehicleOwner.client
          .from('vehicles')
          .update({ is_primary: true })
          .eq('id', secondVehicle.id);
        results.push({
          name: 'swapping primary via clear-then-set succeeds',
          pass: !swapPrimaryError,
          detail: swapPrimaryError?.message,
        });
      }

      const { error: vehicleDeleteError } = await vehicleOwner.client
        .from('vehicles')
        .delete()
        .eq('id', insertedVehicle.id);
      results.push({
        name: 'user A can delete their own vehicle',
        pass: !vehicleDeleteError,
        detail: vehicleDeleteError?.message,
      });
    }

    // ================================================================
    // Smart Dispatch
    // ================================================================

    // A far-flung point guaranteed >350km from every driver this script
    // creates near Montreal, so "no availability" tests never accidentally
    // pick up a driver left over from an earlier scenario in this same run.
    const REMOTE_POINT = { lat: 0, lng: 0 };
    const MTL = { lat: 45.5, lng: -73.5 };

    const approvedDriverIds: string[] = [];

    async function makeApprovedDriver(opts: {
      lat: number;
      lng: number;
      online?: boolean;
      heartbeatMinutesAgo?: number;
    }): Promise<TestUser> {
      const driver = await createTestUser('driver');
      createdUserIds.push(driver.id);
      const { error } = await admin
        .from('driver_profiles')
        .update({
          approval_status: 'approved',
          is_online: opts.online ?? true,
          current_lat: opts.lat,
          current_lng: opts.lng,
          last_heartbeat_at: new Date(Date.now() - (opts.heartbeatMinutesAgo ?? 0) * 60_000).toISOString(),
        })
        .eq('profile_id', driver.id);
      // Fail loudly. This silently no-op'd on the first live run (0003's
      // guard rejected the service role — fixed in 0016), which produced
      // never-approved, never-online drivers and turned every downstream
      // Smart Dispatch assertion into a misleading "no candidate found".
      if (error) throw new Error(`setup: could not approve/position test driver: ${error.message}`);
      approvedDriverIds.push(driver.id);
      return driver;
    }

    // Test isolation. Every driver this suite creates sits at essentially the
    // same Montreal coordinates, stays approved/online with a fresh
    // heartbeat, and finishes most blocks with no active job — so a driver
    // created for an EARLIER block is still a perfectly valid candidate for a
    // LATER block's request, and dispatch (correctly) picks whichever is
    // nearest. That cross-block bleed made several assertions fail against
    // leftover drivers rather than the ones under test.
    //
    // Retiring previous drivers (offline) before each dispatch block leaves
    // exactly the drivers that block created as candidates.
    // Takes EVERY online driver offline, not just the ones this suite created:
    // any pre-existing fixture left online in the project (a manually seeded
    // demo driver, a leftover from an end-to-end session) is equally a valid
    // dispatch candidate and will win the match if it happens to be nearer.
    // That is safe precisely because this script must only ever point at a
    // disposable instance — see the usage note at the top of the file.
    async function retirePreviousDrivers() {
      const { error } = await admin
        .from('driver_profiles')
        .update({ is_online: false })
        .eq('is_online', true);
      if (error) throw new Error(`setup: could not retire online drivers: ${error.message}`);
      approvedDriverIds.length = 0;
    }

    // A plpgsql function declared `returns dispatch_offers` that returns NULL
    // comes back over PostgREST as a ROW OF NULLS, not as JSON null — so a
    // plain `offer == null` check is never true. "No offer was made" is
    // therefore "there is no driver_id on whatever came back".
    function noOfferMade(offer: { driver_id?: string | null } | null | undefined) {
      return offer == null || offer.driver_id == null;
    }

    async function insertPendingRequest(requester: TestUser, point: { lat: number; lng: number }) {
      const { data, error } = await requester.client
        .from('requests')
        .insert({
          user_id: requester.id,
          problem_type: 'battery',
          location_text: 'Smart Dispatch test',
          lat: point.lat,
          lng: point.lng,
          price_estimate: 55,
        })
        .select('id')
        .single();
      if (error || !data) throw new Error(`setup: could not create request: ${error?.message}`);
      return data.id as string;
    }

    // ---- Best candidate selected; offline and stale drivers excluded ----
    await retirePreviousDrivers();
    {
      const requester = await createTestUser('user');
      createdUserIds.push(requester.id);
      const eligible = await makeApprovedDriver({ ...MTL, online: true, heartbeatMinutesAgo: 0 });
      await makeApprovedDriver({ ...MTL, online: false, heartbeatMinutesAgo: 0 }); // offline — decoy
      await makeApprovedDriver({ ...MTL, online: true, heartbeatMinutesAgo: 10 }); // stale — decoy

      const requestId = await insertPendingRequest(requester, MTL);
      const { data: offer, error: dispatchError } = await requester.client.rpc('dispatch_next_candidate', {
        p_request_id: requestId,
      });

      results.push({
        name: 'dispatch picks the only real candidate, skipping offline and stale drivers',
        pass: !dispatchError && offer?.driver_id === eligible.id,
        detail: dispatchError?.message ?? `expected driver ${eligible.id}, got ${offer?.driver_id}`,
      });
    }

    // ---- No availability anywhere: dispatch returns null, no offer created ----
    {
      const requester = await createTestUser('user');
      createdUserIds.push(requester.id);
      const requestId = await insertPendingRequest(requester, REMOTE_POINT);
      const { data: offer, error: dispatchError } = await requester.client.rpc('dispatch_next_candidate', {
        p_request_id: requestId,
      });
      const { data: offersForRequest } = await admin.from('dispatch_offers').select('id').eq('request_id', requestId);
      results.push({
        name: 'no drivers anywhere: dispatch returns nothing and creates no offer',
        pass: !dispatchError && noOfferMade(offer) && (offersForRequest ?? []).length === 0,
        detail: dispatchError?.message,
      });
    }

    // ---- First candidate accepts ----
    await retirePreviousDrivers();
    {
      const requester = await createTestUser('user');
      createdUserIds.push(requester.id);
      const driver = await makeApprovedDriver({ ...MTL, lat: MTL.lat + 0.01 });
      const requestId = await insertPendingRequest(requester, MTL);
      await requester.client.rpc('dispatch_next_candidate', { p_request_id: requestId });

      const { error: acceptError } = await driver.client.rpc('respond_to_dispatch_offer', {
        p_request_id: requestId,
        p_accept: true,
      });
      const { data: afterAccept } = await admin.from('requests').select('status, driver_id').eq('id', requestId).single();
      results.push({
        name: 'the offered driver can accept, request becomes matched',
        pass: !acceptError && afterAccept?.status === 'matched' && afterAccept?.driver_id === driver.id,
        detail: acceptError?.message,
      });
    }

    // ---- First candidate declines -> second candidate gets the offer
    //      IMMEDIATELY, with no separate redispatch call and no cron
    //      involved (Phase 2.5's core fix: respond_to_dispatch_offer()'s
    //      decline branch calls the matching engine in the same
    //      transaction). ----
    await retirePreviousDrivers();
    let declineDriver1Id: string | undefined;
    let declineDriver2Id: string | undefined;
    let declineRequestId: string | undefined;
    {
      const requester = await createTestUser('user');
      createdUserIds.push(requester.id);
      const driver1 = await makeApprovedDriver({ lat: MTL.lat, lng: MTL.lng });
      const driver2 = await makeApprovedDriver({ lat: MTL.lat + 0.02, lng: MTL.lng });
      declineDriver1Id = driver1.id;
      declineDriver2Id = driver2.id;
      const requestId = await insertPendingRequest(requester, MTL);
      declineRequestId = requestId;
      await requester.client.rpc('dispatch_next_candidate', { p_request_id: requestId });

      const { data: beforeDecline } = await admin.from('requests').select('driver_id').eq('id', requestId).single();
      const { error: declineError } = await driver1.client.rpc('respond_to_dispatch_offer', {
        p_request_id: requestId,
        p_accept: false,
      });
      results.push({
        name: 'the offered driver can decline',
        pass: !declineError && beforeDecline?.driver_id === driver1.id,
        detail: declineError?.message,
      });

      // No manual/cron-simulating call here on purpose — this is exactly
      // what Phase 2.5 changed: the decline call above must have already
      // triggered the next offer by itself.
      const { data: afterDecline } = await admin.from('requests').select('driver_id').eq('id', requestId).single();
      results.push({
        name: 'after a decline, the next-best driver is offered immediately (no cron needed)',
        pass: afterDecline?.driver_id === driver2.id,
        detail: `expected driver ${driver2.id}, got ${afterDecline?.driver_id}`,
      });

      const { data: driver1Offer } = await admin
        .from('dispatch_offers')
        .select('status')
        .eq('request_id', requestId)
        .eq('driver_id', driver1.id)
        .single();
      results.push({
        name: "the declined driver's offer is recorded as 'declined'",
        pass: driver1Offer?.status === 'declined',
        detail: `got status '${driver1Offer?.status}'`,
      });
    }

    // ---- Silent timeout: nudge_dispatch() is a no-op before the offer is
    //      actually due, and advances immediately once it is. ----
    {
    await retirePreviousDrivers();
      const requester = await createTestUser('user');
      createdUserIds.push(requester.id);
      const driver1 = await makeApprovedDriver({ lat: MTL.lat, lng: MTL.lng });
      const driver2 = await makeApprovedDriver({ lat: MTL.lat + 0.02, lng: MTL.lng });
      const requestId = await insertPendingRequest(requester, MTL);
      await requester.client.rpc('dispatch_next_candidate', { p_request_id: requestId });

      const { data: earlyNudge, error: earlyNudgeError } = await requester.client.rpc('nudge_dispatch', {
        p_request_id: requestId,
      });
      const { data: afterEarlyNudge } = await admin.from('requests').select('driver_id').eq('id', requestId).single();
      results.push({
        name: 'nudging before the offer is due is a harmless no-op',
        pass: !earlyNudgeError && noOfferMade(earlyNudge) && afterEarlyNudge?.driver_id === driver1.id,
        detail: earlyNudgeError?.message ?? `driver_id changed to ${afterEarlyNudge?.driver_id} from a no-op nudge`,
      });

      await admin
        .from('dispatch_offers')
        .update({ expires_at: new Date(Date.now() - 1000).toISOString() })
        .eq('request_id', requestId)
        .eq('driver_id', driver1.id);

      const { data: dueNudge, error: dueNudgeError } = await requester.client.rpc('nudge_dispatch', {
        p_request_id: requestId,
      });
      results.push({
        name: 'nudging an overdue offer times it out and offers the next candidate',
        pass: !dueNudgeError && dueNudge?.driver_id === driver2.id,
        detail: dueNudgeError?.message ?? `expected driver ${driver2.id}, got ${dueNudge?.driver_id}`,
      });

      // Regression guard for the defect fixed by
      // 0015_fix_nudge_dispatch_guard.sql: the DRIVER holding the expired
      // offer polls nudge_dispatch() from their own dashboard every 5s
      // (Phase 2.5). That call clears requests.driver_id, which the 0014
      // protected-fields trigger would reject for a driver's auth context
      // unless the write is flagged as an internal system update. Without
      // 0015 this throws 42501 and the driver-side timeout path is dead.
      // Driver2 currently holds the live offer from the nudge above.
      await admin
        .from('dispatch_offers')
        .update({ expires_at: new Date(Date.now() - 1000).toISOString() })
        .eq('request_id', requestId)
        .eq('driver_id', driver2.id)
        .eq('status', 'offered');

      const { error: driverNudgeError } = await driver2.client.rpc('nudge_dispatch', {
        p_request_id: requestId,
      });
      const { data: driver2Offer } = await admin
        .from('dispatch_offers')
        .select('status')
        .eq('request_id', requestId)
        .eq('driver_id', driver2.id)
        .single();
      results.push({
        name: 'the offer-holding driver can nudge their own expired offer (0014 guard does not block it)',
        pass: !driverNudgeError && driver2Offer?.status === 'timeout',
        detail: driverNudgeError?.message ?? `offer status is '${driver2Offer?.status}', expected 'timeout'`,
      });

      const outsider = await createTestUser('user');
      createdUserIds.push(outsider.id);
      const { error: unauthorizedNudgeError } = await outsider.client.rpc('nudge_dispatch', {
        p_request_id: requestId,
      });
      results.push({
        name: 'an unrelated user cannot nudge dispatch for someone else\'s request',
        pass: Boolean(unauthorizedNudgeError),
        detail: unauthorizedNudgeError ? undefined : 'expected an authorization error, call succeeded instead',
      });
    }

    // ---- A newly-online driver is picked up after the initial candidate
    //      pool was exhausted (searching keeps working, no fake driver is
    //      ever fabricated to fill the gap) ----
    {
    await retirePreviousDrivers();
      const requester = await createTestUser('user');
      createdUserIds.push(requester.id);
      const onlyDriver = await makeApprovedDriver({ ...MTL });
      const requestId = await insertPendingRequest(requester, MTL);
      await requester.client.rpc('dispatch_next_candidate', { p_request_id: requestId });
      await onlyDriver.client.rpc('respond_to_dispatch_offer', { p_request_id: requestId, p_accept: false });

      const { data: exhausted } = await admin.from('requests').select('driver_id, status').eq('id', requestId).single();
      results.push({
        name: 'pool exhausted: request stays pending and driverless, no fake driver created',
        pass: exhausted?.status === 'pending' && exhausted?.driver_id === null,
        detail: `status='${exhausted?.status}', driver_id='${exhausted?.driver_id}'`,
      });

      const lateDriver = await makeApprovedDriver({ ...MTL });
      const { data: lateOffer, error: lateOfferError } = await requester.client.rpc('nudge_dispatch', {
        p_request_id: requestId,
      });
      results.push({
        name: 'a driver coming online later is picked up on the next nudge',
        pass: !lateOfferError && lateOffer?.driver_id === lateDriver.id,
        detail: lateOfferError?.message ?? `expected driver ${lateDriver.id}, got ${lateOffer?.driver_id}`,
      });
    }

    // ---- Expired offer cannot be accepted (checked inline, not just by the cron) ----
    await retirePreviousDrivers();
    {
      const requester = await createTestUser('user');
      createdUserIds.push(requester.id);
      const driver = await makeApprovedDriver({ ...MTL });
      const requestId = await insertPendingRequest(requester, MTL);
      await requester.client.rpc('dispatch_next_candidate', { p_request_id: requestId });

      await admin
        .from('dispatch_offers')
        .update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
        .eq('request_id', requestId)
        .eq('driver_id', driver.id);

      const { error: expiredAcceptError } = await driver.client.rpc('respond_to_dispatch_offer', {
        p_request_id: requestId,
        p_accept: true,
      });
      const { data: requestAfter } = await admin.from('requests').select('status').eq('id', requestId).single();
      results.push({
        name: 'an expired offer cannot be accepted',
        pass: Boolean(expiredAcceptError) && requestAfter?.status === 'pending',
        detail: expiredAcceptError ? undefined : `expected an error and status to stay 'pending', got '${requestAfter?.status}'`,
      });

      // 0017: the refused accept no longer pretends to record a timeout — its
      // own RAISE would roll that write back, so the row is deliberately left
      // untouched and a sweep settles it. (acceptRequest() in
      // lib/actions/driver.ts fires that sweep for real users.)
      const { data: offerAfterRefusal } = await admin
        .from('dispatch_offers')
        .select('status')
        .eq('request_id', requestId)
        .eq('driver_id', driver.id)
        .single();
      results.push({
        name: 'a refused expired accept leaves the offer row untouched (no rolled-back write)',
        pass: offerAfterRefusal?.status === 'offered',
        detail: `offer status is '${offerAfterRefusal?.status}', expected 'offered'`,
      });

      const { error: sweepError } = await driver.client.rpc('nudge_dispatch', { p_request_id: requestId });
      const { data: offerAfterSweep } = await admin
        .from('dispatch_offers')
        .select('status')
        .eq('request_id', requestId)
        .eq('driver_id', driver.id)
        .single();
      results.push({
        name: 'sweeping after an expired accept settles the offer as timeout',
        pass: !sweepError && offerAfterSweep?.status === 'timeout',
        detail: sweepError?.message ?? `offer status is '${offerAfterSweep?.status}', expected 'timeout'`,
      });
    }

    // ---- 0017: estimate and dispatch share ONE notion of availability ----
    //      nearby_drivers() used to ignore heartbeat freshness while dispatch
    //      enforced it, so a rider could be quoted a price from a driver the
    //      job could never be offered to.
    await retirePreviousDrivers();
    {
      const requester = await createTestUser('user');
      createdUserIds.push(requester.id);
      const staleDriver = await makeApprovedDriver({ ...MTL, heartbeatMinutesAgo: 10 });

      const { data: quoted } = await requester.client.rpc('nearby_drivers', {
        p_lat: MTL.lat,
        p_lng: MTL.lng,
        p_radius_km: 15,
        p_limit: 5,
      });
      const staleQuoted = (quoted ?? []).some((d: { profile_id: string }) => d.profile_id === staleDriver.id);
      results.push({
        name: 'nearby_drivers() excludes a stale-heartbeat driver (no quote from an undispatchable driver)',
        pass: !staleQuoted,
        detail: staleQuoted ? 'stale driver was returned and would have priced the quote' : undefined,
      });

      const requestId = await insertPendingRequest(requester, MTL);
      const { data: offerForStale } = await requester.client.rpc('dispatch_next_candidate', {
        p_request_id: requestId,
      });
      results.push({
        name: 'dispatch agrees with the estimate: no candidate when the only driver is stale',
        pass: noOfferMade(offerForStale),
        detail: `expected no offer, got driver ${offerForStale?.driver_id}`,
      });

      // And once the same driver pings again, both agree the other way.
      await admin
        .from('driver_profiles')
        .update({ last_heartbeat_at: new Date().toISOString() })
        .eq('profile_id', staleDriver.id);
      const { data: quotedFresh } = await requester.client.rpc('nearby_drivers', {
        p_lat: MTL.lat,
        p_lng: MTL.lng,
        p_radius_km: 15,
        p_limit: 5,
      });
      const { data: offerFresh } = await requester.client.rpc('dispatch_next_candidate', {
        p_request_id: requestId,
      });
      results.push({
        name: 'a freshly-pinging driver is both quotable and dispatchable',
        pass:
          (quotedFresh ?? []).some((d: { profile_id: string }) => d.profile_id === staleDriver.id) &&
          offerFresh?.driver_id === staleDriver.id,
        detail: `quoted=${(quotedFresh ?? []).length}, offered=${offerFresh?.driver_id}`,
      });
    }

    // ---- Concurrency: a bystander driver can never accept someone else's offer ----
    await retirePreviousDrivers();
    {
      const requester = await createTestUser('user');
      createdUserIds.push(requester.id);
      const offeredDriver = await makeApprovedDriver({ ...MTL });
      const bystanderDriver = await createTestUser('driver');
      createdUserIds.push(bystanderDriver.id);
      const requestId = await insertPendingRequest(requester, MTL);
      await requester.client.rpc('dispatch_next_candidate', { p_request_id: requestId });

      // Two drivers "racing" for the same request at once: only the one
      // actually holding the offer can ever succeed, concurrently or not.
      const [offeredResult, bystanderResult] = await Promise.all([
        offeredDriver.client.rpc('respond_to_dispatch_offer', { p_request_id: requestId, p_accept: true }),
        bystanderDriver.client.rpc('respond_to_dispatch_offer', { p_request_id: requestId, p_accept: true }),
      ]);
      results.push({
        name: 'concurrent accept attempts: only the actually-offered driver succeeds',
        pass: !offeredResult.error && Boolean(bystanderResult.error),
        detail: `offered driver error=${offeredResult.error?.message ?? 'none'}, bystander error=${bystanderResult.error?.message ?? 'none'}`,
      });

    }

    // ---- The same invariant at the schema level: the DB itself refuses a
    //      second SIMULTANEOUS 'offered' row for one request, which is what
    //      makes "two drivers accept the same request" structurally
    //      impossible regardless of application-level races.
    //
    //      This needs its own request with an offer still OUTSTANDING. The
    //      original version asserted it right after a successful accept —
    //      by which point the only offer had already flipped to 'accepted',
    //      so a new 'offered' row conflicted with nothing and the insert
    //      (correctly) succeeded. ----
    await retirePreviousDrivers();
    {
      const requester = await createTestUser('user');
      createdUserIds.push(requester.id);
      const offeredDriver = await makeApprovedDriver({ ...MTL });
      const otherDriver = await createTestUser('driver');
      createdUserIds.push(otherDriver.id);
      const requestId = await insertPendingRequest(requester, MTL);
      const { data: liveOffer } = await requester.client.rpc('dispatch_next_candidate', {
        p_request_id: requestId,
      });

      const { data: outstanding } = await admin
        .from('dispatch_offers')
        .select('status')
        .eq('request_id', requestId)
        .eq('status', 'offered');
      results.push({
        name: 'setup: an offer is outstanding before testing the duplicate-offer constraint',
        pass: liveOffer?.driver_id === offeredDriver.id && (outstanding ?? []).length === 1,
        detail: `offered driver=${liveOffer?.driver_id}, outstanding rows=${outstanding?.length}`,
      });

      const { error: dualOfferError } = await admin.from('dispatch_offers').insert({
        request_id: requestId,
        driver_id: otherDriver.id,
        status: 'offered',
        score: 0.5,
        rank: 2,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      });
      results.push({
        name: 'the DB rejects a second simultaneous outstanding offer for the same request',
        pass: Boolean(dualOfferError),
        detail: dualOfferError ? undefined : 'expected a unique_violation, insert succeeded instead',
      });
    }

    // ---- A rider can never write dispatch_offers directly ----
    if (declineRequestId && declineDriver2Id) {
      const requester2 = await createTestUser('user');
      createdUserIds.push(requester2.id);

      const { error: riderInsertError } = await requester2.client.from('dispatch_offers').insert({
        request_id: declineRequestId,
        driver_id: requester2.id,
        status: 'offered',
        score: 1,
        rank: 1,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      });
      results.push({
        name: 'a rider cannot insert a dispatch_offers row',
        pass: Boolean(riderInsertError),
        detail: riderInsertError ? undefined : 'expected an RLS error, insert succeeded instead',
      });

      const { data: beforeTamper } = await admin
        .from('dispatch_offers')
        .select('status')
        .eq('request_id', declineRequestId)
        .eq('driver_id', declineDriver2Id)
        .single();
      await requester2.client
        .from('dispatch_offers')
        .update({ status: 'accepted' })
        .eq('request_id', declineRequestId)
        .eq('driver_id', declineDriver2Id);
      const { data: afterTamper } = await admin
        .from('dispatch_offers')
        .select('status')
        .eq('request_id', declineRequestId)
        .eq('driver_id', declineDriver2Id)
        .single();
      results.push({
        name: "a rider's update to dispatch_offers has no effect (RLS-filtered to zero rows)",
        pass: afterTamper?.status === beforeTamper?.status,
        detail: `status was '${beforeTamper?.status}', is now '${afterTamper?.status}'`,
      });
    }

    // ---- A driver cannot read dispatch_offers belonging to another driver ----
    if (declineDriver1Id) {
      const outsiderDriver = await createTestUser('driver');
      createdUserIds.push(outsiderDriver.id);
      const { data: crossOfferRead, error: crossOfferError } = await outsiderDriver.client
        .from('dispatch_offers')
        .select('id')
        .eq('driver_id', declineDriver1Id);
      results.push({
        name: "a driver cannot read another driver's dispatch_offers rows",
        pass: !crossOfferError && (crossOfferRead ?? []).length === 0,
        detail: crossOfferError ? crossOfferError.message : 'rows were visible!',
      });
    }

    // ---- Cancelling a request with an outstanding offer resolves it immediately ----
    await retirePreviousDrivers();
    {
      const requester = await createTestUser('user');
      createdUserIds.push(requester.id);
      await makeApprovedDriver({ ...MTL });
      const requestId = await insertPendingRequest(requester, MTL);
      await requester.client.rpc('dispatch_next_candidate', { p_request_id: requestId });

      await requester.client.from('requests').update({ status: 'cancelled' }).eq('id', requestId);
      const { data: offerAfterCancel } = await admin
        .from('dispatch_offers')
        .select('status')
        .eq('request_id', requestId)
        .single();
      results.push({
        name: 'cancelling a request marks its outstanding offer resolved immediately',
        pass: offerAfterCancel?.status === 'timeout',
        detail: `offer status is '${offerAfterCancel?.status}'`,
      });
    }

    // ================================================================
    // Messages (Phase 3)
    // ================================================================
    {
      const rider = await createTestUser('user');
      createdUserIds.push(rider.id);
      const assignedDriver = await makeApprovedDriver({ ...MTL });
      const otherDriver = await createTestUser('driver');
      createdUserIds.push(otherDriver.id);
      const otherRider = await createTestUser('user');
      createdUserIds.push(otherRider.id);

      const requestId = await insertPendingRequest(rider, MTL);
      // Direct admin assignment, bypassing dispatch — this block is testing
      // messages RLS, not the matching engine (already covered above).
      await admin.from('requests').update({ driver_id: assignedDriver.id, status: 'matched' }).eq('id', requestId);

      const { data: riderMsg, error: riderSendError } = await rider.client
        .from('messages')
        .insert({ request_id: requestId, sender_id: rider.id, body: 'Hello' })
        .select('id')
        .single();
      results.push({
        name: 'the request owner can send a message',
        pass: !riderSendError && Boolean(riderMsg),
        detail: riderSendError?.message,
      });

      const { data: driverMsg, error: driverSendError } = await assignedDriver.client
        .from('messages')
        .insert({ request_id: requestId, sender_id: assignedDriver.id, template_key: 'on_my_way' })
        .select('id')
        .single();
      results.push({
        name: 'the assigned driver can send a message',
        pass: !driverSendError && Boolean(driverMsg),
        detail: driverSendError?.message,
      });

      const { data: riderRead } = await rider.client.from('messages').select('id').eq('request_id', requestId);
      results.push({
        name: 'the request owner can read the full conversation',
        pass: (riderRead ?? []).length === 2,
        detail: `read ${riderRead?.length ?? 0} message(s), expected 2`,
      });

      const { data: driverRead } = await assignedDriver.client.from('messages').select('id').eq('request_id', requestId);
      results.push({
        name: 'the assigned driver can read the full conversation',
        pass: (driverRead ?? []).length === 2,
        detail: `read ${driverRead?.length ?? 0} message(s), expected 2`,
      });

      const { data: otherRiderRead, error: otherRiderReadError } = await otherRider.client
        .from('messages')
        .select('id')
        .eq('request_id', requestId);
      results.push({
        name: 'a different rider cannot read the conversation',
        pass: !otherRiderReadError && (otherRiderRead ?? []).length === 0,
        detail: otherRiderReadError ? otherRiderReadError.message : 'rows were visible!',
      });

      const { data: otherDriverRead, error: otherDriverReadError } = await otherDriver.client
        .from('messages')
        .select('id')
        .eq('request_id', requestId);
      results.push({
        name: 'an unassigned driver cannot read the conversation',
        pass: !otherDriverReadError && (otherDriverRead ?? []).length === 0,
        detail: otherDriverReadError ? otherDriverReadError.message : 'rows were visible!',
      });

      const { error: thirdPartySendError } = await otherRider.client
        .from('messages')
        .insert({ request_id: requestId, sender_id: otherRider.id, body: 'butting in' });
      results.push({
        name: "a third party cannot send a message on someone else's request",
        pass: Boolean(thirdPartySendError),
        detail: thirdPartySendError ? undefined : 'insert succeeded, expected an RLS rejection',
      });

      const { error: spoofError } = await rider.client
        .from('messages')
        .insert({ request_id: requestId, sender_id: assignedDriver.id, body: 'pretending to be the driver' });
      results.push({
        name: 'a participant cannot send a message spoofing another sender_id',
        pass: Boolean(spoofError),
        detail: spoofError ? undefined : 'insert succeeded, expected an RLS rejection',
      });

      const unassignedRequestId = await insertPendingRequest(rider, REMOTE_POINT);
      const { error: unassignedWriteError } = await otherDriver.client
        .from('messages')
        .insert({ request_id: unassignedRequestId, sender_id: otherDriver.id, body: 'hi, want a tow?' });
      results.push({
        name: 'an unattributed request cannot be messaged by an arbitrary driver',
        pass: Boolean(unassignedWriteError),
        detail: unassignedWriteError ? undefined : 'insert succeeded, expected an RLS rejection',
      });

      const adminUser = await createTestUser('user');
      createdUserIds.push(adminUser.id);
      await admin.from('profiles').update({ role: 'admin' }).eq('id', adminUser.id);
      const { data: adminRead, error: adminReadError } = await adminUser.client
        .from('messages')
        .select('id')
        .eq('request_id', requestId);
      results.push({
        name: 'an admin (real admin-role session, not the service-role client) can read the conversation',
        pass: !adminReadError && (adminRead ?? []).length === 2,
        detail: adminReadError?.message ?? `read ${adminRead?.length ?? 0} message(s), expected 2`,
      });
    }

    // ================================================================
    // Request status transition guard (Phase 3)
    // ================================================================
    {
      const rider = await createTestUser('user');
      createdUserIds.push(rider.id);
      const driver = await makeApprovedDriver({ ...MTL });
      const requestId = await insertPendingRequest(rider, MTL);
      await admin.from('requests').update({ driver_id: driver.id, status: 'matched' }).eq('id', requestId);

      const { error: toEnRouteError } = await driver.client.from('requests').update({ status: 'en_route' }).eq('id', requestId);
      results.push({
        name: 'valid transition matched -> en_route is allowed',
        pass: !toEnRouteError,
        detail: toEnRouteError?.message,
      });

      const { error: skipToCompletedError } = await driver.client.from('requests').update({ status: 'completed' }).eq('id', requestId);
      const { data: afterSkipAttempt } = await admin.from('requests').select('status').eq('id', requestId).single();
      results.push({
        name: 'skipping states (en_route -> completed) is rejected server-side',
        pass: Boolean(skipToCompletedError) && afterSkipAttempt?.status === 'en_route',
        detail: skipToCompletedError ? undefined : `update succeeded, status is now '${afterSkipAttempt?.status}'`,
      });

      const { error: toArrivedError } = await driver.client.from('requests').update({ status: 'arrived' }).eq('id', requestId);
      results.push({
        name: 'valid transition en_route -> arrived is allowed',
        pass: !toArrivedError,
        detail: toArrivedError?.message,
      });

      const { error: backwardsError } = await driver.client.from('requests').update({ status: 'matched' }).eq('id', requestId);
      const { data: afterBackwardsAttempt } = await admin.from('requests').select('status').eq('id', requestId).single();
      results.push({
        name: 'moving backwards (arrived -> matched) is rejected server-side',
        pass: Boolean(backwardsError) && afterBackwardsAttempt?.status === 'arrived',
        detail: backwardsError ? undefined : `update succeeded, status is now '${afterBackwardsAttempt?.status}'`,
      });

      const { error: toInProgressError } = await driver.client.from('requests').update({ status: 'in_progress' }).eq('id', requestId);
      results.push({
        name: 'valid transition arrived -> in_progress is allowed',
        pass: !toInProgressError,
        detail: toInProgressError?.message,
      });

      const { error: toCompletedError } = await driver.client.from('requests').update({ status: 'completed' }).eq('id', requestId);
      results.push({
        name: 'valid transition in_progress -> completed is allowed',
        pass: !toCompletedError,
        detail: toCompletedError?.message,
      });

      const otherRequestId = await insertPendingRequest(rider, MTL);
      const otherDriver2 = await makeApprovedDriver({ lat: MTL.lat + 0.05, lng: MTL.lng });
      await admin.from('requests').update({ driver_id: otherDriver2.id, status: 'matched' }).eq('id', otherRequestId);
      await driver.client.from('requests').update({ status: 'en_route' }).eq('id', otherRequestId);
      const { data: otherRequestAfter } = await admin.from('requests').select('status').eq('id', otherRequestId).single();
      results.push({
        name: "a driver cannot change another driver's request status",
        pass: otherRequestAfter?.status === 'matched',
        detail: `status is now '${otherRequestAfter?.status}'`,
      });
    }

    // ================================================================
    // 'in_progress' counts as an active job everywhere 'matched'/'en_route'/
    // 'arrived' already did (Phase 3 follow-up fix, 0011)
    // ================================================================
    {
    await retirePreviousDrivers();
      const rider1 = await createTestUser('user');
      createdUserIds.push(rider1.id);
      const busyDriver = await makeApprovedDriver({ ...MTL });
      const busyRequestId = await insertPendingRequest(rider1, MTL);
      await admin.from('requests').update({ driver_id: busyDriver.id, status: 'in_progress' }).eq('id', busyRequestId);

      const rider2 = await createTestUser('user');
      createdUserIds.push(rider2.id);
      const newRequestId = await insertPendingRequest(rider2, MTL);
      const { data: offer } = await rider2.client.rpc('dispatch_next_candidate', { p_request_id: newRequestId });
      results.push({
        name: 'a driver mid-intervention (in_progress) is not offered a new job',
        pass: noOfferMade(offer),
        detail: `expected no offer, got driver ${offer?.driver_id}`,
      });

      const rider3 = await createTestUser('user');
      createdUserIds.push(rider3.id);
      const req3 = await insertPendingRequest(rider3, MTL);
      const { error: doubleBookError } = await admin
        .from('requests')
        .update({ driver_id: busyDriver.id, status: 'matched' })
        .eq('id', req3);
      results.push({
        name: 'the DB rejects double-booking a driver already in_progress on another job',
        pass: Boolean(doubleBookError),
        detail: doubleBookError ? undefined : 'update succeeded, expected a unique_violation',
      });

      const { data: profileRead, error: profileReadError } = await rider1.client
        .from('driver_profiles')
        .select('profile_id')
        .eq('profile_id', busyDriver.id)
        .maybeSingle();
      results.push({
        name: "the rider can read their driver's profile while status is in_progress",
        pass: !profileReadError && profileRead?.profile_id === busyDriver.id,
        detail: profileReadError?.message,
      });
    }

    // ================================================================
    // Request field lockdown (Phase 4) — a driver may only ever change
    // `status`; price, destination, pickup, vehicle, and driver_id itself
    // are off limits from their own session, server-side, regardless of UI.
    // ================================================================
    {
      const rider = await createTestUser('user');
      createdUserIds.push(rider.id);
      const driver = await makeApprovedDriver({ ...MTL });
      const requestId = await insertPendingRequest(rider, MTL);
      await admin.from('requests').update({ driver_id: driver.id, status: 'matched' }).eq('id', requestId);

      const attempts: [string, Record<string, unknown>][] = [
        ['price_estimate', { price_estimate: 999999 }],
        ['user_id', { user_id: driver.id }],
        ['lat', { lat: 0 }],
        ['destination_address', { destination_address: 'somewhere else' }],
        ['vehicle_desc', { vehicle_desc: 'a different car entirely' }],
      ];

      for (const [field, patch] of attempts) {
        await driver.client.from('requests').update(patch).eq('id', requestId);
        const { data: after } = await admin.from('requests').select('*').eq('id', requestId).single();
        const unchanged =
          field === 'price_estimate'
            ? Number(after?.price_estimate) !== 999999
            : field === 'user_id'
              ? after?.user_id !== driver.id
              : field === 'lat'
                ? after?.lat !== 0
                : field === 'destination_address'
                  ? after?.destination_address !== 'somewhere else'
                  : after?.vehicle_desc !== 'a different car entirely';
        results.push({
          name: `a driver cannot modify requests.${field} from their own session`,
          pass: unchanged,
          detail: unchanged ? undefined : `${field} was changed by the driver`,
        });
      }

      const { error: statusOk } = await driver.client.from('requests').update({ status: 'en_route' }).eq('id', requestId);
      results.push({
        name: 'a driver can still change status (the one field this lockdown allows)',
        pass: !statusOk,
        detail: statusOk?.message,
      });
    }

    // ================================================================
    // Payments (Phase 4)
    // ================================================================
    {
      const rider = await createTestUser('user');
      createdUserIds.push(rider.id);
      const otherRider = await createTestUser('user');
      createdUserIds.push(otherRider.id);
      const driver = await makeApprovedDriver({ ...MTL });
      const requestId = await insertPendingRequest(rider, MTL);
      await admin.from('requests').update({ driver_id: driver.id, status: 'matched' }).eq('id', requestId);

      const { data: paymentRow, error: paymentInsertError } = await admin
        .from('payments')
        .insert({ request_id: requestId, amount: 87.5, status: 'authorized', stripe_payment_intent_id: `pi_test_${requestId}` })
        .select('id')
        .single();
      if (paymentInsertError || !paymentRow) {
        results.push({ name: 'setup: create a payment row (service role)', pass: false, detail: paymentInsertError?.message });
      } else {
        const { data: riderRead } = await rider.client.from('payments').select('id').eq('id', paymentRow.id).maybeSingle();
        results.push({
          name: 'the rider (request owner) can read their own payment',
          pass: riderRead?.id === paymentRow.id,
        });

        const { data: otherRiderRead, error: otherRiderReadError } = await otherRider.client
          .from('payments')
          .select('id')
          .eq('id', paymentRow.id);
        results.push({
          name: "a different rider cannot read another rider's payment",
          pass: !otherRiderReadError && (otherRiderRead ?? []).length === 0,
          detail: otherRiderReadError ? otherRiderReadError.message : 'rows were visible!',
        });

        const { data: driverRead, error: driverReadError } = await driver.client
          .from('payments')
          .select('id')
          .eq('id', paymentRow.id);
        results.push({
          name: 'the assigned driver cannot read the payment (no private client payment data)',
          pass: !driverReadError && (driverRead ?? []).length === 0,
          detail: driverReadError ? driverReadError.message : 'rows were visible!',
        });

        const { error: selfMarkPaidError } = await rider.client
          .from('payments')
          .update({ status: 'captured' })
          .eq('id', paymentRow.id);
        const { data: afterSelfMark } = await admin.from('payments').select('status').eq('id', paymentRow.id).single();
        results.push({
          name: 'a rider cannot mark their own payment as captured/paid',
          pass: afterSelfMark?.status === 'authorized',
          detail: selfMarkPaidError ? undefined : `status is now '${afterSelfMark?.status}', expected it unchanged`,
        });

        const { error: directInsertError } = await rider.client
          .from('payments')
          .insert({ request_id: requestId, amount: 1, status: 'captured' });
        results.push({
          name: 'a rider cannot insert their own payments row directly',
          pass: Boolean(directInsertError),
          detail: directInsertError ? undefined : 'insert succeeded, expected an RLS rejection',
        });
      }
    }

    // ================================================================
    // Webhook idempotency ledger — the unique constraint that makes
    // "processed this Stripe event twice" impossible at the DB level.
    // ================================================================
    {
      const eventId = `evt_test_${Date.now()}`;
      const { error: firstInsertError } = await admin
        .from('stripe_webhook_events')
        .insert({ stripe_event_id: eventId, type: 'payment_intent.succeeded' });
      const { error: duplicateInsertError } = await admin
        .from('stripe_webhook_events')
        .insert({ stripe_event_id: eventId, type: 'payment_intent.succeeded' });
      results.push({
        name: 'the same Stripe webhook event id can only be recorded once',
        pass: !firstInsertError && Boolean(duplicateInsertError),
        detail: firstInsertError?.message ?? (duplicateInsertError ? undefined : 'duplicate insert succeeded, expected a unique_violation'),
      });
    }

    // ================================================================
    // stripe_customer_id lockdown — a user cannot point their own account
    // at an arbitrary Stripe customer id via a plain profile update.
    // ================================================================
    {
      const rider = await createTestUser('user');
      createdUserIds.push(rider.id);
      const { error: selfSetError } = await rider.client
        .from('profiles')
        .update({ stripe_customer_id: 'cus_hijacked' })
        .eq('id', rider.id);
      const { data: afterSelfSet } = await admin.from('profiles').select('stripe_customer_id').eq('id', rider.id).single();
      results.push({
        name: 'a user cannot set their own stripe_customer_id directly',
        pass: afterSelfSet?.stripe_customer_id !== 'cus_hijacked',
        detail: selfSetError ? undefined : `stripe_customer_id is now '${afterSelfSet?.stripe_customer_id}'`,
      });
    }

    // ================================================================
    // Phase 5 — driver documents (0019_driver_documents.sql)
    //
    // Same trust model as payments: a driver may see and add their own
    // documents, but there is no UPDATE policy for a driver's own session at
    // all, so "a driver approves their own document" isn't something to
    // guard against, it's structurally absent. Cleans up every
    // driver_documents / companies row it creates itself, immediately, via
    // the service-role client — both companies.owner_id and
    // driver_documents.reviewed_by reference profiles(id) WITHOUT
    // on-delete-cascade, so leaving one pointed at a test user this suite is
    // about to delete would fail that user's cleanup with a foreign-key
    // violation and leak every user created after it in createdUserIds.
    // ================================================================
    {
      const driverA = await createTestUser('driver');
      createdUserIds.push(driverA.id);
      const driverB = await createTestUser('driver');
      createdUserIds.push(driverB.id);
      const rider = await createTestUser('user');
      createdUserIds.push(rider.id);
      const adminUser = await createTestUser('user');
      createdUserIds.push(adminUser.id);
      await admin.from('profiles').update({ role: 'admin' }).eq('id', adminUser.id);

      const documentIds: string[] = [];

      const { data: insertedDoc, error: insertDocError } = await driverA.client
        .from('driver_documents')
        .insert({ driver_id: driverA.id, type: 'license', storage_path: `${driverA.id}/rls-test-license.jpg` })
        .select('id')
        .single();
      if (insertedDoc) documentIds.push(insertedDoc.id);
      results.push({
        name: 'a driver can upload their own document as a fresh pending row',
        pass: !insertDocError && Boolean(insertedDoc),
        detail: insertDocError?.message,
      });

      const { error: bypassInsertError } = await driverA.client
        .from('driver_documents')
        .insert({ driver_id: driverA.id, type: 'insurance', storage_path: `${driverA.id}/rls-test-preapproved.jpg`, status: 'approved' });
      results.push({
        name: 'a driver cannot upload a document that arrives pre-approved',
        pass: Boolean(bypassInsertError),
        detail: bypassInsertError ? undefined : 'insert succeeded, expected the WITH CHECK to reject it',
      });

      if (insertedDoc) {
        const { data: crossDriverRead } = await driverB.client.from('driver_documents').select('id').eq('id', insertedDoc.id);
        results.push({
          name: "a driver cannot read another driver's document",
          pass: (crossDriverRead ?? []).length === 0,
          detail: (crossDriverRead ?? []).length > 0 ? 'driver B read driver A document' : undefined,
        });

        const { data: riderRead } = await rider.client.from('driver_documents').select('id').eq('id', insertedDoc.id);
        results.push({
          name: "a rider cannot read a driver's document",
          pass: (riderRead ?? []).length === 0,
          detail: (riderRead ?? []).length > 0 ? 'rider read a driver document' : undefined,
        });

        // No UPDATE policy at all means Postgres RLS filters the target row
        // to zero matches rather than raising an error — the same
        // "succeeds, but affects nothing" shape as the dispatch_offers
        // rider-update test above. The only real signal is the row itself.
        await driverA.client.from('driver_documents').update({ status: 'approved' }).eq('id', insertedDoc.id);
        const { data: afterSelfApprove } = await admin.from('driver_documents').select('status').eq('id', insertedDoc.id).single();
        results.push({
          name: "a driver's self-approval attempt has no effect (no UPDATE policy at all)",
          pass: afterSelfApprove?.status === 'pending',
          detail: afterSelfApprove?.status !== 'pending' ? `status is now '${afterSelfApprove?.status}', expected it unchanged` : undefined,
        });

        const { data: adminReview, error: adminReviewError } = await adminUser.client
          .from('driver_documents')
          .update({ status: 'approved', reviewed_at: new Date().toISOString(), reviewed_by: adminUser.id })
          .eq('id', insertedDoc.id)
          .select('status')
          .single();
        results.push({
          name: 'an admin (real admin-role session) can review a driver document',
          pass: !adminReviewError && adminReview?.status === 'approved',
          detail: adminReviewError?.message ?? `status is '${adminReview?.status}', expected 'approved'`,
        });

        // Same shape again: DELETE under a USING clause that doesn't match
        // returns success with zero rows deleted, not an error. Verified by
        // hand against a live project before trusting this pattern here —
        // a `{success:true,data:[]}` 200 response with the row provably
        // still present, not a client-visible rejection.
        await driverA.client.from('driver_documents').delete().eq('id', insertedDoc.id);
        const { data: stillThere } = await admin.from('driver_documents').select('id').eq('id', insertedDoc.id).maybeSingle();
        results.push({
          name: "a driver's attempt to delete their own approved document has no effect",
          pass: Boolean(stillThere),
          detail: stillThere ? undefined : 'the approved document row is gone',
        });
      }

      const { data: secondDoc, error: secondDocError } = await driverA.client
        .from('driver_documents')
        .insert({ driver_id: driverA.id, type: 'registration', storage_path: `${driverA.id}/rls-test-registration.jpg` })
        .select('id')
        .single();
      if (secondDoc) documentIds.push(secondDoc.id);
      if (!secondDocError && secondDoc) {
        const { error: deletePendingError } = await driverA.client.from('driver_documents').delete().eq('id', secondDoc.id);
        results.push({
          name: 'a driver can delete their own non-approved document',
          pass: !deletePendingError,
          detail: deletePendingError?.message,
        });
        if (!deletePendingError) documentIds.splice(documentIds.indexOf(secondDoc.id), 1);
      }

      // ---- driver_profiles: rejection_reason and company_id are guarded
      //      the same way approval_status/rating/total_services already are
      //      (0019, 0020 extend the same trigger function) ----
      const { error: selfRejectionError } = await driverA.client
        .from('driver_profiles')
        .update({ rejection_reason: 'self-authored excuse' })
        .eq('profile_id', driverA.id);
      const { data: afterSelfRejection } = await admin.from('driver_profiles').select('rejection_reason').eq('profile_id', driverA.id).single();
      results.push({
        name: 'a driver cannot set their own rejection_reason',
        pass: Boolean(selfRejectionError) && afterSelfRejection?.rejection_reason == null,
        detail: selfRejectionError ? undefined : `rejection_reason is now '${afterSelfRejection?.rejection_reason}'`,
      });

      // ---- companies (0020_companies_prep.sql) ----
      const { data: company, error: companyInsertError } = await admin
        .from('companies')
        .insert({ name: 'RLS Test Towing Co.', owner_id: driverA.id })
        .select('id')
        .single();

      if (company) {
        const { error: selfCompanyIdError } = await driverA.client.from('driver_profiles').update({ company_id: company.id }).eq('profile_id', driverA.id);
        const { data: afterSelfCompanyId } = await admin.from('driver_profiles').select('company_id').eq('profile_id', driverA.id).single();
        results.push({
          name: 'a driver cannot set their own company_id',
          pass: Boolean(selfCompanyIdError) && afterSelfCompanyId?.company_id == null,
          detail: selfCompanyIdError ? undefined : `company_id is now '${afterSelfCompanyId?.company_id}'`,
        });

        const { data: ownerRead } = await driverA.client.from('companies').select('id').eq('id', company.id).maybeSingle();
        results.push({
          name: "a company's owner can read their own company row",
          pass: ownerRead?.id === company.id,
          detail: ownerRead ? undefined : 'owner session read no row',
        });

        const { data: strangerRead } = await driverB.client.from('companies').select('id').eq('id', company.id);
        results.push({
          name: "a company is not readable by an account that doesn't own it",
          pass: (strangerRead ?? []).length === 0,
          detail: (strangerRead ?? []).length > 0 ? 'a non-owner read the company row' : undefined,
        });

        const { error: driverCreateCompanyError } = await driverB.client.from('companies').insert({ name: 'Rogue Co.', owner_id: driverB.id });
        results.push({
          name: 'a driver cannot create a company directly (no INSERT policy at all)',
          pass: Boolean(driverCreateCompanyError),
          detail: driverCreateCompanyError ? undefined : 'insert succeeded, expected an RLS rejection',
        });

        await admin.from('companies').delete().eq('id', company.id);
      } else {
        results.push({ name: 'setup: create a company row (service role)', pass: false, detail: companyInsertError?.message });
      }

      // Explicit cleanup before this block's users are deleted — see the
      // comment at the top of this section for why this can't wait for the
      // generic per-user cleanup below.
      if (documentIds.length > 0) {
        await admin.from('driver_documents').delete().in('id', documentIds);
      }
    }

    // ================================================================
    // Phase 5 — an unapproved driver is never quotable, not just never
    // dispatchable. nearby_drivers() already filters on approval_status =
    // 'approved' (0002_hardening.sql); this pins that specific guarantee
    // with its own test rather than relying on it being incidentally true
    // in the dispatch tests above.
    // ================================================================
    {
      const requester = await createTestUser('user');
      createdUserIds.push(requester.id);
      const unapprovedDriver = await createTestUser('driver');
      createdUserIds.push(unapprovedDriver.id);
      // Deliberately not using makeApprovedDriver() — approval_status stays
      // at its default 'pending' while everything else about this driver
      // (online, positioned, fresh heartbeat) looks exactly like a
      // dispatchable one.
      await admin
        .from('driver_profiles')
        .update({ is_online: true, current_lat: MTL.lat, current_lng: MTL.lng, last_heartbeat_at: new Date().toISOString() })
        .eq('profile_id', unapprovedDriver.id);

      const { data: quoted } = await requester.client.rpc('nearby_drivers', {
        p_lat: MTL.lat,
        p_lng: MTL.lng,
        p_radius_km: 15,
        p_limit: 10,
      });
      const unapprovedQuoted = (quoted ?? []).some((d: { profile_id: string }) => d.profile_id === unapprovedDriver.id);
      results.push({
        name: 'nearby_drivers() excludes an unapproved driver even when online with a fresh heartbeat',
        pass: !unapprovedQuoted,
        detail: unapprovedQuoted ? 'unapproved driver was returned and would have priced/dispatched the quote' : undefined,
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
      // `detail` is written as failure-explaining text, so only show it on a
      // failure — printing it next to a ✓ made passing runs read alarmingly
      // (e.g. "✓ user B cannot delete user A's vehicle — row was deleted!").
      console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}${!r.pass && r.detail ? ` — ${r.detail}` : ''}`);
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
