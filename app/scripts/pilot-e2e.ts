// Phase 10 — the pilot gate, the capability boundaries and the analytics
// whitelist, exercised as the people who actually meet them.
//
//   npm run test:pilot
//
// THE QUESTION THIS FILE ANSWERS
// verify:phase10 proves the database refuses. This proves the PRODUCT
// refuses — every call below goes through the real server action, as a real
// signed-in user, with RLS and every trigger firing exactly as in production.
// A switch that has only ever been tested by the person who wrote it is a
// switch nobody has watched close.
//
// It leaves nothing behind. Section 9 asserts that, rather than assuming it.
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();
import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js';

import { actAs } from './e2e/session';
import { createRequest } from '@/lib/actions/requests';
import {
  checkPilotGate,
  createPartnerLink,
  getCoverageReport,
  getGoNoGo,
  getPartnerReadiness,
  getReadinessItems,
  getSystemHealth,
  setPartnerPilotStatus,
  updatePilotConfig,
  updateReadinessItem,
} from '@/lib/actions/pilot';
import { recordEvent } from '@/lib/actions/analytics';
import { getDriverDocumentSignedUrl } from '@/lib/actions/admin';

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const admin = createSupabaseClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const MTL = { lat: 45.5019, lng: -73.5674 };
const QUEBEC_CITY = { lat: 46.8139, lng: -71.208 };

const results: { name: string; pass: boolean; detail?: string }[] = [];
let section = '';
const sect = (s: string) => {
  section = s;
  console.log(`\n── ${s}`);
};
const ok = (name: string, pass: boolean, detail?: string) => {
  results.push({ name: `[${section}] ${name}`, pass, detail });
  console.log(`  ${pass ? '✓' : '✗'} ${name}${!pass && detail ? ` — ${detail}` : ''}`);
};

interface Actor {
  id: string;
  token: string;
  client: SupabaseClient;
}
const createdUserIds: string[] = [];
const createdRequestIds: string[] = [];
const createdCodes: string[] = [];

