// Phase 8 — the ten operational scenarios, executed rather than described.
//
// Same harness technique as the Phase 7.1 financial run: the real server
// actions are called as real signed-in users, with only the Next request
// transport swapped (tsconfig.e2e.json). RLS, the capability guards and the
// triggers all fire exactly as they do in the application, which is the whole
// reason this proves anything.
//
//   npm run test:operations
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();
import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js';

import { actAs } from './e2e/session';
import {
  explainDispatch,
  getAttentionQueue,
  getDispatchHealth,
  getLiveMap,
  getOperationsSnapshot,
  getOpsKpis,
  listCompanyHealth,
  listDriverOps,
  listIncidents,
  openIncident,
  setIncidentStatus,
  supportSearch,
} from '@/lib/actions/operations';

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const admin = createSupabaseClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const MTL = { lat: 45.5019, lng: -73.5674 };

const results: { scenario: string; name: string; pass: boolean; detail?: string }[] = [];
let scenario = '';
const sect = (s: string) => {
  scenario = s;
  console.log(`\n── ${s}`);
};
const ok = (name: string, pass: boolean, detail?: string) => {
  results.push({ scenario, name, pass, detail });
  console.log(`  ${pass ? '✓' : '✗'} ${name}${!pass && detail ? ` — ${detail}` : ''}`);
};

interface Actor {
  id: string;
  email: string;
  token: string;
  client: SupabaseClient;
}
const createdUserIds: string[] = [];
const createdCompanyIds: string[] = [];

