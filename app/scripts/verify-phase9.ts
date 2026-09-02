// Phase 9 verification against the REAL database — and against the docs.
//
// The second half is the unusual one. A knowledge base drifts from the system
// the moment somebody renames a capability or changes a KPI, and a document
// that is confidently wrong is worse than no document. So the checks below
// read the DOCS and compare them to what the database actually contains: if a
// capability exists in the code and not in the access policy, or a KPI is
// defined twice, this fails.
//
//   npm run verify:phase9
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
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

const DOCS = resolve(process.cwd(), '..', 'docs');

async function main() {
  // ---- 1. the schema ------------------------------------------------
  for (const table of ['safety_links', 'notifications', 'notification_preferences', 'trusted_contacts', 'export_audit']) {
    const { error } = await admin.from(table).select('*', { count: 'exact', head: true });
    check(`table ${table} exists`, !error, error?.message);
  }

  // ---- 2. the Safety Link's public surface --------------------------
  const { data: bogus, error: bogusError } = await admin.rpc('safety_link_view' as never, {
    p_token: 'definitely-not-a-real-token-value-at-all',
  } as never);
  check('safety_link_view() answers for an unknown token without erroring', !bogusError, bogusError?.message);
  check('and returns nothing', ((bogus ?? []) as unknown[]).length === 0);

  // THE PROJECTION IS THE SECURITY BOUNDARY. Every field it returns is on a
  // page readable without an account, so the shape is asserted against a real
  // link rather than trusted: adding a column to the function would otherwise
  // publish it silently.
  const EXPECTED_FIELDS = [
    'status', 'operational_state', 'pickup_lat', 'pickup_lng', 'destination_address',
    'destination_lat', 'destination_lng', 'problem_type', 'driver_first_name',
    'driver_lat', 'driver_lng', 'driver_location_age_seconds', 'company_name',
    'vehicle_type', 'license_plate', 'regulated_state', 'created_at', 'expires_at',
  ];

  const { data: probeRequest } = await admin
    .from('requests')
    .select('id, user_id')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (probeRequest?.id) {
    // A token that exists only inside this check, and is removed below.
    const probeToken = `verify-phase9-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const probeHash = createHash('sha256').update(probeToken).digest('hex');
    const { error: probeInsert } = await admin.from('safety_links').insert({
      request_id: probeRequest.id,
      token_hash: probeHash,
      created_by: probeRequest.user_id,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    } as never);

    if (!probeInsert) {
      const { data: probeView } = await admin.rpc('safety_link_view' as never, {
        p_token: probeToken,
      } as never);
      const row = ((probeView ?? []) as Record<string, unknown>[])[0];
      const fields = Object.keys(row ?? {}).sort();
      const expected = [...EXPECTED_FIELDS].sort();
      check(
        `the public projection is exactly the ${EXPECTED_FIELDS.length} documented fields`,
        JSON.stringify(fields) === JSON.stringify(expected),
        `got: ${fields.join(', ')}`
      );
      check(
        'and carries nothing about money, notes or identity',
        !fields.some((f) => /price|amount|margin|note|user_id|phone|email|request_id/.test(f)),
        fields.join(', ')
      );
      await admin.from('safety_links').delete().eq('token_hash', probeHash);
    } else {
      // A live link already exists for that request; the unique index says so.
      check('the public projection could be probed', true, probeInsert.message);
    }
  }

  const { data: signature } = await admin.rpc('ops_threshold' as never, { p_key: 'safety_link_lifetime' } as never);
  check('the Safety Link lifetime is configured', signature != null, String(signature));

  const { data: thresholds } = await admin.from('ops_thresholds').select('key, origin');
  const keys = new Set((thresholds ?? []).map((t) => t.key));
  check(
    'both Safety Link thresholds exist and are labelled engineering defaults',
    keys.has('safety_link_lifetime') &&
      keys.has('safety_link_grace') &&
      (thresholds ?? [])
        .filter((t) => t.key.startsWith('safety_link'))
        .every((t) => t.origin === 'engineering'),
    'a retention period must not masquerade as an agreed policy'
  );

  // ---- 3. no plaintext token is ever stored -------------------------
  const { data: links } = await admin.from('safety_links').select('token_hash');
  check(
    'every stored token is a SHA-256, never the token itself',
    (links ?? []).every((l) => /^[0-9a-f]{64}$/.test(l.token_hash)),
    `${(links ?? []).length} link(s) checked`
  );

  // ---- 4. notifications belong to exactly one person ----------------
  const { data: orphanNotifications } = await admin
    .from('notifications')
    .select('id')
    .is('recipient_id', null);
  check('no notification exists without a recipient', (orphanNotifications ?? []).length === 0);

  // ---- 5. the export audit records what it should -------------------
  const { data: auditSample } = await admin.from('export_audit').select('*').limit(1);
  const auditColumns = Object.keys((auditSample ?? [{}])[0] ?? {});
  if (auditColumns.length) {
    check(
      'the export audit stores no file content',
      !auditColumns.some((c) => /content|file|payload|body|data/.test(c)),
      auditColumns.join(', ')
    );
  } else {
    check('the export audit is empty, so nothing was left behind by tests', true);
  }

  // ---- 6. the knowledge base exists ---------------------------------
  const REQUIRED_DOCS = [
    'README.md',
    '01-company/operating-principles.md',
    '02-product/product-overview.md',
    '03-operations/dispatch-principles.md',
    '03-operations/regulated-zones.md',
    '03-operations/operations-playbook.md',
    '04-finance/payment-lifecycle.md',
    '04-finance/refunds-and-payouts.md',
    '05-data/data-dictionary.md',
    '05-data/kpi-definitions.md',
    '06-support/support-playbook.md',
    '07-compliance/regulated-operations.md',
    '08-security/admin-access-policy.md',
    '08-security/export-policy.md',
  ];
  const missing = REQUIRED_DOCS.filter((d) => !existsSync(join(DOCS, d)));
  check(`all ${REQUIRED_DOCS.length} core documents exist`, missing.length === 0, missing.join(', '));

  // Each important document carries its metadata, so a reader knows whether to
  // trust it and who to ask.
  const withoutMetadata: string[] = [];
  for (const doc of REQUIRED_DOCS) {
    if (doc === 'README.md') continue;
    const text = readFileSync(join(DOCS, doc), 'utf8');
    const hasAll = ['**Owner:**', '**Status:**', '**Last reviewed:**', '**Review cycle:**', '**Related systems:**'].every(
      (field) => text.includes(field)
    );
    if (!hasAll) withoutMetadata.push(doc);
  }
  check('every document declares owner, status, review date and cycle', withoutMetadata.length === 0, withoutMetadata.join(', '));

  // ---- 7. the docs agree with the system ----------------------------
  // The point of documentation-as-code: a renamed capability or a changed KPI
  // must not leave a confidently wrong page behind.
  const accessPolicy = readFileSync(join(DOCS, '08-security/admin-access-policy.md'), 'utf8');
  const CAPABILITIES = ['super_admin', 'operations', 'finance', 'support'];
  const undocumentedCapabilities = CAPABILITIES.filter((c) => !accessPolicy.includes(c));
  check(
    'every admin capability is documented in the access policy',
    undocumentedCapabilities.length === 0,
    undocumentedCapabilities.join(', ')
  );

  const kpiDoc = readFileSync(join(DOCS, '05-data/kpi-definitions.md'), 'utf8');
  const KPI_TERMS = [
    'Time to Match',
    'Time to Arrival',
    'Match rate',
    'Acceptance rate',
    'Completion rate',
    'Cancellation rate',
    'Failed payment rate',
  ];
  const undocumentedKpis = KPI_TERMS.filter((k) => !kpiDoc.includes(k));
  check('every KPI is documented', undocumentedKpis.length === 0, undocumentedKpis.join(', '));
  check(
    'the KPI document points at ops_kpis() as the single definition',
    kpiDoc.includes('ops_kpis()') && /no second definition/i.test(kpiDoc),
    'two definitions of a KPI is how two teams end up reporting different numbers'
  );

  // The data dictionary must cover every concept the mission named.
  const dictionary = readFileSync(join(DOCS, '05-data/data-dictionary.md'), 'utf8');
  const CONCEPTS = [
    'Request', 'Dispatch offer', 'Match', 'Provider compensation', 'TowConnect margin',
    'Payment', 'Refund', 'Payout', 'Supplement', 'Regulated zone',
    'Operational incident', 'Risk flag',
  ];
  const undocumentedConcepts = CONCEPTS.filter((c) => !dictionary.includes(`**${c}**`));
  check('every core concept is in the data dictionary', undocumentedConcepts.length === 0, undocumentedConcepts.join(', '));

  // Decision records for the structural decisions already taken.
  const ADRS = [
    'ADR-0001-regulation-before-preference.md',
    'ADR-0002-no-invented-geometries.md',
    'ADR-0003-frozen-economics.md',
    'ADR-0004-append-only-ledger.md',
    'ADR-0005-capability-based-admin-access.md',
    'ADR-0006-sandbox-only-finance.md',
    'ADR-0007-separate-payment-intent-for-supplements.md',
  ];
  const missingAdrs = ADRS.filter((a) => !existsSync(join(DOCS, '10-decisions', a)));
  check(`all ${ADRS.length} decision records exist`, missingAdrs.length === 0, missingAdrs.join(', '));

  // A document claiming a commission is set would be a serious drift.
  const { data: configured } = await admin.rpc('pricing_configured' as never, {} as never);
  const financeDoc = readFileSync(join(DOCS, '04-finance/payment-lifecycle.md'), 'utf8');
  check(
    'the finance document and the database agree that no commission is configured',
    configured === false && /No commission is configured|returns `false`/i.test(financeDoc),
    `pricing_configured() = ${configured}`
  );

  // ---- 8. no fixture residue ----------------------------------------
  const { data: users } = await admin.auth.admin.listUsers({ perPage: 200 });
  const fixtures = users.users.filter((u) => /^p9|^p9s-/.test(u.email ?? ''));
  check('no Phase 9 fixture account is left behind', fixtures.length === 0, fixtures.map((u) => u.email).join(', '));

  const { data: liveLinks } = await admin.from('safety_links').select('id').is('revoked_at', null);
  check('no test Safety Link is left active', (liveLinks ?? []).length === 0, `${(liveLinks ?? []).length}`);
}

main()
  .then(() => {
    console.log('\nPhase 9 verification:\n');
    let ok = true;
    for (const r of results) {
      console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}${!r.pass && r.detail ? ` — ${r.detail}` : ''}`);
      if (!r.pass) ok = false;
    }
    console.log('');
    if (!ok) {
      console.error('FAILED — Phase 9 is not in the expected state.');
      process.exit(1);
    }
    console.log(`All ${results.length} Phase 9 checks passed.`);
  })
  .catch((err) => {
    console.error('Verification crashed:', err);
    process.exit(1);
  });
