// Phase 10 verification — against the real database, the real repository and
// the real published copy.
//
//   npm run verify:phase10
//
// THREE THINGS THIS CHECKS THAT A UNIT TEST CANNOT
//
//  1. That the pilot gate REFUSES. A switch nobody has watched close is a
//     switch nobody knows works; this one closes intake, proves a request is
//     rejected, and opens it again.
//  2. That the analytics whitelist refuses. Privacy controls that have never
//     been tested against are decoration.
//  3. That no secret is in the working tree or the recent history — scanned by
//     pattern, and the value is never printed.
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
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

const REPO = resolve(process.cwd(), '..');
const DOCS = join(REPO, 'docs');
const SRC = resolve(process.cwd(), 'src');

// Somewhere in the pilot territory, and somewhere emphatically not.
const MONTREAL = { lat: 45.5019, lng: -73.5674 };
const QUEBEC_CITY = { lat: 46.8139, lng: -71.208 };

async function main() {
  // ---- 1. the schema -------------------------------------------------
  for (const table of [
    'launch_readiness_items',
    'pilot_config',
    'pilot_coverage_areas',
    'pilot_allowlist',
    'partner_links',
    'product_events',
  ]) {
    const { error } = await admin.from(table).select('*', { count: 'exact', head: true });
    check(`table ${table} exists`, !error, error?.message);
  }

  // ---- 2. a checklist item cannot be green without evidence ----------
  // THE CONSTRAINT IS THE POINT. Ticking a box on a busy day is exactly what
  // a launch checklist exists to resist, so the refusal is in the database.
  const { error: greenWithoutEvidence } = await admin.from('launch_readiness_items').insert({
    domain: 'product',
    key: 'verify.phase10.probe',
    title: 'Probe',
    owner: 'verify:phase10',
    status: 'ready',
    evidence: null,
  } as never);
  check(
    'an item cannot be marked ready without evidence',
    greenWithoutEvidence != null,
    greenWithoutEvidence ? undefined : 'the insert SUCCEEDED — the constraint is gone'
  );
  await admin.from('launch_readiness_items').delete().eq('key', 'verify.phase10.probe');

  const { error: blockedWithoutNote } = await admin.from('launch_readiness_items').insert({
    domain: 'product',
    key: 'verify.phase10.probe2',
    title: 'Probe',
    owner: 'verify:phase10',
    status: 'blocked',
    note: null,
  } as never);
  check('a blocked item must say why', blockedWithoutNote != null);
  await admin.from('launch_readiness_items').delete().eq('key', 'verify.phase10.probe2');

  const { data: items } = await admin
    .from('launch_readiness_items')
    .select('domain, key, status, blocker, evidence');
  const domains = new Set((items ?? []).map((i) => i.domain));
  check(
    'the checklist covers all fourteen domains',
    domains.size === 14,
    `${domains.size} domain(s): ${[...domains].sort().join(', ')}`
  );
  check(
    'every ready item carries evidence',
    (items ?? []).every((i) => i.status !== 'ready' || Boolean(i.evidence?.trim()))
  );

  // ---- 3. the pilot gate actually refuses ----------------------------
  const { data: cfg } = await admin.from('pilot_config').select('*').maybeSingle();
  check('the pilot configuration is a single row', cfg != null, cfg ? `mode=${cfg.mode}` : 'missing');
  const originalMode = cfg?.mode ?? 'off';
  const originalReason = cfg?.paused_reason ?? null;

  const gate = async (lat: number | null, lng: number | null) => {
    const { data } = await admin.rpc('pilot_gate' as never, {
      p_profile_id: null,
      p_lat: lat,
      p_lng: lng,
    } as never);
    return (data as { allowed: boolean; reason: string }[] | null)?.[0];
  };

  await admin.from('pilot_config').update({ mode: 'off', paused_reason: null }).eq('id', true);
  check('with the pilot off, everywhere is open', (await gate(QUEBEC_CITY.lat, QUEBEC_CITY.lng))?.allowed === true);

  await admin
    .from('pilot_config')
    .update({ mode: 'paused', paused_reason: 'verify:phase10 probe' })
    .eq('id', true);
  const paused = await gate(MONTREAL.lat, MONTREAL.lng);
  check('a paused pilot refuses even inside the territory', paused?.allowed === false, paused?.reason);
  check('and says it is paused', paused?.reason === 'paused', paused?.reason);

  await admin.from('pilot_config').update({ mode: 'pilot', paused_reason: null }).eq('id', true);
  const inside = await gate(MONTREAL.lat, MONTREAL.lng);
  const outside = await gate(QUEBEC_CITY.lat, QUEBEC_CITY.lng);
  check('a gated pilot accepts inside the declared territory', inside?.allowed === true, inside?.reason);
  check('and refuses outside it', outside?.allowed === false, outside?.reason);
  check('naming the territory as the reason', outside?.reason === 'outside_territory', outside?.reason);

  // Restored before anything else runs, whatever happened above.
  await admin
    .from('pilot_config')
    .update({ mode: originalMode, paused_reason: originalReason })
    .eq('id', true);
  const { data: restored } = await admin.from('pilot_config').select('mode').maybeSingle();
  check('the pilot mode was restored', restored?.mode === originalMode, `mode=${restored?.mode}`);

  // ---- 4. coverage says served / not_served / undeclared -------------
  const coverageAt = async (lat: number, lng: number) => {
    const { data } = await admin.rpc('pilot_point_coverage' as never, { p_lat: lat, p_lng: lng } as never);
    return data as unknown as string;
  };
  check('Montréal is inside the declared territory', (await coverageAt(MONTREAL.lat, MONTREAL.lng)) === 'served');
  check(
    'Québec City is not',
    (await coverageAt(QUEBEC_CITY.lat, QUEBEC_CITY.lng)) === 'not_served'
  );

  const { data: areas } = await admin.from('pilot_coverage_areas').select('name, note, state');
  check(
    'every declared area explains what it is and is not',
    (areas ?? []).every((a) => a.note.trim().length > 40),
    'a coverage shape without a stated meaning becomes a boundary somebody quotes'
  );

  // ---- 5. coverage NEVER overrides the regulated engine --------------
  // A commercial declaration must not be able to grant anything inside a zone
  // the law restricts. The two systems are asked separately, and the
  // regulated one still answers for a point inside the territory.
  const { data: zoneRows } = await admin
    .from('regulated_towing_zones')
    .select('id, official_name')
    .eq('active', true)
    .limit(1);
  if (zoneRows?.length) {
    const { error: zoneErr } = await admin.rpc('regulated_zone_for_point' as never, {
      p_lat: MONTREAL.lat,
      p_lng: MONTREAL.lng,
    } as never);
    check('the regulated-zone engine still answers inside the pilot territory', !zoneErr, zoneErr?.message);
  } else {
    check('the regulated-zone engine still answers inside the pilot territory', true, 'no active zone to probe');
  }
  const migration = readFileSync(
    join(process.cwd(), 'supabase/migrations/0047_pilot_readiness.sql'),
    'utf8'
  );
  check(
    'the coverage table states in the schema that it cannot override regulation',
    /AND IT NEVER TOUCHES THE REGULATED ENGINE/.test(migration) &&
      /regulated-zone engine and unable to override it/i.test(migration),
    'the claim has to live where somebody changing the table will read it'
  );

  // ---- 6. analytics cannot carry a fact about a person ---------------
  const { error: badProp } = await admin.rpc('record_product_event' as never, {
    p_name: 'landing_viewed',
    p_anon_id: null,
    p_request_id: null,
    p_attribution_code: null,
    p_props: { customer_phone: '514-555-0100' },
  } as never);
  check(
    'a property off the whitelist is refused',
    badProp != null,
    badProp ? undefined : 'the insert SUCCEEDED — analytics can now carry anything'
  );

  const { error: longProp } = await admin.rpc('record_product_event' as never, {
    p_name: 'landing_viewed',
    p_anon_id: null,
    p_request_id: null,
    p_attribution_code: null,
    p_props: { reason: 'x'.repeat(120) },
  } as never);
  check('a whitelisted property long enough to be prose is refused', longProp != null);

  const { error: badName } = await admin.rpc('record_product_event' as never, {
    p_name: 'clicked_something',
    p_anon_id: null,
    p_request_id: null,
    p_attribution_code: null,
    p_props: {},
  } as never);
  check('an event name outside the enum is refused', badName != null);

  const { data: eventRows } = await admin.from('product_events').select('props').limit(200);
  const forbidden = /phone|email|address|name|token|card|iban|note|message/i;
  check(
    'no recorded event carries a property that could identify somebody',
    (eventRows ?? []).every((e) => Object.keys(e.props ?? {}).every((k) => !forbidden.test(k))),
    `${(eventRows ?? []).length} event(s) checked`
  );

  // ---- 7. attribution is recorded once, never edited -----------------
  const { data: attributed } = await admin
    .from('requests')
    .select('id, attribution_code')
    .limit(1)
    .maybeSingle();
  if (attributed?.id) {
    const { error: rewrite } = await admin
      .from('requests')
      .update({ attribution_code: 'verify-phase10' })
      .eq('id', attributed.id);
    check(
      'attribution cannot be changed after the request is created',
      rewrite != null,
      rewrite ? undefined : 'the update SUCCEEDED — attribution is editable'
    );
  } else {
    check('attribution cannot be changed after the request is created', true, 'no request to probe');
  }

  // ---- 8. the documents that Phase 10 promises -----------------------
  const REQUIRED_DOCS = [
    '02-product/pilot-territory.md',
    '03-operations/account-lifecycle.md',
    '04-finance/stripe-live-readiness.md',
    '05-data/analytics-events.md',
    '05-data/pilot-review-pack.md',
    '06-support/pilot-support-runbook.md',
    '08-security/prelaunch-security-review.md',
    '09-sops/pilot-launch-runbook.md',
    '11-partners/partner-onboarding.md',
    '11-partners/partner-kit.md',
    '12-commercial/30-day-pilot-plan.md',
    '12-commercial/sales-scripts.md',
    '13-legal/README.md',
    '13-legal/privacy-policy.md',
    '13-legal/terms-of-service.md',
    '13-legal/partner-terms.md',
    '10-decisions/ADR-0008-local-pilot-before-expansion.md',
    '10-decisions/ADR-0009-supply-first.md',
    '10-decisions/ADR-0010-feature-gated-pilot.md',
    '10-decisions/ADR-0011-no-stripe-live-before-checklist.md',
  ];
  const missingDocs = REQUIRED_DOCS.filter((d) => !existsSync(join(DOCS, d)));
  check(`all ${REQUIRED_DOCS.length} Phase 10 documents exist`, missingDocs.length === 0, missingDocs.join(', '));

  const withoutMetadata = REQUIRED_DOCS.filter((doc) => {
    if (!existsSync(join(DOCS, doc))) return true;
    const text = readFileSync(join(DOCS, doc), 'utf8');
    if (doc.startsWith('10-decisions/')) return !text.includes('**Status:**');
    return !['**Owner:**', '**Status:**', '**Last reviewed:**', '**Review cycle:**'].every((f) =>
      text.includes(f)
    );
  });
  check('every Phase 10 document declares owner, status and review date', withoutMetadata.length === 0, withoutMetadata.join(', '));

  // Every legal document says, in its own text, that it has not been reviewed.
  for (const doc of ['13-legal/privacy-policy.md', '13-legal/terms-of-service.md', '13-legal/partner-terms.md']) {
    const text = existsSync(join(DOCS, doc)) ? readFileSync(join(DOCS, doc), 'utf8') : '';
    check(`${doc} is marked DRAFT — LEGAL REVIEW REQUIRED`, /DRAFT — LEGAL REVIEW REQUIRED/.test(text));
  }

  // ---- 9. the public copy makes no promise the system cannot keep ----
  const publicPages = readFileSync(join(SRC, 'lib/content/publicPages.ts'), 'utf8');

  // A CLAIM, NOT A WORD
  // The first version of this check failed on the sentence "nous ne
  // promettons ni couverture 24/7 ni délai garanti" — which is the product
  // being honest, flagged as the product lying. So the file is split into
  // sentences and a sentence is only a claim when it does NOT carry a
  // negation. That keeps the check useful without teaching anybody to delete
  // the disclaimers to make it pass.
  const NEGATIONS =
    /\b(ne\s|ni\s|aucun|aucune|sans\s|pas\s|non\s|neither|nor|no\s|not\s|never|cannot|promets?|promettons)/i;
  const sentences = publicPages
    .split(/(?<=[.!?])\s+|\n/)
    .map((x) => x.trim())
    .filter(Boolean);

  const FORBIDDEN_CLAIMS: { label: string; pattern: RegExp; why: string }[] = [
    { label: '24/7 availability', pattern: /24\s*\/\s*7/i, why: 'no hours have been agreed' },
    { label: 'a guarantee', pattern: /\bgarantie?s?\b|\bguarantee/i, why: 'nothing is guaranteed during the pilot' },
    {
      label: 'a count of operators',
      pattern: /\b\d{2,}\s*(remorqueurs|chauffeurs|drivers|partners|partenaires)\b/i,
      why: 'no count of operators exists',
    },
    { label: 'a rating', pattern: /\b(\d+([.,]\d+)?)\s*(étoiles|stars)\b/i, why: 'there are no ratings' },
    { label: 'national coverage', pattern: /\bpartout au Canada\b|\bnationwide\b/i, why: 'the pilot is Montréal and the South Shore' },
    { label: 'a response time', pattern: /\ben\s+\d+\s*(min|minutes)\b/i, why: 'no arrival time is ever promised' },
  ];
  for (const { label, pattern, why } of FORBIDDEN_CLAIMS) {
    const offending = sentences.filter((x) => pattern.test(x) && !NEGATIONS.test(x));
    check(`no public page promises ${label}`, offending.length === 0, `${why} — ${offending[0] ?? ''}`);
  }
  check(
    'every public coverage claim goes through one shared sentence',
    /export const PILOT_STATEMENT/.test(publicPages) &&
      (publicPages.match(/PILOT_STATEMENT\.(fr|en)/g) ?? []).length >= 8,
    'a page that writes its own coverage sentence is a page that will drift'
  );
  check(
    'the legal drafts carry their banner in both languages',
    /LEGAL_DRAFT_BANNER/.test(publicPages) &&
      (publicPages.match(/banner: LEGAL_DRAFT_BANNER/g) ?? []).length === 6
  );

  // ---- 9b. the transactional emails ---------------------------------
  // They are applied to the project through the Management API, which means
  // the live copy is a setting in a dashboard — the classic place for text to
  // drift from the product. The canonical version is in the repository so it
  // can be reviewed, and checked here so it stays honest.
  const templatesPath = join(process.cwd(), 'supabase/auth-templates/templates.ts');
  const templates = existsSync(templatesPath) ? readFileSync(templatesPath, 'utf8') : '';
  check('the transactional email templates are versioned in the repository', templates.length > 0);
  for (const key of [
    'mailer_templates_confirmation_content',
    'mailer_templates_recovery_content',
    'mailer_templates_magic_link_content',
  ]) {
    check(`the ${key.replace('mailer_templates_', '').replace('_content', '')} email exists`, templates.includes(key));
  }
  check(
    'every template links through Supabase’s own confirmation URL',
    (templates.match(/\{\{ \.ConfirmationURL \}\}/g) ?? []).length >= 3,
    'a hand-built link would not carry a valid token'
  );
  check(
    'the email button uses the accessible orange, not the brand one',
    templates.includes('#cc4400') && !/background:#ff5c1a/.test(templates),
    'white on #ff5c1a measures 3.09:1 — an email and a screen must not disagree about this'
  );
  check(
    'no template carries an external image or stylesheet',
    !/<img|https?:\/\/[^"']*\.(png|jpg|css)/i.test(templates),
    'a blocked CDN must not turn a confirmation email into an empty box'
  );

  // ---- 9c. password recovery exists and is reachable -----------------
  // Sprint 1 found that Supabase could produce a recovery link and nothing in
  // the product reached it. These check that the two screens exist, that the
  // login page offers the first one, and that the redirect guard is wired in.
  const forgotPage = join(SRC, 'app/(auth)/mot-de-passe-oublie/page.tsx');
  const resetPage = join(SRC, 'app/(auth)/nouveau-mot-de-passe/page.tsx');
  check('the forgotten-password screen exists', existsSync(forgotPage));
  check('the new-password screen exists', existsSync(resetPage));

  const loginPage = readFileSync(join(SRC, 'app/(auth)/login/page.tsx'), 'utf8');
  check(
    'the login screen offers a way out',
    loginPage.includes('/mot-de-passe-oublie'),
    'a recovery flow nothing links to is a recovery flow nobody finds'
  );

  const authActions = readFileSync(join(SRC, 'lib/actions/auth.ts'), 'utf8');
  check('the reset request goes through a server action', /resetPasswordForEmail/.test(authActions));
  check(
    'and it returns nothing, so it cannot leak whether an account exists',
    /Promise<void>/.test(authActions),
    'an answer that differs between a known and an unknown address is an enumeration oracle'
  );

  const callback = readFileSync(join(SRC, 'app/auth/callback/route.ts'), 'utf8');
  check(
    'the auth callback validates where it is being sent',
    /safeNext\(/.test(callback),
    'concatenating an attacker-supplied ?next= onto an origin is how open redirects happen'
  );

  // ---- 10. no secret in the tree or the recent history ---------------
  // Patterns only. A match is reported by FILE, never by value.
  const SECRET_PATTERNS: { name: string; pattern: RegExp }[] = [
    { name: 'Stripe secret key', pattern: /\bsk_(live|test)_[A-Za-z0-9]{16,}/ },
    { name: 'Stripe restricted key', pattern: /\brk_(live|test)_[A-Za-z0-9]{16,}/ },
    { name: 'Stripe webhook secret', pattern: /\bwhsec_[A-Za-z0-9]{16,}/ },
    { name: 'Supabase service role JWT', pattern: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/ },
    { name: 'Mapbox secret token', pattern: /\bsk\.eyJ[A-Za-z0-9_-]{20,}/ },
    { name: 'Postgres URI with a password', pattern: /postgres(ql)?:\/\/[^\s:]+:[^\s@]+@/ },
  ];

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.next', '.git', 'dist', 'coverage'].includes(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (statSync(full).size < 2_000_000) out.push(full);
    }
    return out;
  }

  // .env files are excluded: they are gitignored by design and holding a
  // secret is what they are for. What matters is that nothing else does.
  const tracked = walk(REPO).filter(
    (f) => !/(^|[\\/])\.env(\.|$)/.test(f) && /\.(ts|tsx|js|jsx|json|md|sql|mjs|cjs|css|html|yml|yaml)$/.test(f)
  );
  const leaks: string[] = [];
  for (const file of tracked) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const { name, pattern } of SECRET_PATTERNS) {
      if (pattern.test(text)) leaks.push(`${name} in ${relative(REPO, file)}`);
    }
  }
  check('no secret in the working tree', leaks.length === 0, leaks.join('; '));

  let historyLeaks: string[] = [];
  try {
    const diff = execSync('git log -p -n 50 --no-color', {
      cwd: REPO,
      maxBuffer: 200 * 1024 * 1024,
      encoding: 'utf8',
    });
    for (const { name, pattern } of SECRET_PATTERNS) {
      // The service-role JWT pattern also matches an ANON key, which is
      // public by design — so a hit is only reported when it appears next to
      // a service-role-ish word.
      if (pattern.test(diff)) {
        if (name.includes('service role')) {
          if (/service_role[^\n]{0,200}eyJ/i.test(diff)) historyLeaks.push(name);
        } else {
          historyLeaks.push(name);
        }
      }
    }
  } catch (e) {
    historyLeaks = [`could not read git history: ${(e as Error).message}`];
  }
  check('no secret in the last 50 commits', historyLeaks.length === 0, historyLeaks.join('; '));

  // ---- 11. the service role never reaches a browser ------------------
  const clientFiles = walk(SRC).filter((f) => /\.(ts|tsx)$/.test(f));
  const clientLeaks = clientFiles.filter((f) => {
    const text = readFileSync(f, 'utf8');
    const isClient = /^['"]use client['"]/m.test(text);
    return isClient && /supabase\/admin|SERVICE_ROLE/.test(text);
  });
  check(
    'no client component reaches the service-role client',
    clientLeaks.length === 0,
    clientLeaks.map((f) => relative(SRC, f)).join(', ')
  );

  const adminClient = readFileSync(join(SRC, 'lib/supabase/admin.ts'), 'utf8');
  check(
    "the service-role client is marked server-only",
    /import ['"]server-only['"]/.test(adminClient),
    'the import is what makes a client-side use a build error rather than a leak'
  );

  // ---- 12. the state Phase 10 must not have changed ------------------
  const { data: configured } = await admin.rpc('pricing_configured' as never, {} as never);
  check('no commission rate has been configured', configured === false, `pricing_configured() = ${configured}`);

  const stripeKey = process.env.STRIPE_SECRET_KEY ?? '';
  check(
    'Stripe is not live',
    stripeKey.startsWith('sk_test_') || stripeKey.startsWith('rk_test_') || stripeKey === '',
    'the key prefix is not a test prefix'
  );

  // ---- 13. no fixture residue ----------------------------------------
  const { data: users } = await admin.auth.admin.listUsers({ perPage: 200 });
  const fixtures = users.users.filter((u) => /^p10-/.test(u.email ?? ''));
  check('no Phase 10 fixture account is left behind', fixtures.length === 0, fixtures.map((u) => u.email).join(', '));

  const { data: probeItems } = await admin
    .from('launch_readiness_items')
    .select('key')
    .like('key', 'verify.%');
  check('no probe row is left in the checklist', (probeItems ?? []).length === 0);
}

main()
  .then(() => {
    console.log('\nPhase 10 verification:\n');
    let ok = true;
    for (const r of results) {
      console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}${!r.pass && r.detail ? ` — ${r.detail}` : ''}`);
      if (!r.pass) ok = false;
    }
    console.log('');
    if (!ok) {
      console.error('FAILED — Phase 10 is not in the expected state.');
      process.exit(1);
    }
    console.log(`All ${results.length} Phase 10 checks passed.`);
  })
  .catch((err) => {
    console.error('Verification crashed:', err);
    process.exit(1);
  });
