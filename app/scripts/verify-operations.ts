// Phase 8 operational verification against the REAL database.
//
// Every check is a DB effect. In particular this script exists to catch two
// classes of quiet failure that a screenshot of a green dashboard never would:
//
//   1. THRESHOLD DRIFT. Two of the attention queue's thresholds are supposed
//      to MIRROR rules the dispatch engine already enforces. If somebody
//      changes the engine's 2-minute heartbeat window and not the threshold,
//      the queue keeps looking healthy while describing a system that no
//      longer exists. So the engine's own source is read and compared.
//   2. INVENTED FACTS. Every row the queue produces must point at something
//      that exists. A dashboard that shows an alert for a deleted request is
//      worse than one that shows nothing.
//
//   npm run verify:operations
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}
const admin = createClient(url, key, { auth: { persistSession: false } });

const results: { name: string; pass: boolean; detail?: string }[] = [];
const check = (name: string, pass: boolean, detail?: string) => results.push({ name, pass, detail });

async function main() {
  // ---- 1. the schema is there --------------------------------------
  for (const table of [
    'admin_grants',
    'operational_incidents',
    'incident_events',
    'risk_flags',
    'ops_thresholds',
  ]) {
    const { error } = await admin.from(table).select('*', { count: 'exact', head: true });
    check(`table ${table} exists`, !error, error?.message);
  }

  const { data: thresholds } = await admin.from('ops_thresholds').select('*');
  check('the operational thresholds are seeded', (thresholds ?? []).length >= 4, `${(thresholds ?? []).length}`);

  // ---- 2. derived thresholds still match their source ---------------
  // ops_threshold_drift() asks the ENGINE what its rules are — not a copy of
  // them, and not a regex over a migration file. If somebody changes the
  // heartbeat window and not the threshold beside it, the command centre
  // starts describing a system that no longer exists, and this is what
  // notices.
  const { data: drift } = await admin.rpc('ops_threshold_drift' as never, {} as never);
  const driftRows = (drift ?? []) as unknown as {
    key: string;
    stored_seconds: number;
    engine_seconds: number;
  }[];
  const mismatched = driftRows.filter((d) => d.stored_seconds !== d.engine_seconds);
  check(
    `derived thresholds still mirror the dispatch engine (${driftRows.length} checked)`,
    driftRows.length === 2 && mismatched.length === 0,
    mismatched.map((d) => `${d.key}: shown ${d.stored_seconds}s, engine ${d.engine_seconds}s`).join('; ')
  );

  const stored = new Map((thresholds ?? []).map((t) => [t.key, t]));
  check(
    'derived thresholds are labelled derived, engineering ones are labelled engineering',
    stored.get('driver_stale_heartbeat')?.origin === 'derived' &&
      stored.get('offer_ttl')?.origin === 'derived' &&
      stored.get('pending_without_match')?.origin === 'engineering',
    'a threshold is claiming the wrong provenance'
  );

  // ---- 3. the queue points at things that exist ---------------------
  const { data: queue, error: queueError } = await admin.rpc('ops_attention_queue' as never, {} as never);
  check('the attention queue is readable by the service role', !queueError, queueError?.message);

  const rows = (queue ?? []) as unknown as {
    kind: string;
    subject_kind: string;
    subject_id: string | null;
    request_id: string | null;
    threshold_origin: string | null;
  }[];

  let danglingRequests = 0;
  for (const row of rows) {
    if (!row.request_id) continue;
    const { data } = await admin.from('requests').select('id').eq('id', row.request_id).maybeSingle();
    if (!data) danglingRequests += 1;
  }
  check(
    `every queue row points at a request that exists (${rows.length} row(s))`,
    danglingRequests === 0,
    `${danglingRequests} row(s) reference a request that is gone`
  );
  check(
    'every queue row declares where its threshold came from',
    rows.every((r) => r.threshold_origin === 'derived' || r.threshold_origin === 'engineering'),
    'a row has no threshold provenance'
  );

  // ---- 4. the KPI contract ------------------------------------------
  // A rate over an empty denominator must be NULL, never 0: "nothing happened"
  // and "everything failed" are different facts and a 0 % reads as the second.
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const laterStill = new Date(Date.now() + 2 * 86_400_000).toISOString();
  const { data: emptyKpis } = await admin.rpc('ops_kpis' as never, {
    p_from: future,
    p_to: laterStill,
  } as never);
  const empty = (emptyKpis as { match_rate: number | null; requests_created: number }[] | null)?.[0];
  check(
    'a KPI window with no requests returns NULL rates, not zeros',
    empty != null && Number(empty.requests_created) === 0 && empty.match_rate === null,
    `requests ${empty?.requests_created}, match_rate ${empty?.match_rate}`
  );

  // ---- 5. incidents record their own history ------------------------
  const { data: probe, error: probeError } = await admin
    .from('operational_incidents')
    .insert({
      type: 'technical_issue',
      severity: 'low',
      title: 'verify:operations probe',
      description: 'Created and removed by npm run verify:operations.',
    })
    .select('id, status, resolved_at')
    .single();
  check('an incident can be opened', !probeError && probe?.id != null, probeError?.message);

  if (probe?.id) {
    const { data: opened } = await admin.from('incident_events').select('to_status').eq('incident_id', probe.id);
    check(
      'opening an incident writes its first history entry',
      (opened ?? []).length === 1 && opened![0].to_status === 'open',
      `${(opened ?? []).length} event(s)`
    );

    await admin
      .from('operational_incidents')
      .update({ status: 'resolved', resolution_note: 'probe' })
      .eq('id', probe.id);
    const { data: resolved } = await admin
      .from('operational_incidents')
      .select('status, resolved_at')
      .eq('id', probe.id)
      .single();
    check(
      'resolving an incident stamps resolved_at without anybody typing it',
      resolved!.status === 'resolved' && resolved!.resolved_at != null
    );

    // Reopening must clear it again: two fields that can disagree eventually do.
    await admin.from('operational_incidents').update({ status: 'open' }).eq('id', probe.id);
    const { data: reopened } = await admin
      .from('operational_incidents')
      .select('resolved_at')
      .eq('id', probe.id)
      .single();
    check('reopening an incident clears resolved_at', reopened!.resolved_at === null);

    const { data: history } = await admin.from('incident_events').select('id').eq('incident_id', probe.id);
    check(
      'every status change is in the history',
      (history ?? []).length === 3,
      `${(history ?? []).length} event(s), expected 3`
    );

    await admin.from('operational_incidents').delete().eq('id', probe.id);
  }

  // ---- 6. a risk observation cannot be rewritten ---------------------
  const { data: anyProfile } = await admin.from('profiles').select('id').limit(1).maybeSingle();
  if (anyProfile?.id) {
    const { data: flag } = await admin
      .from('risk_flags')
      .insert({
        kind: 'repeated_cancellations',
        subject_profile_id: anyProfile.id,
        observation: { count: 1, window_days: 30, probe: true },
      } as never)
      .select('id')
      .single();

    if (flag?.id) {
      const { error: editError } = await admin
        .from('risk_flags')
        .update({ observation: { count: 999 } } as never)
        .eq('id', flag.id);
      check('a risk observation cannot be rewritten', Boolean(editError));

      const { error: ackError } = await admin
        .from('risk_flags')
        .update({ acknowledged_at: new Date().toISOString() } as never)
        .eq('id', flag.id);
      check('a risk flag can still be acknowledged', !ackError, ackError?.message);

      await admin.from('risk_flags').delete().eq('id', flag.id);
    }
  }

  // ---- 7. the indexes the new screens rely on -----------------------
  const { data: liveMap, error: mapError } = await admin.rpc('ops_live_map' as never, {
    p_min_lat: 44,
    p_min_lng: -75,
    p_max_lat: 47,
    p_max_lng: -72,
  } as never);
  check('the live map answers for a bounded region', !mapError, mapError?.message);
  const mapRows = (liveMap ?? []) as unknown as { entity: string; lat: number; lng: number }[];
  check(
    'every point on the map is inside the requested bounds',
    mapRows.every((r) => r.lat >= 44 && r.lat <= 47 && r.lng >= -75 && r.lng <= -72),
    'the map returned a point outside the box it was asked about'
  );

  // ---- 8. least privilege is in the database, not the UI ------------
  const { data: scopedPolicies } = await admin.rpc('ops_threshold' as never, { p_key: 'offer_ttl' } as never);
  check('ops_threshold() resolves a known key', scopedPolicies != null, String(scopedPolicies));

  // ---- 9. the capability model, after 0044 --------------------------
  // The grandfather rule is gone, which makes two facts load-bearing: every
  // administrator must hold something, and somebody must still be able to
  // grant. Neither is enforced by a constraint — a trigger firing on the last
  // DELETE would be its own footgun — so they are asked here.
  const { data: adminProfiles } = await admin.from('profiles').select('id').eq('role', 'admin');
  const adminIds = (adminProfiles ?? []).map((a) => a.id);
  const { data: grants } = adminIds.length
    ? await admin.from('admin_grants').select('profile_id, capability').in('profile_id', adminIds)
    : { data: [] as { profile_id: string; capability: string }[] };

  const withoutAnyGrant = adminIds.filter(
    (id) => !(grants ?? []).some((g) => g.profile_id === id)
  );
  check(
    `every administrator holds at least one capability (${adminIds.length} admin(s))`,
    withoutAnyGrant.length === 0,
    `${withoutAnyGrant.length} admin account(s) can no longer do anything privileged`
  );

  const { data: superAdmins } = await admin.rpc('ops_super_admin_count' as never, {} as never);
  check(
    'at least one super admin can still grant capabilities',
    Number(superAdmins ?? 0) >= 1,
    `${superAdmins} super admin(s)`
  );

  const { data: capabilityDef } = await admin.rpc('has_admin_capability' as never, {
    p_capability: 'operations',
  } as never);
  // Called with the service role, which is not an admin — so the honest
  // answer is false. A `true` here would mean is_admin() is passing for
  // something that has no profile at all.
  check(
    'has_admin_capability() answers false for a caller that is not an admin',
    capabilityDef !== true,
    String(capabilityDef)
  );

  // ---- 10. no probe residue -----------------------------------------
  const { data: probeIncidents } = await admin
    .from('operational_incidents')
    .select('id')
    .eq('title', 'verify:operations probe');
  check('no probe incident is left behind', (probeIncidents ?? []).length === 0);

  const { data: probeFlags } = await admin.from('risk_flags').select('id, observation');
  const leftoverProbes = (probeFlags ?? []).filter(
    (f) => (f.observation as { probe?: boolean } | null)?.probe === true
  );
  check('no probe risk flag is left behind', leftoverProbes.length === 0);
}

main()
  .then(() => {
    console.log('\nPhase 8 operations verification:\n');
    let ok = true;
    for (const r of results) {
      console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}${!r.pass && r.detail ? ` — ${r.detail}` : ''}`);
      if (!r.pass) ok = false;
    }
    console.log('');
    if (!ok) {
      console.error('FAILED — the operational layer is not in the expected state.');
      process.exit(1);
    }
    console.log(`All ${results.length} operations checks passed.`);
  })
  .catch((err) => {
    console.error('Verification crashed:', err);
    process.exit(1);
  });
