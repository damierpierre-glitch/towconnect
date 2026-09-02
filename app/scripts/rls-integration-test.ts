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

    // ================================================================
    // Phase 5.1 — profile privacy (0022_profile_privacy_after_matching.sql)
    //
    // Smart Dispatch sets requests.driver_id when it makes the OFFER, while
    // status is still 'pending'. The original participants policy keyed on
    // driver_id alone, so a driver who had merely been offered a job could
    // read the rider's name and phone before accepting — and a rider could
    // read an offered driver's profile just as early.
    //
    // The replacement keys on "this request ever reached 'matched'"
    // (request_events). These assertions pin both halves: the pre-acceptance
    // paths stay closed, and every post-matching read the product actually
    // depends on keeps working.
    // ================================================================
    await retirePreviousDrivers();
    {
      const rider = await createTestUser('user');
      createdUserIds.push(rider.id);
      await admin.from('profiles').update({ phone: '514-555-0177' }).eq('id', rider.id);

      const driverA = await makeApprovedDriver({ ...MTL });
      const driverB = await createTestUser('driver');
      createdUserIds.push(driverB.id);

      const readRiderAs = async (as: TestUser) => {
        const { data } = await as.client.from('profiles').select('full_name, phone').eq('id', rider.id).maybeSingle();
        return data;
      };

      // ---- an outstanding offer is NOT an assignment ----
      const offeredRequestId = await insertPendingRequest(rider, MTL);
      await rider.client.rpc('dispatch_next_candidate', { p_request_id: offeredRequestId });
      const { data: offeredRow } = await admin
        .from('requests')
        .select('status, driver_id')
        .eq('id', offeredRequestId)
        .single();
      results.push({
        name: 'setup: an outstanding offer sets driver_id while status is still pending',
        pass: offeredRow?.status === 'pending' && offeredRow?.driver_id === driverA.id,
        detail: `status='${offeredRow?.status}', driver_id points at the offered driver=${offeredRow?.driver_id === driverA.id}`,
      });

      const offeredRead = await readRiderAs(driverA);
      results.push({
        name: 'a driver holding only a pending offer cannot read the rider profile',
        pass: offeredRead == null,
        detail: offeredRead ? `leaked ${JSON.stringify(offeredRead)}` : undefined,
      });

      const strangerRead = await readRiderAs(driverB);
      results.push({
        name: 'a driver with no relationship to the request never reads the rider profile',
        pass: strangerRead == null,
        detail: strangerRead ? `leaked ${JSON.stringify(strangerRead)}` : undefined,
      });

      // The leak was symmetric — the rider could read an offered driver's
      // profile row before that driver had agreed to anything.
      const { data: riderReadsOfferedDriver } = await rider.client
        .from('profiles')
        .select('full_name')
        .eq('id', driverA.id)
        .maybeSingle();
      results.push({
        name: 'a rider cannot read the profile of a driver who has only been offered their job',
        pass: riderReadsOfferedDriver == null,
        detail: riderReadsOfferedDriver ? `leaked ${JSON.stringify(riderReadsOfferedDriver)}` : undefined,
      });

      // ---- accepting is what opens it ----
      const { error: acceptError } = await driverA.client.rpc('respond_to_dispatch_offer', {
        p_request_id: offeredRequestId,
        p_accept: true,
      });
      const matchedRead = await readRiderAs(driverA);
      results.push({
        name: 'once the driver accepts and becomes requests.driver_id, the rider profile is readable',
        pass: !acceptError && matchedRead?.full_name != null,
        detail: acceptError?.message ?? (matchedRead ? undefined : 'still blocked after matching — regression'),
      });

      const { data: riderReadsMatchedDriver } = await rider.client
        .from('profiles')
        .select('full_name')
        .eq('id', driverA.id)
        .maybeSingle();
      results.push({
        name: 'after matching, the rider can read their assigned driver profile (tracking screen)',
        pass: riderReadsMatchedDriver?.full_name != null,
        detail: riderReadsMatchedDriver ? undefined : 'blocked after matching — regression',
      });

      // Chat is governed by its own policies and must be unaffected.
      const { error: driverMsgError } = await driverA.client
        .from('messages')
        .insert({ request_id: offeredRequestId, sender_id: driverA.id, template_key: 'on_my_way' });
      const { data: riderSeesMsg } = await rider.client
        .from('messages')
        .select('id')
        .eq('request_id', offeredRequestId);
      results.push({
        name: 'chat still works after matching (unaffected by the profiles policy change)',
        pass: !driverMsgError && (riderSeesMsg ?? []).length === 1,
        detail: driverMsgError?.message ?? `rider sees ${riderSeesMsg?.length ?? 0} message(s), expected 1`,
      });

      // A completed job must stay readable — the rider's receipt names the
      // driver, and the driver's history names the client.
      for (const next of ['en_route', 'arrived', 'in_progress', 'completed'] as const) {
        await driverA.client.from('requests').update({ status: next }).eq('id', offeredRequestId);
      }
      const { data: completedRow } = await admin.from('requests').select('status').eq('id', offeredRequestId).single();
      const { data: riderReadsDriverAfterCompletion } = await rider.client
        .from('profiles')
        .select('full_name')
        .eq('id', driverA.id)
        .maybeSingle();
      results.push({
        name: 'after completion, the rider can still read the driver profile (receipt)',
        pass: completedRow?.status === 'completed' && riderReadsDriverAfterCompletion?.full_name != null,
        detail: completedRow?.status !== 'completed'
          ? `request is '${completedRow?.status}', expected 'completed'`
          : riderReadsDriverAfterCompletion
            ? undefined
            : 'blocked on a completed job — receipt regression',
      });
      results.push({
        name: 'after completion, the driver can still read the client profile (driver history)',
        pass: (await readRiderAs(driverA))?.full_name != null,
        detail: 'blocked on a completed job — driver history regression',
      });

      // ---- declining closes it again ----
      //
      // A FRESH rider, deliberately. driverA and the rider above now share a
      // COMPLETED job, which legitimately and permanently grants that read —
      // reusing the pair here would prove nothing about declining, it would
      // just re-observe the completed job. (Written the reusing way first;
      // the suite caught it.)
      //
      // The heartbeat is also refreshed before each dispatch below: several
      // minutes of test time have passed since makeApprovedDriver(), and a
      // stale driver is not a dispatch candidate — without this the offer is
      // never made and the "cannot read" assertion passes vacuously. The
      // setup assertions guard exactly that.
      const declineRider = await createTestUser('user');
      createdUserIds.push(declineRider.id);
      await admin.from('driver_profiles')
        .update({ is_online: true, last_heartbeat_at: new Date().toISOString() })
        .eq('profile_id', driverA.id);

      const declinedRequestId = await insertPendingRequest(declineRider, MTL);
      const { data: declineOffer } = await declineRider.client.rpc('dispatch_next_candidate', {
        p_request_id: declinedRequestId,
      });
      results.push({
        name: 'setup: the decline case really produced an offer to this driver',
        pass: !noOfferMade(declineOffer),
        detail: 'no offer was made, so the decline assertion below would pass vacuously',
      });

      await driverA.client.rpc('respond_to_dispatch_offer', { p_request_id: declinedRequestId, p_accept: false });
      const { data: declinedRead } = await driverA.client
        .from('profiles')
        .select('full_name, phone')
        .eq('id', declineRider.id)
        .maybeSingle();
      results.push({
        name: 'a driver who declined an offer cannot read that rider profile',
        pass: declinedRead == null,
        detail: declinedRead ? `leaked ${JSON.stringify(declinedRead)}` : undefined,
      });

      // ---- an expired request keeps its driver_id: the case a naive
      //      "status <> 'pending'" fix would have missed entirely ----
      const expiredRider = await createTestUser('user');
      createdUserIds.push(expiredRider.id);
      await admin.from('driver_profiles')
        .update({ is_online: true, last_heartbeat_at: new Date().toISOString() })
        .eq('profile_id', driverA.id);

      const expiredRequestId = await insertPendingRequest(expiredRider, MTL);
      const { data: expiredOffer } = await expiredRider.client.rpc('dispatch_next_candidate', {
        p_request_id: expiredRequestId,
      });
      results.push({
        name: 'setup: the expiry case really produced an offer to this driver',
        pass: !noOfferMade(expiredOffer),
        detail: 'no offer was made, so the expiry assertion below would pass vacuously',
      });

      // Exactly what cleanup_stale() does: flip the status, leave driver_id.
      await admin.from('requests').update({ status: 'expired' }).eq('id', expiredRequestId);
      const { data: expiredRow } = await admin
        .from('requests')
        .select('status, driver_id')
        .eq('id', expiredRequestId)
        .single();
      const { data: expiredRead } = await driverA.client
        .from('profiles')
        .select('full_name, phone')
        .eq('id', expiredRider.id)
        .maybeSingle();
      results.push({
        name: 'an expired request that never matched does not leak the rider profile, despite keeping driver_id',
        pass: expiredRow?.driver_id != null && expiredRead == null,
        detail: expiredRow?.driver_id == null
          ? 'driver_id was cleared, so this case never exercised the policy'
          : expiredRead
            ? `leaked ${JSON.stringify(expiredRead)}`
            : undefined,
      });

      // ---- a rider cannot browse arbitrary driver profiles ----
      const { data: riderReadsUnrelatedDriver } = await rider.client
        .from('profiles')
        .select('full_name')
        .eq('id', driverB.id)
        .maybeSingle();
      results.push({
        name: 'a rider cannot read the profile of a driver they were never matched with',
        pass: riderReadsUnrelatedDriver == null,
        detail: riderReadsUnrelatedDriver ? `leaked ${JSON.stringify(riderReadsUnrelatedDriver)}` : undefined,
      });

      // ---- admin keeps the access support depends on ----
      const adminUser = await createTestUser('user');
      createdUserIds.push(adminUser.id);
      await admin.from('profiles').update({ role: 'admin' }).eq('id', adminUser.id);
      const { data: adminReadsRider } = await adminUser.client
        .from('profiles')
        .select('full_name')
        .eq('id', rider.id)
        .maybeSingle();
      const { data: adminReadsDriver } = await adminUser.client
        .from('profiles')
        .select('full_name')
        .eq('id', driverA.id)
        .maybeSingle();
      results.push({
        name: 'an admin still reads any profile, matched or not',
        pass: adminReadsRider?.full_name != null && adminReadsDriver?.full_name != null,
        detail: 'admin lost profile access — regression',
      });

      await admin.from('requests').delete().in('id', [declinedRequestId, expiredRequestId]);
    }

    // ================================================================
    // PHASE 6 — regulated zones, companies, fleet, Smart Dispatch V2
    //
    // Everything created here is torn down at the end of the block. The
    // regulated zone in particular is ACTIVE while these assertions run, so
    // it is placed at 51.0 / -68.0 — uninhabited northern Québec, hundreds of
    // kilometres from anywhere the product is used — and deleted immediately
    // afterwards. An active test zone sitting over a real city would refuse
    // service to real people.
    // ================================================================
    {
      const ZONE_LAT = 51.0;
      const ZONE_LNG = -68.0;

      // ---- two companies, deliberately unrelated ----
      const ownerA = await createTestUser('user');
      createdUserIds.push(ownerA.id);
      const dispatcherA = await createTestUser('user');
      createdUserIds.push(dispatcherA.id);
      const driverA = await createTestUser('driver');
      createdUserIds.push(driverA.id);

      const ownerB = await createTestUser('user');
      createdUserIds.push(ownerB.id);
      const driverB = await createTestUser('driver');
      createdUserIds.push(driverB.id);

      const rider = await createTestUser('user');
      createdUserIds.push(rider.id);

      const { data: companyRows, error: companyError } = await admin
        .from('companies')
        .insert([
          { name: 'RLS Test Towing A', owner_id: ownerA.id, status: 'active', province: 'QC' },
          { name: 'RLS Test Towing B', owner_id: ownerB.id, status: 'active', province: 'QC' },
        ])
        .select('id, name');
      const companyA = companyRows?.find((c) => c.name.endsWith('A'))?.id as string;
      const companyB = companyRows?.find((c) => c.name.endsWith('B'))?.id as string;
      results.push({
        name: 'setup: two test companies exist',
        pass: Boolean(companyA && companyB),
        detail: companyError?.message,
      });

      await admin.from('company_members').insert([
        { company_id: companyA, profile_id: ownerA.id, role: 'owner', status: 'active' },
        { company_id: companyA, profile_id: dispatcherA.id, role: 'dispatcher', status: 'active' },
        { company_id: companyA, profile_id: driverA.id, role: 'driver', status: 'active' },
        { company_id: companyB, profile_id: ownerB.id, role: 'owner', status: 'active' },
        { company_id: companyB, profile_id: driverB.id, role: 'driver', status: 'active' },
      ]);

      const { data: vehicles } = await admin
        .from('fleet_vehicles')
        .insert([
          { company_id: companyA, label: 'A-flatbed', truck_type: 'flatbed', capabilities: ['flatbed'] },
          { company_id: companyB, label: 'B-flatbed', truck_type: 'flatbed', capabilities: ['flatbed'] },
        ])
        .select('id, label');
      const vehicleA = vehicles?.find((v) => v.label === 'A-flatbed')?.id as string;
      const vehicleB = vehicles?.find((v) => v.label === 'B-flatbed')?.id as string;

      await admin
        .from('driver_vehicle_assignments')
        .insert([
          { fleet_vehicle_id: vehicleA, driver_id: driverA.id, active: true },
          { fleet_vehicle_id: vehicleB, driver_id: driverB.id, active: true },
        ]);

      // ---- 1. company A never reads company B ----
      const { data: aReadsB } = await ownerA.client
        .from('companies')
        .select('id, name')
        .eq('id', companyB)
        .maybeSingle();
      results.push({
        name: "company A's owner cannot read company B",
        pass: aReadsB == null,
        detail: aReadsB ? `leaked ${JSON.stringify(aReadsB)}` : undefined,
      });

      const { data: aReadsBRoster } = await ownerA.client
        .from('company_members')
        .select('id')
        .eq('company_id', companyB);
      results.push({
        name: "company A's owner cannot read company B's roster",
        pass: (aReadsBRoster ?? []).length === 0,
        detail: `${(aReadsBRoster ?? []).length} member row(s) visible`,
      });

      // ---- 2. driver A never reads fleet B ----
      const { data: driverAReadsFleetB } = await driverA.client
        .from('fleet_vehicles')
        .select('id')
        .eq('company_id', companyB);
      results.push({
        name: "a driver cannot read another company's fleet",
        pass: (driverAReadsFleetB ?? []).length === 0,
        detail: `${(driverAReadsFleetB ?? []).length} vehicle(s) visible`,
      });

      const { data: driverAReadsOwnFleet } = await driverA.client
        .from('fleet_vehicles')
        .select('id')
        .eq('company_id', companyA);
      results.push({
        name: "a driver can read their own company's fleet",
        pass: (driverAReadsOwnFleet ?? []).length === 1,
        detail: `${(driverAReadsOwnFleet ?? []).length} vehicle(s) visible, expected 1`,
      });

      // ---- 3. a driver cannot attach themself to a foreign company ----
      const { error: selfJoinError } = await driverA.client
        .from('company_members')
        .insert({ company_id: companyB, profile_id: driverA.id, role: 'driver', status: 'active' });
      const { data: selfJoinRow } = await admin
        .from('company_members')
        .select('id')
        .eq('company_id', companyB)
        .eq('profile_id', driverA.id)
        .maybeSingle();
      results.push({
        name: 'a driver cannot add themself to another company',
        pass: Boolean(selfJoinError) && selfJoinRow == null,
        detail: selfJoinRow ? 'the membership row was created!' : undefined,
      });

      // ...nor to their own, which is equally a staffing decision.
      const { error: selfPromoteError } = await driverA.client
        .from('company_members')
        .update({ role: 'owner' })
        .eq('company_id', companyA)
        .eq('profile_id', driverA.id);
      const { data: roleAfter } = await admin
        .from('company_members')
        .select('role')
        .eq('company_id', companyA)
        .eq('profile_id', driverA.id)
        .single();
      results.push({
        name: 'a driver cannot promote themself inside their own company',
        pass: roleAfter?.role === 'driver',
        detail: selfPromoteError ? undefined : `role is now '${roleAfter?.role}'`,
      });

      // ---- a driver cannot put themself behind another company's truck ----
      const { error: selfAssignError } = await driverA.client
        .from('driver_vehicle_assignments')
        .insert({ fleet_vehicle_id: vehicleB, driver_id: driverA.id, active: true });
      const { data: selfAssignRow } = await admin
        .from('driver_vehicle_assignments')
        .select('id')
        .eq('fleet_vehicle_id', vehicleB)
        .eq('driver_id', driverA.id)
        .maybeSingle();
      results.push({
        name: "a driver cannot assign themself to another company's vehicle",
        pass: Boolean(selfAssignError) && selfAssignRow == null,
        detail: selfAssignRow ? 'the assignment row was created!' : undefined,
      });

      // Even the service role cannot create a cross-company pairing — that
      // invariant is a trigger, not a policy, precisely so it holds for
      // trusted code paths too.
      const { error: crossCompanyError } = await admin
        .from('driver_vehicle_assignments')
        .insert({ fleet_vehicle_id: vehicleB, driver_id: driverA.id, active: true });
      results.push({
        name: 'even the service role cannot pair a driver with another company truck',
        pass: Boolean(crossCompanyError),
        detail: crossCompanyError ? undefined : 'the cross-company assignment was accepted!',
      });

      // ---- 5. a customer sees no company internals ----
      const { data: riderReadsMembers } = await rider.client.from('company_members').select('id');
      const { data: riderReadsFleet } = await rider.client.from('fleet_vehicles').select('id');
      const { data: riderReadsCompanies } = await rider.client.from('companies').select('id');
      results.push({
        name: 'a customer sees no company roster, fleet or company row',
        pass:
          (riderReadsMembers ?? []).length === 0 &&
          (riderReadsFleet ?? []).length === 0 &&
          (riderReadsCompanies ?? []).length === 0,
        detail:
          `members=${(riderReadsMembers ?? []).length} fleet=${(riderReadsFleet ?? []).length} ` +
          `companies=${(riderReadsCompanies ?? []).length}`,
      });

      // ---- 6. a dispatcher sees their company and only their company ----
      const { data: dispatcherSees } = await dispatcherA.client.from('company_members').select('company_id');
      const dispatcherCompanies = new Set((dispatcherSees ?? []).map((m) => m.company_id));
      results.push({
        name: 'a dispatcher sees exactly one company roster — their own',
        pass: dispatcherCompanies.size === 1 && dispatcherCompanies.has(companyA),
        detail: `saw ${[...dispatcherCompanies].length} company/companies`,
      });

      const { data: dispatcherFleet } = await dispatcherA.client.from('fleet_vehicles').select('company_id');
      results.push({
        name: "a dispatcher sees only their own company's fleet",
        pass:
          (dispatcherFleet ?? []).length === 1 && (dispatcherFleet ?? [])[0]?.company_id === companyA,
        detail: `${(dispatcherFleet ?? []).length} vehicle(s) visible`,
      });

      // ================================================================
      // REGULATED ZONE
      // ================================================================
      const zonePolygon =
        'SRID=4326;MULTIPOLYGON(((-68.1 50.9, -67.9 50.9, -67.9 51.1, -68.1 51.1, -68.1 50.9)))';

      const { data: zoneRow, error: zoneError } = await admin
        .from('regulated_towing_zones')
        .insert({
          province: 'QC',
          jurisdiction: 'RLS integration test',
          official_name: 'RLS TEST ZONE — delete on sight',
          restriction_type: 'exclusive_operator',
          dispatch_mode: 'authorized_provider_only',
          geometry: zonePolygon,
          geometry_confidence: 'derived_from_official_text',
          source_url: 'https://example.invalid/rls-test',
          source_title: 'RLS integration test fixture',
          effective_from: '2020-01-01',
          active: true,
          user_instruction_fr: 'Zone de test.',
          user_instruction_en: 'Test zone.',
        } as never)
        .select('id')
        .single();
      const zoneId = zoneRow?.id as string;
      results.push({
        name: 'setup: an active test zone with a real geometry can be created',
        pass: Boolean(zoneId),
        detail: zoneError?.message,
      });

      // The anti-fabrication guard: no geometry, no activation. Ever.
      const { error: noGeomError } = await admin
        .from('regulated_towing_zones')
        .insert({
          province: 'QC',
          jurisdiction: 'RLS integration test',
          official_name: 'RLS TEST ZONE — no geometry',
          restriction_type: 'other',
          dispatch_mode: 'manual_instruction_only',
          source_url: 'https://example.invalid/rls-test',
          source_title: 'RLS integration test fixture',
          effective_from: '2020-01-01',
          active: true,
          user_instruction_fr: 'x',
          user_instruction_en: 'x',
        } as never);
      results.push({
        name: 'a zone with no geometry cannot be activated',
        pass: Boolean(noGeomError),
        detail: noGeomError ? undefined : 'a geometry-less zone went active!',
      });

      // Company A is the legally authorized operator here. Company B is not.
      await admin.from('regulated_zone_providers').insert({
        zone_id: zoneId,
        company_id: companyA,
        official_operator_name: 'RLS Test Towing A',
        authorization_status: 'authorized',
      });

      // ---- 4. a driver cannot edit their own regulatory authorization ----
      const { error: authWriteError } = await driverA.client
        .from('regulated_zone_providers')
        .update({ authorization_status: 'authorized', company_id: companyB })
        .eq('zone_id', zoneId);
      const { data: authAfter } = await admin
        .from('regulated_zone_providers')
        .select('company_id, authorization_status')
        .eq('zone_id', zoneId)
        .single();
      results.push({
        name: 'a driver cannot grant or move a regulated-zone authorization',
        pass: authAfter?.company_id === companyA && authAfter?.authorization_status === 'authorized',
        detail: authWriteError
          ? undefined
          : `authorization now points at ${authAfter?.company_id}`,
      });

      const { error: selfAuthorizeError } = await ownerB.client
        .from('regulated_zone_providers')
        .insert({
          zone_id: zoneId,
          company_id: companyB,
          official_operator_name: 'RLS Test Towing B',
          authorization_status: 'authorized',
        });
      const { data: bAuthRow } = await admin
        .from('regulated_zone_providers')
        .select('id')
        .eq('zone_id', zoneId)
        .eq('company_id', companyB)
        .maybeSingle();
      results.push({
        name: 'a company cannot authorize itself for a regulated zone',
        pass: Boolean(selfAuthorizeError) && bAuthRow == null,
        detail: bAuthRow ? 'company B authorized itself!' : undefined,
      });

      // ---- both drivers online, in the zone, freshly beating ----
      const nowIso = new Date().toISOString();
      await admin
        .from('driver_profiles')
        .update({
          approval_status: 'approved',
          is_online: true,
          current_lat: ZONE_LAT,
          current_lng: ZONE_LNG,
          last_heartbeat_at: nowIso,
        })
        .in('profile_id', [driverA.id, driverB.id]);

      // 'accident' requires any of flatbed / heavy_duty / recovery. Both
      // drivers sit on a flatbed, so at this point both are COMPATIBLE and
      // only authorization separates them.
      const { data: zoneRequest, error: zoneRequestError } = await rider.client
        .from('requests')
        .insert({
          user_id: rider.id,
          problem_type: 'accident',
          location_text: 'RLS test — inside regulated zone',
          lat: ZONE_LAT,
          lng: ZONE_LNG,
          price_estimate: 120,
        })
        .select('id, regulated_zone_id, regulated_dispatch_state')
        .single();
      const zoneRequestId = zoneRequest?.id as string;

      results.push({
        name: 'a request inside a regulated zone is stamped with that zone on insert',
        pass: zoneRequest?.regulated_zone_id === zoneId,
        detail: zoneRequestError?.message ?? `stamped ${zoneRequest?.regulated_zone_id}`,
      });

      const candidates = async (id: string) => {
        const { data } = await admin.rpc('dispatch_candidates' as never, {
          p_request_id: id,
          p_radius_km: 40,
        } as never);
        return (data ?? []) as {
          driver_id: string;
          eligible: boolean;
          exclusion_reason: string | null;
          zone_authorized: boolean;
          service_compatibility: string;
        }[];
      };

      let rows = await candidates(zoneRequestId);
      const rowA = rows.find((r) => r.driver_id === driverA.id);
      const rowB = rows.find((r) => r.driver_id === driverB.id);

      results.push({
        name: 'setup: both test drivers are actually candidates for the zone request',
        pass: Boolean(rowA && rowB),
        detail: `saw ${rows.length} candidate(s) — the assertions below would pass vacuously`,
      });

      // ---- 10. authorized AND compatible → eligible ----
      results.push({
        name: 'an authorized, compatible driver is eligible in a regulated zone',
        pass: rowA?.eligible === true && rowA?.zone_authorized === true,
        detail: `eligible=${rowA?.eligible} authorized=${rowA?.zone_authorized} reason=${rowA?.exclusion_reason}`,
      });

      // ---- 8. compatible but NOT authorized → excluded ----
      results.push({
        name: 'a compatible but unauthorized driver is excluded from a regulated zone',
        pass:
          rowB?.eligible === false &&
          rowB?.zone_authorized === false &&
          rowB?.exclusion_reason === 'regulated_zone_not_authorized',
        detail: `eligible=${rowB?.eligible} reason=${rowB?.exclusion_reason} compat=${rowB?.service_compatibility}`,
      });

      // ---- 11. a commercial preference never overrides the law ----
      await admin.from('dispatch_partner_preferences').insert({
        company_id: companyB,
        head_start_seconds: 60,
        active: true,
      } as never);

      rows = await candidates(zoneRequestId);
      const rowBPreferred = rows.find((r) => r.driver_id === driverB.id);
      results.push({
        name: 'a preferred partner is still excluded when it is not authorized for the zone',
        pass:
          rowBPreferred?.eligible === false &&
          rowBPreferred?.exclusion_reason === 'regulated_zone_not_authorized',
        detail: `eligible=${rowBPreferred?.eligible} reason=${rowBPreferred?.exclusion_reason}`,
      });

      // And dispatch itself must not hand the job to the preferred partner.
      const { data: offer } = await admin.rpc('dispatch_next_candidate', {
        p_request_id: zoneRequestId,
      });
      results.push({
        name: 'dispatch offers the regulated zone job to the authorized driver, not the preferred one',
        pass: (offer as { driver_id?: string } | null)?.driver_id === driverA.id,
        detail: `offered to ${(offer as { driver_id?: string } | null)?.driver_id ?? 'nobody'}`,
      });

      // ---- 9. authorized but INCOMPATIBLE → excluded ----
      // Same driver, same zone, same authorization — only the truck changes.
      await admin.from('driver_vehicle_assignments').update({ active: false }).eq('driver_id', driverA.id);
      await admin.from('fleet_vehicles').update({ capabilities: ['boost'] }).eq('id', vehicleA);
      await admin
        .from('driver_vehicle_assignments')
        .insert({ fleet_vehicle_id: vehicleA, driver_id: driverA.id, active: true });

      const { data: incompatRequest } = await rider.client
        .from('requests')
        .insert({
          user_id: rider.id,
          problem_type: 'accident',
          location_text: 'RLS test — authorized but wrong truck',
          lat: ZONE_LAT,
          lng: ZONE_LNG,
          price_estimate: 120,
        })
        .select('id')
        .single();
      const incompatRequestId = incompatRequest?.id as string;

      const incompatRows = await candidates(incompatRequestId);
      const incompatA = incompatRows.find((r) => r.driver_id === driverA.id);
      results.push({
        name: 'an authorized driver with the wrong equipment is excluded',
        pass:
          incompatA?.zone_authorized === true &&
          incompatA?.service_compatibility === 'incompatible' &&
          incompatA?.eligible === false &&
          incompatA?.exclusion_reason === 'service_not_compatible',
        detail: `authorized=${incompatA?.zone_authorized} compat=${incompatA?.service_compatibility} reason=${incompatA?.exclusion_reason}`,
      });

      // ---- 7. a zone that bars dispatch entirely produces no offer ----
      await admin
        .from('regulated_towing_zones')
        .update({ dispatch_mode: 'external_authority_required' })
        .eq('id', zoneId);

      const { data: authorityRequest } = await rider.client
        .from('requests')
        .insert({
          user_id: rider.id,
          problem_type: 'accident',
          location_text: 'RLS test — external authority zone',
          lat: ZONE_LAT,
          lng: ZONE_LNG,
          price_estimate: 120,
        })
        .select('id, regulated_dispatch_state')
        .single();
      const authorityRequestId = authorityRequest?.id as string;

      results.push({
        name: 'a request in an external-authority zone is marked awaiting_external_authority on insert',
        pass: authorityRequest?.regulated_dispatch_state === 'awaiting_external_authority',
        detail: `state=${authorityRequest?.regulated_dispatch_state}`,
      });

      const { data: authorityOffer } = await admin.rpc('dispatch_next_candidate', {
        p_request_id: authorityRequestId,
      });
      const { data: authorityAfter } = await admin
        .from('requests')
        .select('driver_id, regulated_dispatch_state')
        .eq('id', authorityRequestId)
        .single();
      // A composite-returning Postgres function hands back a row of NULLs,
      // not SQL NULL, when it returns nothing — so `id` is what says "no
      // offer was made", not the row being absent. driver_id staying null is
      // the independent confirmation.
      const authorityOfferId = (authorityOffer as { id?: string | null } | null)?.id ?? null;
      results.push({
        name: 'dispatch never offers a job inside an external-authority zone',
        pass: authorityOfferId == null && authorityAfter?.driver_id == null,
        detail: `offer_id=${authorityOfferId} driver=${authorityAfter?.driver_id}`,
      });

      // ---- outside the zone, nothing changes ----
      const { data: outsideRequest } = await rider.client
        .from('requests')
        .insert({
          user_id: rider.id,
          problem_type: 'accident',
          location_text: 'RLS test — outside every zone',
          lat: 48.0,
          lng: -71.0,
          price_estimate: 120,
        })
        .select('id, regulated_zone_id, regulated_dispatch_state')
        .single();
      results.push({
        name: 'a request outside every regulated zone is untouched by the zone engine',
        pass:
          outsideRequest?.regulated_zone_id == null &&
          outsideRequest?.regulated_dispatch_state === 'not_applicable',
        detail: `zone=${outsideRequest?.regulated_zone_id} state=${outsideRequest?.regulated_dispatch_state}`,
      });

      // ---- document compliance blocks dispatch when configured ----
      await admin
        .from('regulated_towing_zones')
        .update({ dispatch_mode: 'authorized_provider_only' })
        .eq('id', zoneId);
      await admin.from('fleet_vehicles').update({ capabilities: ['flatbed'] }).eq('id', vehicleA);
      await admin
        .from('driver_profiles')
        .update({ province: 'ZZ' })
        .eq('profile_id', driverA.id);

      const { data: requirementRow } = await admin
        .from('document_requirements')
        .insert({
          province: 'ZZ',
          document_type: 'insurance',
          required: true,
          blocks_online: true,
          blocks_dispatch: true,
          active: true,
          notes: 'RLS integration test fixture',
        } as never)
        .select('id')
        .single();

      const { data: blockedFlag } = await admin.rpc('driver_dispatch_blocked' as never, {
        p_driver_id: driverA.id,
      } as never);
      results.push({
        name: 'a required document that is missing blocks dispatch',
        pass: blockedFlag === true,
        detail: `driver_dispatch_blocked=${blockedFlag}`,
      });

      const { data: complianceRequest } = await rider.client
        .from('requests')
        .insert({
          user_id: rider.id,
          problem_type: 'accident',
          location_text: 'RLS test — compliance block',
          lat: ZONE_LAT,
          lng: ZONE_LNG,
          price_estimate: 120,
        })
        .select('id')
        .single();
      const complianceRows = await candidates(complianceRequest?.id as string);
      const complianceA = complianceRows.find((r) => r.driver_id === driverA.id);
      results.push({
        name: 'a driver whose mandatory documents are missing is excluded from dispatch',
        pass: complianceA?.eligible === false && complianceA?.exclusion_reason === 'documents_not_in_good_standing',
        detail: `eligible=${complianceA?.eligible} reason=${complianceA?.exclusion_reason}`,
      });

      // Going online is refused too, server-side.
      await admin.from('driver_profiles').update({ is_online: false }).eq('profile_id', driverA.id);
      const { error: onlineError } = await driverA.client
        .from('driver_profiles')
        .update({ is_online: true })
        .eq('profile_id', driverA.id);
      const { data: onlineAfter } = await admin
        .from('driver_profiles')
        .select('is_online')
        .eq('profile_id', driverA.id)
        .single();
      results.push({
        name: 'a non-compliant driver cannot go online',
        pass: Boolean(onlineError) && onlineAfter?.is_online === false,
        detail: onlineError ? undefined : `is_online is now ${onlineAfter?.is_online}`,
      });

      // ---- supplements: only the customer approves ----
      const { data: suppRequest } = await rider.client
        .from('requests')
        .insert({
          user_id: rider.id,
          problem_type: 'mechanical',
          location_text: 'RLS test — supplements',
          lat: 48.0,
          lng: -71.0,
          price_estimate: 100,
        })
        .select('id')
        .single();
      const suppRequestId = suppRequest?.id as string;
      await admin
        .from('requests')
        .update({ driver_id: driverB.id, status: 'matched' })
        .eq('id', suppRequestId);

      const { data: supplementRow, error: supplementError } = await driverB.client
        .from('request_supplements')
        .insert({
          request_id: suppRequestId,
          type_key: 'winch',
          amount: 45,
          proposed_by: driverB.id,
          status: 'proposed',
        })
        .select('id')
        .single();
      results.push({
        name: 'the assigned driver can propose a supplement',
        pass: Boolean(supplementRow?.id),
        detail: supplementError?.message,
      });

      const supplementId = supplementRow?.id as string;
      const { error: selfApproveError } = await driverB.client
        .from('request_supplements')
        .update({ status: 'approved' })
        .eq('id', supplementId);
      const { data: supplementAfterSelf } = await admin
        .from('request_supplements')
        .select('status')
        .eq('id', supplementId)
        .single();
      results.push({
        name: 'a driver cannot approve their own supplement',
        pass: supplementAfterSelf?.status === 'proposed',
        detail: selfApproveError ? undefined : `status is now '${supplementAfterSelf?.status}'`,
      });

      const { error: strangerApproveError } = await ownerB.client
        .from('request_supplements')
        .update({ status: 'approved' })
        .eq('id', supplementId);
      const { data: supplementAfterStranger } = await admin
        .from('request_supplements')
        .select('status')
        .eq('id', supplementId)
        .single();
      results.push({
        name: 'a third party cannot approve someone else’s supplement',
        pass: supplementAfterStranger?.status === 'proposed',
        detail: strangerApproveError ? undefined : `status is now '${supplementAfterStranger?.status}'`,
      });

      const { error: riderApproveError } = await rider.client
        .from('request_supplements')
        .update({ status: 'approved' })
        .eq('id', supplementId);
      const { data: supplementApproved } = await admin
        .from('request_supplements')
        .select('status')
        .eq('id', supplementId)
        .single();
      results.push({
        name: 'the customer can approve a supplement',
        pass: supplementApproved?.status === 'approved',
        detail: riderApproveError?.message,
      });

      const { error: mutateApprovedError } = await driverB.client
        .from('request_supplements')
        .update({ amount: 500 })
        .eq('id', supplementId);
      const { data: supplementAmount } = await admin
        .from('request_supplements')
        .select('amount')
        .eq('id', supplementId)
        .single();
      results.push({
        name: 'an approved supplement cannot be changed afterwards',
        pass: Number(supplementAmount?.amount) === 45,
        detail: mutateApprovedError ? undefined : `amount is now ${supplementAmount?.amount}`,
      });

      // ---- pricing: nothing is invented ----
      const { data: pricingConfigured } = await admin.rpc('pricing_configured' as never, {} as never);
      results.push({
        name: 'no commission rate is configured, and the platform says so',
        pass: pricingConfigured === false,
        detail: `pricing_configured=${pricingConfigured}`,
      });

      const { data: compensation } = await driverB.client.rpc('request_provider_compensation' as never, {
        p_request_id: suppRequestId,
      } as never);
      results.push({
        name: 'partner compensation is null while no rate exists — never a fabricated number',
        pass: compensation == null,
        detail: `returned ${JSON.stringify(compensation)}`,
      });

      const { data: outsiderCompensation, error: outsiderCompError } = await ownerA.client.rpc(
        'request_provider_compensation' as never,
        { p_request_id: suppRequestId } as never
      );
      results.push({
        name: "a third party cannot read a request's economics",
        pass: Boolean(outsiderCompError) || outsiderCompensation == null,
        detail: `returned ${JSON.stringify(outsiderCompensation)}`,
      });

      // ---- the audit trail cannot be erased ----
      const { data: auditBefore } = await admin
        .from('regulated_zone_audit' as never)
        .select('id')
        .eq('row_id', zoneId);
      const adminUser2 = await createTestUser('user');
      createdUserIds.push(adminUser2.id);
      await admin.from('profiles').update({ role: 'admin' }).eq('id', adminUser2.id);
      const { error: auditDeleteError } = await adminUser2.client
        .from('regulated_zone_audit' as never)
        .delete()
        .eq('row_id', zoneId);
      const { data: auditAfter } = await admin
        .from('regulated_zone_audit' as never)
        .select('id')
        .eq('row_id', zoneId);
      results.push({
        name: 'not even an admin can delete a regulated-zone audit entry',
        pass: (auditAfter ?? []).length === (auditBefore ?? []).length && (auditBefore ?? []).length > 0,
        detail: auditDeleteError
          ? undefined
          : `audit rows went from ${(auditBefore ?? []).length} to ${(auditAfter ?? []).length}`,
      });

      // ---- explain view is admin-only ----
      const { error: explainDeniedError } = await driverA.client.rpc('explain_dispatch_candidates', {
        p_request_id: zoneRequestId,
      });
      results.push({
        name: 'a driver cannot read the dispatch explain view',
        pass: Boolean(explainDeniedError),
        detail: explainDeniedError ? undefined : 'the explain view was readable by a driver!',
      });

      // ================================================================
      // TEARDOWN — the active test zone must not outlive this run.
      // ================================================================
      await admin.from('requests').delete().eq('user_id', rider.id);
      if (requirementRow?.id) {
        await admin.from('document_requirements').delete().eq('id', requirementRow.id);
      }
      await admin.from('dispatch_partner_preferences').delete().eq('company_id', companyB);
      await admin.from('regulated_zone_providers').delete().eq('zone_id', zoneId);
      await admin.from('regulated_towing_zones').delete().eq('id', zoneId);
      await admin
        .from('regulated_towing_zones')
        .delete()
        .eq('official_name', 'RLS TEST ZONE — no geometry');
      await admin.from('driver_vehicle_assignments').delete().in('fleet_vehicle_id', [vehicleA, vehicleB]);
      await admin.from('fleet_vehicles').delete().in('id', [vehicleA, vehicleB]);
      await admin.from('company_members').delete().in('company_id', [companyA, companyB]);
      await admin.from('companies').delete().in('id', [companyA, companyB]);

      const { data: leftoverZones } = await admin
        .from('regulated_towing_zones')
        .select('id')
        .eq('jurisdiction', 'RLS integration test');
      results.push({
        name: 'teardown: no test zone is left active in the database',
        pass: (leftoverZones ?? []).length === 0,
        detail: `${(leftoverZones ?? []).length} test zone(s) still present`,
      });
    }

    // ================================================================
    // PHASE 6.1 — real regulated geometry, dispatcher visibility, and a
    // driver history that reflects jobs actually taken.
    //
    // Unlike the Phase 6 block, this one creates NO zone: the fifteen Ontario
    // zones are live production data now, so these assertions run against the
    // real boundaries. Every coordinate below was checked against
    // regulated_zone_for_point() on the live project before being written
    // down, and each is the midpoint of the zone's own derived centreline.
    // ================================================================
    {
      // Verified live: each of these resolves to the zone named beside it.
      const IN_ZONE_1A = { lat: 43.72478, lng: -79.47223 };
      const IN_ZONE_2A = { lat: 43.62594, lng: -79.69393 };
      const MONTREAL = { lat: 45.5019, lng: -73.5674 };
      const LONGUEUIL = { lat: 45.5312, lng: -73.5182 };

      const rider = await createTestUser('user');
      createdUserIds.push(rider.id);

      // ---- the derived Ontario geometry is live and detects ----
      const { data: onRequest, error: onError } = await rider.client
        .from('requests')
        .select('id, regulated_zone_id, regulated_zone_mode, regulated_dispatch_state')
        .limit(0);
      void onRequest;
      void onError;

      const stamp = async (point: { lat: number; lng: number }, label: string) => {
        const { data } = await rider.client
          .from('requests')
          .insert({
            user_id: rider.id,
            problem_type: 'battery',
            location_text: `Phase 6.1 test — ${label}`,
            lat: point.lat,
            lng: point.lng,
            price_estimate: 60,
          })
          .select('id, regulated_zone_id, regulated_zone_mode, regulated_dispatch_state')
          .single();
        return data;
      };

      const inZone = await stamp(IN_ZONE_1A, 'Highway 401 inside zone 1A');
      results.push({
        name: 'a request on Highway 401 is stamped with a live Ontario zone',
        pass: Boolean(inZone?.regulated_zone_id),
        detail: `zone=${inZone?.regulated_zone_id ?? 'none'}`,
      });
      results.push({
        name: 'that zone routes the motorist to the public authority rather than to dispatch',
        pass:
          inZone?.regulated_zone_mode === 'external_authority_required' &&
          inZone?.regulated_dispatch_state === 'awaiting_external_authority',
        detail: `mode=${inZone?.regulated_zone_mode} state=${inZone?.regulated_dispatch_state}`,
      });

      const inZone2 = await stamp(IN_ZONE_2A, 'Highway 401 inside zone 2A');
      results.push({
        name: 'a second, separate stretch of Highway 401 resolves to its own zone',
        pass:
          Boolean(inZone2?.regulated_zone_id) &&
          inZone2?.regulated_zone_id !== inZone?.regulated_zone_id,
        detail: `zone=${inZone2?.regulated_zone_id ?? 'none'}`,
      });

      // The launch area must be completely unaffected: this is the false
      // positive that would matter most, because it is where the customers are.
      for (const [label, point] of [
        ['downtown Montréal', MONTREAL],
        ['Longueuil, Rive-Sud', LONGUEUIL],
      ] as const) {
        const out = await stamp(point, label);
        results.push({
          name: `${label} is outside every regulated zone`,
          pass: out?.regulated_zone_id === null && out?.regulated_dispatch_state === 'not_applicable',
          detail: `zone=${out?.regulated_zone_id} state=${out?.regulated_dispatch_state}`,
        });
      }

      // Dispatch must refuse to offer inside the live Ontario geometry.
      const onDriver = await createTestUser('driver');
      createdUserIds.push(onDriver.id);
      await admin
        .from('driver_profiles')
        .update({
          approval_status: 'approved',
          is_online: true,
          province: 'QC',
          current_lat: IN_ZONE_1A.lat,
          current_lng: IN_ZONE_1A.lng,
          last_heartbeat_at: new Date().toISOString(),
        })
        .eq('profile_id', onDriver.id);

      const { data: onOffer } = await admin.rpc('dispatch_next_candidate', {
        p_request_id: inZone!.id,
      });
      const { data: onAfter } = await admin
        .from('requests')
        .select('driver_id')
        .eq('id', inZone!.id)
        .single();
      results.push({
        name: 'dispatch makes no offer inside a live Ontario restricted zone, even with a driver on top of it',
        pass: (onOffer as { id?: string | null } | null)?.id == null && onAfter?.driver_id == null,
        detail: `driver=${onAfter?.driver_id}`,
      });

      // ---- dispatcher visibility (0030) ----
      const ownerA = await createTestUser('user');
      createdUserIds.push(ownerA.id);
      const dispatcherA = await createTestUser('user');
      createdUserIds.push(dispatcherA.id);
      const driverA = await createTestUser('driver');
      createdUserIds.push(driverA.id);
      const ownerB = await createTestUser('user');
      createdUserIds.push(ownerB.id);
      const dispatcherB = await createTestUser('user');
      createdUserIds.push(dispatcherB.id);
      const driverB = await createTestUser('driver');
      createdUserIds.push(driverB.id);

      const { data: coRows } = await admin
        .from('companies')
        .insert([
          { name: 'RLS 6.1 Towing A', owner_id: ownerA.id, status: 'active', province: 'QC' },
          { name: 'RLS 6.1 Towing B', owner_id: ownerB.id, status: 'active', province: 'QC' },
        ])
        .select('id, name');
      const coA = coRows?.find((c) => c.name.endsWith('A'))?.id as string;
      const coB = coRows?.find((c) => c.name.endsWith('B'))?.id as string;

      await admin.from('company_members').insert([
        { company_id: coA, profile_id: ownerA.id, role: 'owner', status: 'active' },
        { company_id: coA, profile_id: dispatcherA.id, role: 'dispatcher', status: 'active' },
        { company_id: coA, profile_id: driverA.id, role: 'driver', status: 'active' },
        { company_id: coB, profile_id: ownerB.id, role: 'owner', status: 'active' },
        { company_id: coB, profile_id: dispatcherB.id, role: 'dispatcher', status: 'active' },
        { company_id: coB, profile_id: driverB.id, role: 'driver', status: 'active' },
      ]);

      const makeJob = async (driverId: string, label: string) => {
        const { data } = await rider.client
          .from('requests')
          .insert({
            user_id: rider.id,
            problem_type: 'battery',
            location_text: `Phase 6.1 — ${label}`,
            lat: MONTREAL.lat,
            lng: MONTREAL.lng,
            price_estimate: 70,
          })
          .select('id')
          .single();
        await admin
          .from('requests')
          .update({ driver_id: driverId, status: 'matched' })
          .eq('id', data!.id);
        return data!.id as string;
      };

      const jobA = await makeJob(driverA.id, "company A's job");
      const jobB = await makeJob(driverB.id, "company B's job");

      const { data: dispASeesA } = await dispatcherA.client
        .from('requests')
        .select('id')
        .eq('id', jobA)
        .maybeSingle();
      results.push({
        name: "a dispatcher can read a job assigned to their own company's driver",
        pass: dispASeesA?.id === jobA,
        detail: dispASeesA ? undefined : 'the dispatcher still sees nothing — 0030 not applied?',
      });

      const { data: dispASeesB } = await dispatcherA.client
        .from('requests')
        .select('id')
        .eq('id', jobB)
        .maybeSingle();
      results.push({
        name: "a dispatcher cannot read another company's job",
        pass: dispASeesB == null,
        detail: dispASeesB ? 'cross-company job was visible!' : undefined,
      });

      const { data: dispBSeesA } = await dispatcherB.client
        .from('requests')
        .select('id')
        .eq('id', jobA)
        .maybeSingle();
      results.push({
        name: 'the invariant holds in the other direction too',
        pass: dispBSeesA == null,
        detail: dispBSeesA ? 'cross-company job was visible!' : undefined,
      });

      // The widening is deliberately narrow: a dispatcher sees the job, not
      // the customer. Phase 5.1's profiles rule is untouched.
      const { data: dispASeesRider } = await dispatcherA.client
        .from('profiles')
        .select('full_name, phone')
        .eq('id', rider.id)
        .maybeSingle();
      results.push({
        name: "a dispatcher still cannot read the customer's profile",
        pass: dispASeesRider == null,
        detail: dispASeesRider ? `leaked ${JSON.stringify(dispASeesRider)}` : undefined,
      });

      // And a plain driver is not a manager: no company-wide visibility.
      const { data: driverASeesB } = await driverA.client
        .from('requests')
        .select('id')
        .eq('id', jobB)
        .maybeSingle();
      results.push({
        name: "a driver does not gain company-wide visibility from another company's job",
        pass: driverASeesB == null,
        detail: driverASeesB ? 'visible!' : undefined,
      });

      // ---- driver history reflects jobs actually taken ----
      // Two requests for the same driver: one cancelled while it was only ever
      // an offer, one cancelled after being accepted. Only the second is
      // history. driver_id is identical on both, which is exactly why
      // filtering on driver_id alone was wrong.
      const { data: offeredOnly } = await rider.client
        .from('requests')
        .insert({
          user_id: rider.id,
          problem_type: 'battery',
          location_text: 'Phase 6.1 — cancelled while only offered',
          lat: MONTREAL.lat,
          lng: MONTREAL.lng,
          price_estimate: 55,
        })
        .select('id')
        .single();
      // Exactly what dispatch does when it makes an offer: set driver_id while
      // the request is still 'pending'. Then the rider cancels.
      await admin.from('requests').update({ driver_id: driverA.id }).eq('id', offeredOnly!.id);
      await admin.from('requests').update({ status: 'cancelled' }).eq('id', offeredOnly!.id);

      // requests_one_active_job_per_driver (0002) allows a driver only one
      // request in matched/en_route/arrived/in_progress at a time, so jobA has
      // to be closed out before this driver can accept another. Without this,
      // the second acceptance silently did nothing and the assertion below
      // failed for a reason that had nothing to do with history.
      await admin.from('requests').update({ status: 'completed' }).eq('id', jobA);

      const acceptedThenCancelled = await makeJob(driverA.id, 'accepted then cancelled');
      await admin.from('requests').update({ status: 'cancelled' }).eq('id', acceptedThenCancelled);

      const { data: history } = await driverA.client
        .from('requests')
        .select('id, request_events!inner(status)')
        .eq('driver_id', driverA.id)
        .eq('request_events.status', 'matched')
        .in('status', ['completed', 'cancelled']);
      const historyIds = (history ?? []).map((r) => r.id);

      // Not a formality: if the two rows did not both carry this driver's id,
      // the two assertions below would be comparing nothing to nothing.
      const { data: bothRows } = await admin
        .from('requests')
        .select('id, driver_id, status')
        .in('id', [offeredOnly!.id, acceptedThenCancelled]);
      results.push({
        name: 'setup: both requests carry the same driver_id and are cancelled, so the test is not vacuous',
        pass:
          (bothRows ?? []).length === 2 &&
          (bothRows ?? []).every((r) => r.driver_id === driverA.id && r.status === 'cancelled'),
        detail: JSON.stringify(bothRows),
      });
      results.push({
        name: 'a request cancelled while it was only an offer stays out of driver history',
        pass: !historyIds.includes(offeredOnly!.id),
        detail: 'an offer the driver never accepted is in their history',
      });
      results.push({
        name: 'a request accepted and then cancelled remains in driver history',
        pass: historyIds.includes(acceptedThenCancelled),
        detail: 'a job the driver actually took disappeared from their history',
      });

      // ---- Ontario document requirements ----
      const { data: onReq } = await admin
        .from('document_requirements')
        .select('document_type, required, blocks_online, blocks_dispatch, source_url')
        .eq('province', 'ON');
      results.push({
        name: 'Ontario document requirements are seeded from an official source',
        pass:
          (onReq ?? []).length === 2 &&
          (onReq ?? []).every((r) => r.required && r.blocks_online && r.blocks_dispatch) &&
          (onReq ?? []).every((r) => (r.source_url ?? '').startsWith('https://www.ontario.ca/')),
        detail: JSON.stringify(onReq),
      });

      const { data: qcReq } = await admin
        .from('document_requirements')
        .select('id')
        .eq('province', 'QC');
      results.push({
        name: 'no Quebec document requirement is invented',
        pass: (qcReq ?? []).length === 0,
        detail: `${(qcReq ?? []).length} Quebec rule(s) present without a verified source`,
      });

      // A Quebec driver is unaffected by the Ontario rules; an Ontario driver
      // with nothing on file is blocked. Same driver, one column changed.
      await admin.from('driver_profiles').update({ province: 'QC' }).eq('profile_id', driverA.id);
      const { data: qcBlocked } = await admin.rpc('driver_dispatch_blocked' as never, {
        p_driver_id: driverA.id,
      } as never);
      await admin.from('driver_profiles').update({ province: 'ON' }).eq('profile_id', driverA.id);
      const { data: onBlocked } = await admin.rpc('driver_dispatch_blocked' as never, {
        p_driver_id: driverA.id,
      } as never);
      await admin.from('driver_profiles').update({ province: 'QC' }).eq('profile_id', driverA.id);

      results.push({
        name: 'a Quebec driver is not gated by the Ontario rules',
        pass: qcBlocked === false,
        detail: `blocked=${qcBlocked}`,
      });
      results.push({
        name: 'an Ontario driver with no certificate on file is blocked from dispatch',
        pass: onBlocked === true,
        detail: `blocked=${onBlocked}`,
      });

      // ---- the geometry inspector is admin-only ----
      const { data: zoneRow } = await admin
        .from('regulated_towing_zones')
        .select('id')
        .eq('province', 'ON')
        .eq('zone_code', '1A')
        .single();
      const { data: driverGeo } = await driverA.client.rpc('regulated_zone_geojson' as never, {
        p_zone_id: zoneRow!.id,
      } as never);
      results.push({
        name: 'an active zone boundary is readable (it is published law)',
        pass: driverGeo != null,
        detail: 'an active zone geometry was not readable',
      });

      const { data: retired } = await admin
        .from('regulated_towing_zones')
        .select('id')
        .eq('province', 'QC')
        .maybeSingle();
      const { data: inactiveGeo } = await driverA.client.rpc('regulated_zone_geojson' as never, {
        p_zone_id: retired!.id,
      } as never);
      results.push({
        name: 'an inactive zone boundary is not exposed to a non-admin',
        pass: inactiveGeo == null,
        detail: 'an unactivated boundary leaked to a driver',
      });

      // ================================================================
      // Phase 7 — money. Eight invariants, all about the same idea: nobody
      // can move, edit or read money that is not theirs, and the protection
      // is structural rather than a hidden button.
      // ================================================================

      // A real ledger entry to test against, written the only way one can be
      // written: trusted server code through the service role.
      const { data: ledgerRow, error: ledgerInsertError } = await admin
        .from('provider_ledger_entries')
        .insert({
          company_id: coA,
          driver_id: driverA.id,
          request_id: jobA,
          entry_type: 'earning',
          amount: 40,
          available_at: new Date().toISOString(),
          description: 'Phase 7 RLS fixture',
        })
        .select('id')
        .single();
      results.push({
        name: 'setup: the service role can write a ledger entry',
        pass: !ledgerInsertError && ledgerRow?.id != null,
        detail: ledgerInsertError?.message,
      });

      // 1. Another company's driver must not see it.
      const { data: crossLedger } = await driverB.client
        .from('provider_ledger_entries')
        .select('id')
        .eq('id', ledgerRow!.id)
        .maybeSingle();
      results.push({
        name: "a driver cannot read another company's ledger entries",
        pass: crossLedger == null,
        detail: "company B's driver read company A's ledger",
      });

      // 2. Nor may another company's OWNER, who can read their own book.
      const { data: crossOwnerLedger } = await ownerB.client
        .from('provider_ledger_entries')
        .select('id')
        .eq('id', ledgerRow!.id)
        .maybeSingle();
      const { data: ownLedger } = await ownerA.client
        .from('provider_ledger_entries')
        .select('id')
        .eq('id', ledgerRow!.id)
        .maybeSingle();
      results.push({
        name: "a company owner reads their own ledger and not another company's",
        pass: crossOwnerLedger == null && ownLedger?.id === ledgerRow!.id,
        detail: crossOwnerLedger != null ? "company B's owner read company A's ledger" : 'own ledger was not readable',
      });

      // 3. A company cannot credit itself. There is no INSERT policy at all.
      const { error: selfCreditError } = await ownerA.client
        .from('provider_ledger_entries')
        .insert({
          company_id: coA,
          entry_type: 'earning',
          amount: 9999,
          available_at: new Date().toISOString(),
        } as never);
      results.push({
        name: 'a company owner cannot write their own ledger entry',
        pass: Boolean(selfCreditError),
        detail: 'a company credited itself',
      });

      // 4. The ledger is append-only even for the service role: a correction
      //    is a new entry, never an edit of an old one.
      const { error: ledgerUpdateError } = await admin
        .from('provider_ledger_entries')
        .update({ amount: 1 } as never)
        .eq('id', ledgerRow!.id);
      results.push({
        name: 'a ledger entry cannot be updated, even by the service role',
        pass: Boolean(ledgerUpdateError),
        detail: 'a ledger entry was edited after the fact',
      });

      // 5. Balances are SECURITY DEFINER, so the table's RLS does not protect
      //    them — the function has to say who may ask (0038).
      const { error: crossBalanceError } = await ownerB.client.rpc('provider_balances' as never, {
        p_company_id: coA,
      } as never);
      const { data: ownBalance, error: ownBalanceError } = await ownerA.client.rpc(
        'provider_balances' as never,
        { p_company_id: coA } as never
      );
      results.push({
        name: "a company owner cannot read another company's balances",
        pass: Boolean(crossBalanceError) && !ownBalanceError && ownBalance != null,
        detail: crossBalanceError
          ? 'own balances were not readable'
          : "company B's owner read company A's balances",
      });

      // 6. The economics themselves are admin-only. A driver setting the
      //    commission would be setting their own pay.
      const { error: driverPricingError } = await driverA.client
        .from('pricing_configs')
        .insert({ version: 9999, label: 'RLS attempt', status: 'draft', commission_percent: 1 } as never);
      results.push({
        name: 'a driver cannot create a pricing configuration',
        pass: Boolean(driverPricingError),
        detail: 'a driver wrote the platform economics',
      });

      // 7. A refund moves a customer's money. Only a platform admin, and the
      //    absence of an INSERT policy is what makes that structural.
      const { error: riderRefundError } = await rider.client.from('refunds').insert({
        request_id: jobA,
        amount: 10,
        reason: 'RLS attempt',
        created_by: rider.id,
      } as never);
      const { error: driverRefundError } = await driverA.client.from('refunds').insert({
        request_id: jobA,
        amount: 10,
        reason: 'RLS attempt',
        created_by: driverA.id,
      } as never);
      results.push({
        name: 'neither a customer nor a driver can issue a refund',
        pass: Boolean(riderRefundError) && Boolean(driverRefundError),
        detail: 'a refund was created from a browser session',
      });

      // 8. Connect flags are Stripe's answers, not a company's claim. A
      //    company that could set its own payouts_enabled would not need to
      //    onboard at all (0034 trigger).
      const { error: connectSelfWrite } = await ownerA.client
        .from('companies')
        .update({ connect_payouts_enabled: true, connect_status: 'enabled' } as never)
        .eq('id', coA);
      const { data: connectAfter } = await admin
        .from('companies')
        .select('connect_payouts_enabled')
        .eq('id', coA)
        .single();
      results.push({
        name: 'a company cannot enable its own Stripe payouts',
        pass: Boolean(connectSelfWrite) || connectAfter?.connect_payouts_enabled === false,
        detail: 'a company marked its own payouts enabled',
      });

      // 9. An approved supplement's payment state says whether the money was
      //    secured. A driver who could set it to 'settled' would be crediting
      //    their own ledger (0037 trigger).
      const { data: supplementRow } = await admin
        .from('request_supplements')
        .insert({
          request_id: jobA,
          type_key: 'winch',
          amount: 25,
          status: 'proposed',
          proposed_by: driverA.id,
        } as never)
        .select('id')
        .single();

      if (supplementRow?.id) {
        const { error: supplementStateError } = await driverA.client
          .from('request_supplements')
          .update({ payment_state: 'settled' } as never)
          .eq('id', supplementRow.id);
        const { data: supplementAfter } = await admin
          .from('request_supplements')
          .select('payment_state')
          .eq('id', supplementRow.id)
          .single();
        results.push({
          name: "a driver cannot mark a supplement's payment as settled",
          pass: Boolean(supplementStateError) || supplementAfter?.payment_state === 'pending',
          detail: 'a driver settled their own supplement',
        });
      } else {
        results.push({
          name: "a driver cannot mark a supplement's payment as settled",
          pass: false,
          detail: 'the supplement fixture could not be created',
        });
      }

      // 10. The economic snapshot on a request is the platform's record of
      //     what was agreed. The assigned driver may still only move status.
      const { error: snapshotWriteError } = await driverA.client
        .from('requests')
        .update({ partner_amount: 999, economics_frozen_at: new Date().toISOString() } as never)
        .eq('id', jobA);
      const { data: snapshotAfter } = await admin
        .from('requests')
        .select('partner_amount')
        .eq('id', jobA)
        .single();
      results.push({
        name: 'a driver cannot write their own frozen compensation',
        pass: Boolean(snapshotWriteError) || snapshotAfter?.partner_amount == null,
        detail: 'a driver set their own pay on a request',
      });

      await admin.from('request_supplements').delete().eq('request_id', jobA);

      // ================================================================
      // Phase 8 — the command centre. Least privilege, tested as behaviour:
      // each scoped admin is asked to do the thing their role must not do.
      // ================================================================
      const opsAdmin = await createTestUser('user');
      createdUserIds.push(opsAdmin.id);
      const financeAdmin = await createTestUser('user');
      createdUserIds.push(financeAdmin.id);
      const supportAdmin = await createTestUser('user');
      createdUserIds.push(supportAdmin.id);

      await admin
        .from('profiles')
        .update({ role: 'admin' })
        .in('id', [opsAdmin.id, financeAdmin.id, supportAdmin.id]);

      // Phase 8.1 removed the grandfather rule (0044). An admin holding no
      // grant now holds NOTHING — asserted before anything is granted, because
      // this is the assumption every capability check below rests on.
      const { data: unscopedCanFinance } = await financeAdmin.client.rpc(
        'has_admin_capability' as never,
        { p_capability: 'finance' } as never
      );
      results.push({
        name: 'an admin with no grants holds no capability at all',
        pass: unscopedCanFinance !== true,
        detail: 'an unscoped admin still held finance — the grandfather rule is back',
      });

      await admin.from('admin_grants').insert([
        { profile_id: opsAdmin.id, capability: 'operations' },
        { profile_id: financeAdmin.id, capability: 'finance' },
        { profile_id: supportAdmin.id, capability: 'support' },
      ] as never);

      const holds = async (user: TestUser, capability: string) => {
        const { data } = await user.client.rpc('has_admin_capability' as never, {
          p_capability: capability,
        } as never);
        return data === true;
      };

      results.push({
        name: 'granting one capability scopes the admin to it',
        pass: (await holds(opsAdmin, 'operations')) && !(await holds(opsAdmin, 'finance')),
        detail: 'an operations admin still held finance',
      });

      // 1. Support may look, and may not move money.
      results.push({
        name: 'support cannot authorize a refund',
        pass: !(await holds(supportAdmin, 'finance')),
        detail: 'support held the finance capability',
      });
      const { data: supportRefunds } = await supportAdmin.client.rpc(
        'is_refund_authorizer' as never,
        {} as never
      );
      results.push({
        name: 'is_refund_authorizer() refuses a support-scoped admin',
        pass: supportRefunds !== true,
        detail: 'support was accepted as a refund authorizer',
      });

      // 2. Operations runs the platform and does not decide the economics.
      const { error: opsPricingError } = await opsAdmin.client
        .from('pricing_configs')
        .insert({ version: 90001, label: 'ops attempt', status: 'draft', commission_percent: 5 } as never);
      results.push({
        name: 'operations cannot write the platform economics',
        pass: Boolean(opsPricingError),
        detail: 'an operations admin created a pricing configuration',
      });
      const { data: opsFinance } = await opsAdmin.client.rpc('is_refund_authorizer' as never, {} as never);
      results.push({
        name: 'operations cannot authorize a refund',
        pass: opsFinance !== true,
        detail: 'an operations admin was accepted as a refund authorizer',
      });

      // 3. Finance handles money and does not touch the regulatory layer.
      const { data: someZone } = await admin
        .from('regulated_towing_zones')
        .select('id, active')
        .limit(1)
        .maybeSingle();
      if (someZone?.id) {
        const { error: financeZoneError } = await financeAdmin.client
          .from('regulated_towing_zones')
          .update({ active: !someZone.active })
          .eq('id', someZone.id);
        const { data: zoneAfter } = await admin
          .from('regulated_towing_zones')
          .select('active')
          .eq('id', someZone.id)
          .single();
        results.push({
          name: 'finance cannot activate or deactivate a regulated zone',
          pass: Boolean(financeZoneError) || zoneAfter!.active === someZone.active,
          detail: 'a finance admin changed a regulated zone',
        });
      }

      // 4. The operational queue and the live map are internal.
      const { error: riderQueueError } = await rider.client.rpc('ops_attention_queue' as never, {} as never);
      const { error: driverMapError } = await driverA.client.rpc('ops_live_map' as never, {
        p_min_lat: 44,
        p_min_lng: -75,
        p_max_lat: 47,
        p_max_lng: -72,
      } as never);
      results.push({
        name: 'a customer cannot read the operational queue',
        pass: Boolean(riderQueueError),
        detail: 'a customer read the platform attention queue',
      });
      results.push({
        name: 'a driver cannot read the live operations map',
        pass: Boolean(driverMapError),
        detail: 'a driver read every driver and job on the platform',
      });
      const { error: ownerKpiError } = await ownerA.client.rpc('ops_kpis' as never, {
        p_from: new Date(Date.now() - 86_400_000).toISOString(),
        p_to: new Date().toISOString(),
      } as never);
      results.push({
        name: 'a company owner cannot read platform-wide KPIs',
        pass: Boolean(ownerKpiError),
        detail: "a company owner read the whole platform's numbers",
      });

      // 5. Incidents are internal. A driver must not read the note written
      //    about their own conduct, and a customer must not learn they are the
      //    subject of a fraud incident.
      const { data: incidentRow } = await admin
        .from('operational_incidents')
        .insert({
          type: 'driver_issue',
          severity: 'high',
          title: 'RLS fixture — internal note',
          description: 'Internal only.',
          request_id: jobA,
          driver_id: driverA.id,
          company_id: coA,
        } as never)
        .select('id')
        .single();

      const { data: driverSeesIncident } = await driverA.client
        .from('operational_incidents')
        .select('id')
        .eq('id', incidentRow!.id)
        .maybeSingle();
      const { data: riderSeesIncident } = await rider.client
        .from('operational_incidents')
        .select('id')
        .eq('id', incidentRow!.id)
        .maybeSingle();
      const { data: ownerSeesIncident } = await ownerA.client
        .from('operational_incidents')
        .select('id')
        .eq('id', incidentRow!.id)
        .maybeSingle();
      const { data: otherCompanySees } = await ownerB.client
        .from('operational_incidents')
        .select('id')
        .eq('id', incidentRow!.id)
        .maybeSingle();

      results.push({
        name: 'a driver cannot read an incident about themselves',
        pass: driverSeesIncident == null,
        detail: 'a driver read the internal note about their own conduct',
      });
      results.push({
        name: 'a customer cannot read an internal incident',
        pass: riderSeesIncident == null,
        detail: 'a customer read an internal incident',
      });
      results.push({
        name: "a company cannot read incidents about itself or anyone else",
        pass: ownerSeesIncident == null && otherCompanySees == null,
        detail: 'a company owner read internal incidents',
      });

      const { data: supportSeesIncident } = await supportAdmin.client
        .from('operational_incidents')
        .select('id')
        .eq('id', incidentRow!.id)
        .maybeSingle();
      results.push({
        name: 'support can read an incident (it is why they are on the phone)',
        pass: supportSeesIncident?.id === incidentRow!.id,
        detail: 'support could not read incidents',
      });

      const { error: supportWriteIncident } = await supportAdmin.client
        .from('operational_incidents')
        .update({ status: 'dismissed' })
        .eq('id', incidentRow!.id);
      const { data: incidentAfterSupport } = await admin
        .from('operational_incidents')
        .select('status')
        .eq('id', incidentRow!.id)
        .single();
      results.push({
        name: 'support cannot resolve or dismiss an incident',
        pass: Boolean(supportWriteIncident) || incidentAfterSupport!.status === 'open',
        detail: 'support dismissed an incident',
      });

      // 6. Risk flags are the most sensitive thing here: an observation about
      //    a person, written before anybody has judged it.
      const { data: flagRow } = await admin
        .from('risk_flags')
        .insert({
          kind: 'repeated_cancellations',
          subject_profile_id: rider.id,
          observation: { count: 4, window_days: 30 },
        } as never)
        .select('id')
        .single();

      const { data: riderSeesFlag } = await rider.client
        .from('risk_flags')
        .select('id')
        .eq('id', flagRow!.id)
        .maybeSingle();
      const { data: driverSeesFlag } = await driverA.client
        .from('risk_flags')
        .select('id')
        .eq('id', flagRow!.id)
        .maybeSingle();
      const { data: supportSeesFlag } = await supportAdmin.client
        .from('risk_flags')
        .select('id')
        .eq('id', flagRow!.id)
        .maybeSingle();
      results.push({
        name: 'the subject of a risk flag cannot read it',
        pass: riderSeesFlag == null,
        detail: 'a customer read the risk observation written about them',
      });
      results.push({
        name: 'a driver cannot read risk flags',
        pass: driverSeesFlag == null,
        detail: 'a driver read internal risk flags',
      });
      results.push({
        name: 'support cannot read risk flags either',
        pass: supportSeesFlag == null,
        detail: 'support read internal risk observations',
      });

      // 7. An observation is not editable. Acknowledging it is, and that is
      //    the only thing that is.
      const { error: flagEditError } = await admin
        .from('risk_flags')
        .update({ observation: { count: 0 } } as never)
        .eq('id', flagRow!.id);
      results.push({
        name: 'a risk observation cannot be rewritten, even by the service role',
        pass: Boolean(flagEditError),
        detail: 'the observation behind a flag was edited',
      });

      // 8. The incident history is written by the trigger, and nobody inserts
      //    into it directly.
      const { data: incidentHistory } = await admin
        .from('incident_events')
        .select('to_status')
        .eq('incident_id', incidentRow!.id);
      results.push({
        name: 'opening an incident logs its own history',
        pass: (incidentHistory ?? []).length >= 1,
        detail: 'no incident_events row was written',
      });
      const { error: opsInsertEvent } = await opsAdmin.client
        .from('incident_events')
        .insert({ incident_id: incidentRow!.id, to_status: 'resolved' } as never);
      results.push({
        name: 'nobody can write incident history by hand',
        pass: Boolean(opsInsertEvent),
        detail: 'an admin inserted a fabricated incident event',
      });

      // 9. Revoking the LAST capability must revoke access. Under the old
      //    grandfather rule it did the opposite — it handed the account
      //    everything — which is precisely why that rule could not stay.
      await admin
        .from('admin_grants')
        .delete()
        .eq('profile_id', financeAdmin.id)
        .eq('capability', 'finance');

      const { data: afterRevokeFinance } = await financeAdmin.client.rpc(
        'has_admin_capability' as never,
        { p_capability: 'finance' } as never
      );
      const { data: afterRevokeOps } = await financeAdmin.client.rpc(
        'has_admin_capability' as never,
        { p_capability: 'operations' } as never
      );
      results.push({
        name: 'revoking the last capability revokes access rather than granting everything',
        pass: afterRevokeFinance !== true && afterRevokeOps !== true,
        detail: 'an admin stripped of every capability regained privileged access',
      });

      const { data: strippedRefund } = await financeAdmin.client.rpc(
        'is_refund_authorizer' as never,
        {} as never
      );
      results.push({
        name: 'a stripped admin can no longer authorize a refund',
        pass: strippedRefund !== true,
        detail: 'an admin with no capabilities was accepted as a refund authorizer',
      });

      const { error: strippedPricing } = await financeAdmin.client
        .from('pricing_configs')
        .insert({ version: 90002, label: 'stripped attempt', status: 'draft', commission_percent: 5 } as never);
      results.push({
        name: 'a stripped admin cannot write the platform economics',
        pass: Boolean(strippedPricing),
        detail: 'an admin with no capabilities wrote a pricing configuration',
      });

      // 10. The platform must always have somebody who can grant capabilities.
      const { data: superAdmins } = await admin.rpc('ops_super_admin_count' as never, {} as never);
      results.push({
        name: 'at least one super admin still exists on this project',
        pass: Number(superAdmins ?? 0) >= 1,
        detail: 'nobody can grant capabilities any more',
      });

      // ================================================================
      // Phase 9 — sharing, notifications and exports. The dedicated suites
      // (test:safety, test:exports) go deep; these are the cross-role
      // invariants that belong beside every other RLS assertion.
      // ================================================================
      const { data: safetyLink } = await admin
        .from('safety_links')
        .insert({
          request_id: jobA,
          token_hash: 'a'.repeat(64),
          created_by: rider.id,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        } as never)
        .select('id')
        .single();

      const { data: driverSeesLink } = await driverA.client
        .from('safety_links')
        .select('id')
        .eq('id', safetyLink!.id)
        .maybeSingle();
      const { data: ownerSeesLink } = await ownerA.client
        .from('safety_links')
        .select('id')
        .eq('id', safetyLink!.id)
        .maybeSingle();
      results.push({
        name: "a driver cannot read the customer's safety link",
        pass: driverSeesLink == null,
        detail: 'the assigned driver read the share token row',
      });
      results.push({
        name: 'a company owner cannot read a safety link',
        pass: ownerSeesLink == null,
        detail: 'a company read a customer share token row',
      });

      // The token is the credential, so the row must never contain it.
      const { data: storedLink } = await admin
        .from('safety_links')
        .select('token_hash')
        .eq('id', safetyLink!.id)
        .single();
      results.push({
        name: 'a safety link stores a hash, never a usable token',
        pass: /^[0-9a-f]{64}$/.test(storedLink!.token_hash),
        detail: 'a plaintext token would make reading the table equal to holding every link',
      });

      // Notifications belong to exactly one person.
      await admin.from('requests').update({ status: 'en_route' }).eq('id', jobA);
      const { data: riderInbox } = await rider.client.from('notifications').select('id, recipient_id');
      const { data: driverInbox } = await driverA.client.from('notifications').select('id, recipient_id');
      results.push({
        name: 'a customer reads only their own notifications',
        pass: (riderInbox ?? []).every((n) => n.recipient_id === rider.id),
        detail: "a notification belonging to somebody else was readable",
      });
      results.push({
        name: 'a driver reads only their own notifications',
        pass: (driverInbox ?? []).every((n) => n.recipient_id === driverA.id),
        detail: "a notification belonging to somebody else was readable",
      });

      const { error: forgeNotification } = await driverA.client.from('notifications').insert({
        recipient_id: rider.id,
        type: 'driver_arrived',
        category: 'job_progress',
        request_id: jobA,
      } as never);
      results.push({
        name: "nobody can put a notification in somebody else's inbox",
        pass: Boolean(forgeNotification),
        detail: 'a driver wrote into a customer notification feed',
      });

      // Who exported what is itself sensitive.
      await admin.from('export_audit').insert({
        actor_id: opsAdmin.id,
        capability: 'operations',
        dataset: 'requests',
        format: 'csv',
        row_count: 1,
      } as never);
      const { data: opsSeesAudit } = await opsAdmin.client.from('export_audit').select('id');
      const { data: supportSeesAudit } = await supportAdmin.client.from('export_audit').select('id');
      results.push({
        name: 'only a super admin reads the export log',
        pass: (opsSeesAudit ?? []).length === 0 && (supportSeesAudit ?? []).length === 0,
        detail: 'a scoped admin read who exported what',
      });

      const { error: forgeAudit } = await opsAdmin.client.from('export_audit').insert({
        actor_id: opsAdmin.id,
        capability: 'operations',
        dataset: 'requests',
        format: 'csv',
        row_count: 999,
      } as never);
      results.push({
        name: 'nobody can write their own line into the export log',
        pass: Boolean(forgeAudit),
        detail: 'an admin fabricated an export audit entry',
      });

      await admin.from('export_audit').delete().eq('actor_id', opsAdmin.id);
      await admin.from('safety_links').delete().eq('request_id', jobA);

      await admin.from('risk_flags').delete().eq('id', flagRow!.id);
      await admin.from('operational_incidents').delete().eq('id', incidentRow!.id);
      await admin.from('pricing_configs').delete().in('version', [90001, 90002]);

      // ---- teardown ----
      await admin.from('requests').delete().eq('user_id', rider.id);
      await admin.from('company_members').delete().in('company_id', [coA, coB]);
      await admin.from('companies').delete().in('id', [coA, coB]);
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