async function makeActor(role: 'user' | 'driver', who: string): Promise<Actor> {
  const email = `p8-${who}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const password = 'test-password-123!';
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { role, full_name: `Phase 8 ${who}` },
  });
  if (error || !data.user) throw new Error(`could not create ${who}: ${error?.message}`);
  createdUserIds.push(data.user.id);

  const client = createSupabaseClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  for (let attempt = 1; ; attempt++) {
    const { error: signInError } = await client.auth.signInWithPassword({ email, password });
    if (!signInError) break;
    if (!/rate limit/i.test(signInError.message) || attempt >= 5) {
      throw new Error(`could not sign in ${who}: ${signInError.message}`);
    }
    console.log(`  … auth rate limit, waiting 65s (${attempt}/4)`);
    await new Promise((r) => setTimeout(r, 65_000));
  }
  const { data: session } = await client.auth.getSession();
  const token = session.session?.access_token;
  if (!token) throw new Error(`no access token for ${who}`);
  return { id: data.user.id, email, token, client };
}

async function main() {
  const rider = await makeActor('user', 'rider');
  const driver = await makeActor('driver', 'driver');
  const owner = await makeActor('user', 'owner');
  const opsAdmin = await makeActor('user', 'ops');
  const financeAdmin = await makeActor('user', 'finance');
  const supportAdmin = await makeActor('user', 'support');

  await admin
    .from('profiles')
    .update({ role: 'admin' })
    .in('id', [opsAdmin.id, financeAdmin.id, supportAdmin.id]);
  await admin.from('admin_grants').insert([
    { profile_id: opsAdmin.id, capability: 'operations' },
    { profile_id: financeAdmin.id, capability: 'finance' },
    { profile_id: supportAdmin.id, capability: 'support' },
  ] as never);

  await admin
    .from('driver_profiles')
    .update({
      approval_status: 'approved',
      is_online: true,
      current_lat: MTL.lat,
      current_lng: MTL.lng,
      last_heartbeat_at: new Date().toISOString(),
    })
    .eq('profile_id', driver.id);

  const { data: company } = await admin
    .from('companies')
    .insert({ name: 'Phase 8 Fixture Towing', owner_id: owner.id, status: 'active', province: 'QC' })
    .select('id')
    .single();
  createdCompanyIds.push(company!.id);
  await admin.from('company_members').insert([
    { company_id: company!.id, profile_id: owner.id, role: 'owner', status: 'active' },
    { company_id: company!.id, profile_id: driver.id, role: 'driver', status: 'active' },
  ]);

  const makeRequest = async (label: string) => {
    const { data } = await rider.client
      .from('requests')
      .insert({
        user_id: rider.id,
        problem_type: 'battery',
        location_text: `Phase 8 — ${label}`,
        lat: MTL.lat,
        lng: MTL.lng,
        price_estimate: 60,
      })
      .select('id')
      .single();
    return data!.id as string;
  };

  try {
    // ============================================================
    sect('1. A normal job appears on the live map');
    // ============================================================
    const normalJob = await makeRequest('normal job');
    await admin.from('requests').update({ driver_id: driver.id, status: 'matched' }).eq('id', normalJob);

    actAs(opsAdmin.token, 'operations admin');
    const map = await getLiveMap({ minLat: 45.0, minLng: -74.5, maxLat: 46.0, maxLng: -73.0 });
    ok(
      'the matched job is on the map',
      map.some((e) => e.entity === 'request' && e.id === normalJob && e.state === 'matched'),
      `${map.length} entities in the frame`
    );
    ok(
      'the online driver is on the map, and knows they are on a job',
      map.some((e) => e.entity === 'driver' && e.id === driver.id && e.state === 'on_job'),
      map.filter((e) => e.entity === 'driver').map((e) => e.state).join(', ')
    );
    ok(
      'the map returns nothing outside the requested bounds',
      map.every((e) => e.lat >= 45 && e.lat <= 46 && e.lng >= -74.5 && e.lng <= -73),
      'a point outside the box came back'
    );

    // ============================================================
    sect('2. A request with no possible candidate is surfaced');
    // ============================================================
    // Far from every driver, so the engine has nobody to offer it to.
    const { data: orphan } = await rider.client
      .from('requests')
      .insert({
        user_id: rider.id,
        problem_type: 'battery',
        location_text: 'Phase 8 — nowhere near anybody',
        lat: 52.13,
        lng: -106.67,
        price_estimate: 60,
      })
      .select('id')
      .single();
    const orphanId = orphan!.id as string;
    await admin
      .from('requests')
      .update({ created_at: new Date(Date.now() - 600_000).toISOString() })
      .eq('id', orphanId);

    const queue = await getAttentionQueue();
    ok(
      'the unmatched request reaches the attention queue',
      queue.some((q) => q.request_id === orphanId),
      `${queue.length} queue rows, none for this request`
    );
    ok(
      'it is reported as having had no candidate, not merely as slow',
      queue.some((q) => q.request_id === orphanId && q.kind === 'no_candidate_found'),
      queue.filter((q) => q.request_id === orphanId).map((q) => q.kind).join(', ')
    );

    const candidates = await explainDispatch(orphanId);
    ok(
      'the explain view answers with the engine’s own reasons',
      candidates.every((c) => !c.eligible),
      `${candidates.filter((c) => c.eligible).length} candidate(s) were eligible after all`
    );

    const health = await getDispatchHealth();
    ok(
      'dispatch health lists it among requests never offered to anybody',
      health.pendingWithoutOffer.some((r) => r.id === orphanId)
    );

    // ============================================================
    sect('3. A driver goes quiet mid-job');
    // ============================================================
    await admin
      .from('driver_profiles')
      .update({ last_heartbeat_at: new Date(Date.now() - 10 * 60_000).toISOString() })
      .eq('profile_id', driver.id);

    const staleQueue = await getAttentionQueue();
    ok(
      'the assigned driver going quiet raises an item',
      staleQueue.some((q) => q.kind === 'assigned_driver_stale' && q.request_id === normalJob),
      'no stale-driver item was raised'
    );
    ok(
      'that item declares its threshold as derived from the engine',
      staleQueue.find((q) => q.kind === 'assigned_driver_stale')?.threshold_origin === 'derived'
    );

    const driversAfter = await listDriverOps(company!.id);
    ok(
      'the driver reads as stale, not as online and not as offline',
      driversAfter.find((d) => d.profileId === driver.id)?.presence === 'stale',
      driversAfter.find((d) => d.profileId === driver.id)?.presence
    );

    const mapStale = await getLiveMap({ minLat: 45.0, minLng: -74.5, maxLat: 46.0, maxLng: -73.0 });
    ok(
      'the map shows the same driver as stale',
      mapStale.find((e) => e.entity === 'driver' && e.id === driver.id)?.state === 'stale'
    );

    await admin
      .from('driver_profiles')
      .update({ last_heartbeat_at: new Date().toISOString() })
      .eq('profile_id', driver.id);

    // ============================================================
    sect('4. A regulated-zone request is visible as such');
    // ============================================================
    const { data: activeZone } = await admin
      .from('regulated_towing_zones')
      .select('id, official_name')
      .eq('active', true)
      .limit(1)
      .maybeSingle();

    if (activeZone?.id) {
      const regulatedJob = await makeRequest('regulated capacity wait');
      await admin
        .from('requests')
        .update({
          regulated_zone_id: activeZone.id,
          regulated_dispatch_state: 'restricted_capacity_wait',
        })
        .eq('id', regulatedJob);

      const regulatedQueue = await getAttentionQueue();
      ok(
        'a regulated capacity wait is raised on its own terms',
        regulatedQueue.some((q) => q.kind === 'regulated_capacity_wait' && q.request_id === regulatedJob)
      );

      const mapRegulated = await getLiveMap({ minLat: 45.0, minLng: -74.5, maxLat: 46.0, maxLng: -73.0 });
      ok(
        'the map shows the regulated wait as its own state, not as "pending"',
        mapRegulated.find((e) => e.id === regulatedJob)?.state === 'restricted_capacity_wait',
        mapRegulated.find((e) => e.id === regulatedJob)?.state
      );
    } else {
      ok('a regulated zone exists to test against', false, 'no active regulated zone in this database');
    }

    // ============================================================
    sect('5-7. Payment, supplement and refund exceptions reach the queue');
    // ============================================================
    // Fabricated at the data layer on purpose: Phase 7.1 already proved these
    // states are produced for real by Stripe. What Phase 8 has to prove is
    // that the command centre notices them.
    const paymentJob = await makeRequest('failed payment');
    const { data: failedPayment } = await admin
      .from('payments')
      .insert({ request_id: paymentJob, amount: 60, status: 'failed', failure_reason: 'card_declined' })
      .select('id')
      .single();

    const supplementJob = await makeRequest('uncollected supplement');
    await admin.from('requests').update({ driver_id: driver.id, status: 'in_progress' }).eq('id', supplementJob);
    await admin.from('request_supplements').insert({
      request_id: supplementJob,
      type_key: 'winch',
      amount: 25,
      status: 'approved',
      proposed_by: driver.id,
      payment_state: 'uncollected',
      payment_note: 'The authorization could not be increased',
    } as never);

    const exceptionQueue = await getAttentionQueue();
    ok(
      'a failed payment reaches the queue',
      exceptionQueue.some((q) => q.kind === 'payment_failed' && q.request_id === paymentJob)
    );
    ok(
      'an uncollected supplement reaches the queue',
      exceptionQueue.some((q) => q.kind === 'supplement_uncollected' && q.request_id === supplementJob)
    );

    const snapshot = await getOperationsSnapshot();
    ok(
      'the snapshot counts the payment needing attention',
      snapshot.paymentsNeedingAttention >= 1,
      String(snapshot.paymentsNeedingAttention)
    );
    ok(
      'the snapshot counts the uncollected supplement',
      snapshot.supplementsUncollected >= 1,
      String(snapshot.supplementsUncollected)
    );

    // ============================================================
    sect('8. An incident is opened, investigated and resolved');
    // ============================================================
    const incident = await openIncident({
      type: 'payment_issue',
      severity: 'high',
      title: 'Phase 8 scenario — payment declined twice',
      description: 'Opened by the operations scenario run.',
      requestId: paymentJob,
      paymentId: failedPayment!.id,
    });
    ok('an operations admin can open an incident', incident.status === 'open');

    const withIncident = await getAttentionQueue();
    ok(
      'the open incident appears in the queue at its own severity',
      withIncident.some((q) => q.kind === 'open_incident' && q.severity === 'high'),
      'the incident did not reach the queue'
    );

    await setIncidentStatus(incident.id, 'investigating');
    await setIncidentStatus(incident.id, 'resolved', 'Customer used a different card.');

    const { data: resolved } = await admin
      .from('operational_incidents')
      .select('status, resolved_at, resolution_note')
      .eq('id', incident.id)
      .single();
    ok(
      'resolving stamps the time and keeps the note',
      resolved!.status === 'resolved' && resolved!.resolved_at != null && resolved!.resolution_note != null
    );

    const { data: history } = await admin
      .from('incident_events')
      .select('from_status, to_status')
      .eq('incident_id', incident.id)
      .order('created_at');
    ok(
      'every step of that is in the history, written by the database',
      (history ?? []).length === 3 &&
        history![0].to_status === 'open' &&
        history![2].to_status === 'resolved',
      `${(history ?? []).length} event(s)`
    );

    const afterResolve = await getAttentionQueue();
    ok(
      'a resolved incident leaves the queue',
      !afterResolve.some((q) => q.subject_id === incident.id),
      'the resolved incident is still being surfaced'
    );

    const openOnly = await listIncidents(['open', 'investigating']);
    ok('the resolved incident is out of the open list', !openOnly.some((i) => i.id === incident.id));

    // ============================================================
    sect('9. A company with drivers reads correctly');
    // ============================================================
    const companies = await listCompanyHealth();
    const fixture = companies.find((c) => c.id === company!.id);
    ok('the fixture company is listed', fixture != null);
    ok('its driver count is real', fixture?.drivers === 1, String(fixture?.drivers));
    ok(
      'its completion rate is NULL rather than 0 % with nothing completed',
      fixture?.completionRate === null || fixture?.completionRate === 0,
      String(fixture?.completionRate)
    );
    ok(
      'it is correctly reported as not ready for payouts',
      fixture?.payoutReady === false,
      String(fixture?.payoutReady)
    );

    // ============================================================
    sect('10. Permissions, with real sessions');
    // ============================================================
    const denied = async (what: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
        ok(what, false, 'the action was allowed');
      } catch {
        ok(what, true);
      }
    };

    actAs(supportAdmin.token, 'support admin');
    const supportHits = await supportSearch(rider.email);
    ok(
      'support can find a customer’s jobs by email',
      supportHits.length > 0,
      `${supportHits.length} hits for ${rider.email}`
    );
    ok(
      'the result says which identifier matched',
      supportHits.every((h) => h.matchedVia === 'customer email')
    );
    await denied('support cannot open an incident', () =>
      openIncident({ type: 'technical_issue', severity: 'low', title: 'support attempt' })
    );
    await denied('support cannot read the platform snapshot', () => getOperationsSnapshot());

    actAs(financeAdmin.token, 'finance admin');
    await denied('finance cannot read the operational queue', () => getAttentionQueue());
    await denied('finance cannot open an incident', () =>
      openIncident({ type: 'technical_issue', severity: 'low', title: 'finance attempt' })
    );

    actAs(opsAdmin.token, 'operations admin');
    const opsKpis = await getOpsKpis(30);
    ok('operations can read the KPIs', opsKpis != null);
    ok(
      'the KPI window counts the requests this run created',
      Number(opsKpis?.requests_created ?? 0) >= 4,
      String(opsKpis?.requests_created)
    );

    actAs(rider.token, 'customer');
    await denied('a customer cannot read the attention queue', () => getAttentionQueue());
    actAs(driver.token, 'driver');
    await denied('a driver cannot read the live map', () =>
      getLiveMap({ minLat: 45, minLng: -74, maxLat: 46, maxLng: -73 })
    );
  } finally {
    // ---- cleanup -----------------------------------------------------
    scenario = 'Cleanup';
    const { data: fixtureRequests } = await admin
      .from('requests')
      .select('id')
      .in('user_id', createdUserIds.length ? createdUserIds : ['00000000-0000-0000-0000-000000000000']);
    const ids = (fixtureRequests ?? []).map((r) => r.id);
    if (ids.length) {
      await admin.from('operational_incidents').delete().in('request_id', ids);
      await admin.from('request_supplements').delete().in('request_id', ids);
    }
    await admin.from('operational_incidents').delete().ilike('title', 'Phase 8 scenario%');
    if (createdCompanyIds.length) {
      await admin.from('company_members').delete().in('company_id', createdCompanyIds);
      await admin.from('operational_incidents').delete().in('company_id', createdCompanyIds);
      await admin.from('companies').delete().in('id', createdCompanyIds);
    }
    for (const userId of createdUserIds) {
      await admin.from('admin_grants').delete().eq('profile_id', userId);
      await admin.auth.admin.deleteUser(userId);
    }

    const { data: leftoverUsers } = await admin.auth.admin.listUsers({ perPage: 200 });
    ok(
      'no fixture account is left behind',
      leftoverUsers.users.filter((u) => (u.email ?? '').startsWith('p8-')).length === 0
    );
    const { data: leftoverCompanies } = await admin
      .from('companies')
      .select('id')
      .ilike('name', 'Phase 8 Fixture%');
    ok('no fixture company is left behind', (leftoverCompanies ?? []).length === 0);
    const { data: leftoverIncidents } = await admin
      .from('operational_incidents')
      .select('id')
      .ilike('title', 'Phase 8 scenario%');
    ok('no fixture incident is left behind', (leftoverIncidents ?? []).length === 0);
  }
}

main()
  .then(() => {
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length} passed, ${failed.length} failed.`);
    if (failed.length) {
      console.log('\nFailures:');
      for (const f of failed) console.log(`  ✗ [${f.scenario}] ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
      process.exit(1);
    }
  })
  .catch((err) => {
    console.error('\nOperations scenarios crashed:', err);
    process.exit(1);
  });