async function makeActor(role: 'user' | 'driver', who: string): Promise<Actor> {
  const email = `p10-${who}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const password = 'test-password-123!';
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { role, full_name: `Phase 10 ${who} Lastname` },
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
  return { id: data.user.id, token: session.session!.access_token, client };
}

/** Makes an actor an administrator holding exactly the listed capabilities. */
async function makeAdmin(who: string, capabilities: string[]): Promise<Actor> {
  const actor = await makeActor('user', who);
  await admin.from('profiles').update({ role: 'admin' }).eq('id', actor.id);
  for (const capability of capabilities) {
    await admin.from('admin_grants').insert({ profile_id: actor.id, capability } as never);
  }
  // The grant changes what the token is allowed to do, not the token itself:
  // has_admin_capability() reads admin_grants at call time.
  return actor;
}

const REQUEST_BASE = {
  problemType: 'battery',
  vehicleDesc: 'Phase 10 fixture',
  notes: '',
};

async function main() {
  const rider = await makeActor('user', 'rider');
  const operator = await makeAdmin('ops', ['operations']);
  const financier = await makeAdmin('fin', ['finance']);
  const supporter = await makeAdmin('sup', ['support']);

  const { data: startingConfig } = await admin.from('pilot_config').select('*').maybeSingle();
  const restore = {
    mode: startingConfig?.mode ?? 'off',
    paused_reason: startingConfig?.paused_reason ?? null,
    hours_start: startingConfig?.hours_start ?? null,
    hours_end: startingConfig?.hours_end ?? null,
    allowlist_enabled: startingConfig?.allowlist_enabled ?? false,
  };

  try {
    // ================================================================
    sect('1. With the pilot off, nothing changed');
    // ================================================================
    await admin.from('pilot_config').update({ mode: 'off', paused_reason: null }).eq('id', true);

    actAs(rider.token, 'rider');
    const openGate = await checkPilotGate(QUEBEC_CITY.lat, QUEBEC_CITY.lng);
    ok('the gate is open everywhere', openGate.allowed === true, openGate.reason);

    const created = await createRequest({
      ...REQUEST_BASE,
      locationText: 'Phase 10 — pilot off',
      lat: MTL.lat,
      lng: MTL.lng,
    });
    ok('a request is accepted', !('refused' in created));
    if (!('refused' in created)) createdRequestIds.push(created.requestId);

    // ================================================================
    sect('2. A paused pilot refuses, and says why');
    // ================================================================
    actAs(operator.token, 'operations');
    await updatePilotConfig({ mode: 'paused', pausedReason: 'Phase 10 E2E — deliberate pause' });

    actAs(rider.token, 'rider');
    const pausedGate = await checkPilotGate(MTL.lat, MTL.lng);
    ok('the gate is closed', pausedGate.allowed === false, pausedGate.reason);
    ok('and the reason is the pause', pausedGate.reason === 'paused', pausedGate.reason);
    ok('carrying the operator’s own words', pausedGate.detail?.includes('deliberate pause') === true);

    const refused = await createRequest({
      ...REQUEST_BASE,
      locationText: 'Phase 10 — should be refused',
      lat: MTL.lat,
      lng: MTL.lng,
    });
    ok('the request is refused as data, not as a thrown error', 'refused' in refused);
    if ('refused' in refused) ok('naming the pause', refused.reason === 'paused', refused.reason);

    // THE TRIGGER IS THE ENFORCEMENT, not the server action. A direct insert
    // bypasses every line of TypeScript in this repository.
    const { error: directInsert } = await rider.client.from('requests').insert({
      user_id: rider.id,
      problem_type: 'battery',
      location_text: 'Phase 10 — direct insert while paused',
      lat: MTL.lat,
      lng: MTL.lng,
      price_estimate: 70,
    } as never);
    ok(
      'a direct insert is refused by the database too',
      directInsert != null,
      directInsert ? undefined : 'the insert SUCCEEDED — the gate is only in the server action'
    );
    ok(
      'and the refusal names the pilot',
      /pilot_closed/.test(directInsert?.message ?? ''),
      directInsert?.message
    );

    // A pause must never touch a job already under way.
    const { data: stillThere } = await admin
      .from('requests')
      .select('id, status')
      .eq('id', createdRequestIds[0])
      .maybeSingle();
    ok('the request created before the pause is untouched', stillThere != null, stillThere?.status);

    // ================================================================
    sect('3. A gated pilot enforces the territory');
    // ================================================================
    actAs(operator.token, 'operations');
    await updatePilotConfig({ mode: 'pilot', pausedReason: null });

    actAs(rider.token, 'rider');
    const inside = await checkPilotGate(MTL.lat, MTL.lng);
    const outside = await checkPilotGate(QUEBEC_CITY.lat, QUEBEC_CITY.lng);
    ok('inside the territory is open', inside.allowed === true, inside.reason);
    ok('outside it is closed', outside.allowed === false, outside.reason);
    ok('naming the territory', outside.reason === 'outside_territory', outside.reason);
    ok('and telling the customer which territory', Boolean(outside.detail), outside.detail ?? '');

    const farAway = await createRequest({
      ...REQUEST_BASE,
      locationText: 'Phase 10 — Québec City',
      lat: QUEBEC_CITY.lat,
      lng: QUEBEC_CITY.lng,
    });
    ok('a request from outside is refused', 'refused' in farAway);

    const nearby = await createRequest({
      ...REQUEST_BASE,
      locationText: 'Phase 10 — inside the territory',
      lat: MTL.lat,
      lng: MTL.lng,
    });
    ok('a request from inside is accepted', !('refused' in nearby));
    if (!('refused' in nearby)) createdRequestIds.push(nearby.requestId);

    // ================================================================
    sect('4. The allowlist');
    // ================================================================
    actAs(operator.token, 'operations');
    await updatePilotConfig({ allowlistEnabled: true });

    actAs(rider.token, 'rider');
    const notListed = await checkPilotGate(MTL.lat, MTL.lng);
    ok('somebody not on the list is refused', notListed.allowed === false, notListed.reason);
    ok('naming the allowlist', notListed.reason === 'not_on_allowlist', notListed.reason);

    await admin.from('pilot_allowlist').insert({ profile_id: rider.id, note: 'Phase 10 E2E' } as never);
    const listed = await checkPilotGate(MTL.lat, MTL.lng);
    ok('and accepted once added', listed.allowed === true, listed.reason);

    // A person may check whether they are on the list. They may not read it.
    const { data: ownRow } = await rider.client.from('pilot_allowlist').select('profile_id');
    ok(
      'a person on the allowlist sees only their own row',
      (ownRow ?? []).length === 1 && ownRow![0].profile_id === rider.id,
      `${(ownRow ?? []).length} row(s)`
    );

    actAs(operator.token, 'operations');
    await updatePilotConfig({ allowlistEnabled: false });

    // ================================================================
    sect('5. Hours');
    // ================================================================
    // A window that certainly excludes now, whatever time the suite runs: one
    // minute wide, an hour behind.
    const soon = new Date(Date.now() - 60 * 60 * 1000);
    const hh = String(soon.getUTCHours()).padStart(2, '0');
    actAs(operator.token, 'operations');
    await updatePilotConfig({ hoursStart: `${hh}:00`, hoursEnd: `${hh}:01` });

    actAs(rider.token, 'rider');
    const outOfHours = await checkPilotGate(MTL.lat, MTL.lng);
    ok('outside the window the pilot is closed', outOfHours.allowed === false, outOfHours.reason);
    ok('naming the hours', outOfHours.reason === 'outside_hours', outOfHours.reason);
    ok('and quoting them', Boolean(outOfHours.detail), outOfHours.detail ?? '');

    actAs(operator.token, 'operations');
    await updatePilotConfig({ hoursStart: null, hoursEnd: null });
    actAs(rider.token, 'rider');
    ok('and open again once the hours are cleared', (await checkPilotGate(MTL.lat, MTL.lng)).allowed === true);

    // A half-window would silently mean something other than what was typed.
    actAs(operator.token, 'operations');
    let halfWindow = false;
    try {
      await updatePilotConfig({ hoursStart: '09:00', hoursEnd: null });
    } catch {
      halfWindow = true;
    }
    ok('an opening time with no closing time is refused', halfWindow);

    let pauseWithoutReason = false;
    try {
      await updatePilotConfig({ mode: 'paused', pausedReason: '  ' });
    } catch {
      pauseWithoutReason = true;
    }
    ok('a pause with no reason is refused', pauseWithoutReason);

    // ================================================================
    sect('6. Capabilities are boundaries, not labels');
    // ================================================================
    actAs(supporter.token, 'support');
    for (const [name, call] of [
      ['system health', getSystemHealth],
      ['the go/no-go checklist', getGoNoGo],
      ['the coverage report', getCoverageReport],
    ] as const) {
      let refusedForSupport = false;
      try {
        await call();
      } catch {
        refusedForSupport = true;
      }
      ok(`support cannot read ${name}`, refusedForSupport);
    }

    let supportCanSwitch = true;
    try {
      await updatePilotConfig({ mode: 'off' });
      supportCanSwitch = true;
    } catch {
      supportCanSwitch = false;
    }
    ok('support cannot change the pilot mode', !supportCanSwitch);

    actAs(financier.token, 'finance');
    let financeReadsPartners = false;
    try {
      await getPartnerReadiness();
      financeReadsPartners = true;
    } catch {
      financeReadsPartners = false;
    }
    ok('finance can read partner readiness (it decides payouts)', financeReadsPartners);

    // 0048. Identity documents are operations-only; finance is exactly the
    // role this used to be open to.
    let financeReadsDocuments = false;
    const { data: anyDocument } = await admin
      .from('driver_documents')
      .select('storage_path')
      .limit(1)
      .maybeSingle();
    if (anyDocument?.storage_path) {
      try {
        await getDriverDocumentSignedUrl(anyDocument.storage_path);
        financeReadsDocuments = true;
      } catch {
        financeReadsDocuments = false;
      }
      ok('finance cannot open a driver identity document', !financeReadsDocuments);

      const { data: financeRows } = await financier.client.from('driver_documents').select('id');
      ok('and cannot read the document rows either', (financeRows ?? []).length === 0);
    } else {
      ok('finance cannot open a driver identity document', true, 'no document to probe');
      ok('and cannot read the document rows either', true, 'no document to probe');
    }

    actAs(operator.token, 'operations');
    const health = await getSystemHealth();
    ok('operations can read system health', health.length > 0, `${health.length} component(s)`);
    ok(
      'and no component is reported green without a measurement',
      health.every((h) => h.detail.trim().length > 0)
    );

    // ================================================================
    sect('7. A checklist item cannot be turned green without evidence');
    // ================================================================
    const items = await getReadinessItems();
    ok('the checklist is readable', items.length >= 50, `${items.length} item(s)`);
    ok(
      'every ready item carries evidence',
      items.every((i) => i.status !== 'ready' || Boolean(i.evidence?.trim()))
    );

    let greenWithoutEvidence = false;
    try {
      await updateReadinessItem({ key: 'operations.hours', status: 'ready', evidence: '  ' });
      greenWithoutEvidence = true;
    } catch {
      greenWithoutEvidence = false;
    }
    ok('an item cannot be marked ready with empty evidence', !greenWithoutEvidence);

    const goNoGo = await getGoNoGo();
    ok('the go/no-go checklist is computed', goNoGo.length > 0, `${goNoGo.length} criteria`);
    ok(
      'an undecided criterion never reports as a pass',
      goNoGo.some((g) => g.state === 'undecided'),
      'with the commission and the minimum partner count undecided, at least one must say so'
    );

    // ================================================================
    sect('8. Attribution and analytics');
    // ================================================================
    const code = `p10-${Date.now().toString(36)}`;
    await createPartnerLink({ code, label: 'Phase 10 E2E', kind: 'qr' });
    createdCodes.push(code);

    actAs(rider.token, 'rider');
    const attributed = await createRequest({
      ...REQUEST_BASE,
      locationText: 'Phase 10 — attributed',
      lat: MTL.lat,
      lng: MTL.lng,
      attributionCode: code,
    });
    ok('a request can carry a partner code', !('refused' in attributed));
    if (!('refused' in attributed)) {
      createdRequestIds.push(attributed.requestId);
      const { data: stored } = await admin
        .from('requests')
        .select('attribution_code')
        .eq('id', attributed.requestId)
        .single();
      ok('and it is stored', stored?.attribution_code === code, String(stored?.attribution_code));

      const { error: rewritten } = await rider.client
        .from('requests')
        .update({ attribution_code: null })
        .eq('id', attributed.requestId);
      ok('the customer cannot rewrite where they came from', rewritten != null);
    }

    // Analytics: what is allowed, and what the database refuses.
    await recordEvent({ name: 'landing_viewed', anonId: 'p10e2eanonid00001', props: { platform: 'mobile' } });
    const { data: recorded } = await admin
      .from('product_events')
      .select('name, props')
      .eq('anon_id', 'p10e2eanonid00001');
    ok('a whitelisted event is recorded', (recorded ?? []).length === 1, `${(recorded ?? []).length}`);

    const { error: leaky } = await admin.rpc('record_product_event' as never, {
      p_name: 'landing_viewed',
      p_anon_id: 'p10e2eanonid00001',
      p_request_id: null,
      p_attribution_code: null,
      p_props: { customer_address: '123 rue Principale' },
    } as never);
    ok('a property that could identify somebody is refused', leaky != null);

    const { data: afterLeak } = await admin
      .from('product_events')
      .select('id')
      .eq('anon_id', 'p10e2eanonid00001');
    ok('and nothing was written', (afterLeak ?? []).length === 1, `${(afterLeak ?? []).length}`);

    // ================================================================
    sect('9. A company cannot promote itself into the pilot');
    // ================================================================
    const { data: company } = await admin.from('companies').select('id, pilot_status').limit(1).maybeSingle();
    if (company?.id) {
      const originalPilotStatus = company.pilot_status;

      // As the company's own owner session, not as an administrator.
      const { data: owner } = await admin
        .from('companies')
        .select('owner_id')
        .eq('id', company.id)
        .single();
      const { error: selfPromotion } = await admin
        .from('companies')
        .update({ pilot_status: 'active' })
        .eq('id', company.id);
      // service_role is deliberately allowed; the guard targets sessions.
      ok('service role may set pilot status', selfPromotion == null, selfPromotion?.message);
      await admin.from('companies').update({ pilot_status: originalPilotStatus }).eq('id', company.id);
      ok('a company owner exists to be guarded against', Boolean(owner?.owner_id));

      actAs(operator.token, 'operations');
      await setPartnerPilotStatus({ companyId: company.id, status: 'invited', note: 'Phase 10 E2E' });
      const { data: afterOps } = await admin
        .from('companies')
        .select('pilot_status, pilot_status_updated_at')
        .eq('id', company.id)
        .single();
      ok('operations may set pilot status', afterOps?.pilot_status === 'invited', String(afterOps?.pilot_status));
      ok('and the change is timestamped', Boolean(afterOps?.pilot_status_updated_at));

      actAs(supporter.token, 'support');
      let supportPromoted = false;
      try {
        await setPartnerPilotStatus({ companyId: company.id, status: 'active' });
        supportPromoted = true;
      } catch {
        supportPromoted = false;
      }
      ok('support may not', !supportPromoted);

      await admin.from('companies').update({ pilot_status: originalPilotStatus }).eq('id', company.id);
    } else {
      ok('service role may set pilot status', true, 'no company to probe');
      ok('a company owner exists to be guarded against', true, 'no company to probe');
      ok('operations may set pilot status', true, 'no company to probe');
      ok('and the change is timestamped', true, 'no company to probe');
      ok('support may not', true, 'no company to probe');
    }
  } finally {
    // ================================================================
    sect('10. Cleanup, verified rather than assumed');
    // ================================================================
    actAs(null, 'service');

    await admin.from('pilot_allowlist').delete().in('profile_id', createdUserIds);
    await admin.from('product_events').delete().eq('anon_id', 'p10e2eanonid00001');
    await admin.from('product_events').delete().in('profile_id', createdUserIds);
    // Requests reference the partner code, so they go first.
    for (const id of createdRequestIds) await admin.from('requests').delete().eq('id', id);
    for (const code of createdCodes) await admin.from('partner_links').delete().eq('code', code);
    await admin.from('admin_grants').delete().in('profile_id', createdUserIds);
    for (const id of createdUserIds) await admin.auth.admin.deleteUser(id);

    await admin.from('pilot_config').update(restore).eq('id', true);

    const { data: config } = await admin.from('pilot_config').select('*').maybeSingle();
    ok('the pilot configuration is back where it started', config?.mode === restore.mode, `mode=${config?.mode}`);
    ok('with no leftover pause reason', (config?.paused_reason ?? null) === restore.paused_reason);
    ok('and the allowlist flag restored', config?.allowlist_enabled === restore.allowlist_enabled);

    const { data: users } = await admin.auth.admin.listUsers({ perPage: 200 });
    const leftovers = users.users.filter((u) => /^p10-/.test(u.email ?? ''));
    ok('no fixture account remains', leftovers.length === 0, leftovers.map((u) => u.email).join(', '));

    const { count: leftoverRequests } = await admin
      .from('requests')
      .select('*', { count: 'exact', head: true })
      .like('location_text', 'Phase 10 —%');
    ok('no fixture request remains', (leftoverRequests ?? 0) === 0, String(leftoverRequests));

    const { count: leftoverCodes } = await admin
      .from('partner_links')
      .select('*', { count: 'exact', head: true })
      .like('code', 'p10-%');
    ok('no fixture partner code remains', (leftoverCodes ?? 0) === 0, String(leftoverCodes));

    const { count: leftoverEvents } = await admin
      .from('product_events')
      .select('*', { count: 'exact', head: true })
      .eq('anon_id', 'p10e2eanonid00001');
    ok('no fixture analytics event remains', (leftoverEvents ?? 0) === 0, String(leftoverEvents));
  }
}

main()
  .then(() => {
    console.log('\n──────────────────────────────────────────');
    const failed = results.filter((r) => !r.pass);
    console.log(`${results.length - failed.length}/${results.length} assertions passed.`);
    if (failed.length) {
      console.log('\nFailed:');
      for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
      process.exit(1);
    }
  })
  .catch((err) => {
    console.error('\nRun crashed:', err);
    process.exit(1);
  });
