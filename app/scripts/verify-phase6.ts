// Phase 6 verification against the REAL Supabase project.
//
// The rule this project learned the hard way: verify by database effect, not
// by an HTTP status or a "Success" banner. Both prior outages returned clean
// responses while doing nothing. Everything below asserts on what the
// database actually contains, or actually refuses.
//
//   npm run verify:phase6
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
  // ---- schema landed ----
  for (const table of [
    'regulated_towing_zones',
    'regulated_zone_providers',
    'regulated_zone_audit',
    'company_members',
    'fleet_vehicles',
    'driver_vehicle_assignments',
    'company_service_areas',
    'service_type_requirements',
    'document_requirements',
    'dispatch_partner_preferences',
    'platform_pricing_config',
    'pricing_rules',
    'service_supplement_types',
    'request_supplements',
  ]) {
    const { error } = await admin.from(table).select('*', { head: true, count: 'exact' });
    check(`table ${table} exists`, !error, error?.message?.slice(0, 70));
  }

  // ---- the official zones, and the honest state they ship in ----
  const { data: zones } = await admin
    .from('regulated_towing_zones')
    .select('province, official_name, active, geometry_confidence, dispatch_mode, authority_phone, source_url');
  const qc = zones?.find((z) => z.province === 'QC');
  const on = zones?.find((z) => z.province === 'ON');

  check('Quebec exclusive-towing zone is seeded', Boolean(qc));
  check('Ontario restricted tow zone programme is seeded', Boolean(on));
  check(
    'Quebec zone routes the motorist to 911, as the province now requires',
    qc?.authority_phone === '911' && qc?.dispatch_mode === 'external_authority_required',
    `phone=${qc?.authority_phone} mode=${qc?.dispatch_mode}`
  );
  check(
    'Ontario zone routes the motorist to 511',
    on?.authority_phone === '511' && on?.dispatch_mode === 'external_authority_required',
    `phone=${on?.authority_phone} mode=${on?.dispatch_mode}`
  );
  check(
    'both seeded zones are INACTIVE with no geometry - the gap is visible, not papered over',
    zones?.every((z) => !z.active && z.geometry_confidence === 'none') === true,
    JSON.stringify(zones?.map((z) => [z.province, z.active, z.geometry_confidence]))
  );
  check(
    'every seeded zone carries an official source URL',
    zones?.every((z) => typeof z.source_url === 'string' && z.source_url.startsWith('https://')) === true
  );

  // ---- the anti-fabrication guard, exercised for real ----
  const zoneId = (await admin.from('regulated_towing_zones').select('id').limit(1).single()).data?.id;
  const { error: activateError } = await admin
    .from('regulated_towing_zones')
    .update({ active: true })
    .eq('id', zoneId!);
  check(
    'a zone with no geometry cannot be switched on',
    Boolean(activateError),
    activateError ? undefined : 'a geometry-less zone went ACTIVE'
  );

  // ---- Ontario authorized operators, recorded as facts not partners ----
  const { data: providers, count: providerCount } = await admin
    .from('regulated_zone_providers')
    .select('company_id, authorization_status', { count: 'exact' });
  check('the 15 published Ontario zone operators are recorded', providerCount === 15, `count=${providerCount}`);
  check(
    'no official operator was invented as a TowConnect company',
    (providers ?? []).every((p) => p.company_id === null),
    'a provider row points at a TowConnect company that was never onboarded'
  );

  // ---- new-driver scoring is neutral, not a free 5.0 ----
  const { data: prior } = await admin.rpc('driver_rating_population_mean' as never, {} as never);
  const { data: unrated } = await admin.rpc('driver_effective_rating' as never, {
    p_rating: 5.0,
    p_total_services: 0,
    p_prior_mean: 4.5,
  } as never);
  const { data: veteran } = await admin.rpc('driver_effective_rating' as never, {
    p_rating: 4.8,
    p_total_services: 200,
    p_prior_mean: 4.5,
  } as never);
  check(
    'a driver with no history scores the platform mean, not a perfect 5.0',
    Number(unrated) === 4.5,
    `effective=${unrated} (prior mean fixture 4.5)`
  );
  check(
    'a driver with real history keeps essentially their own rating',
    Math.abs(Number(veteran) - 4.8) < 0.02,
    `effective=${veteran}`
  );
  check('driver_rating_population_mean() is callable', prior != null, `mean=${prior}`);

  // ---- pricing: nothing invented ----
  const { data: cfg } = await admin.from('platform_pricing_config').select('*').single();
  check(
    'no commission rate is configured - every economics field is NULL',
    cfg?.commission_percent === null &&
      cfg?.commission_fixed === null &&
      cfg?.provider_minimum === null &&
      cfg?.payment_processing_percent === null &&
      cfg?.payment_processing_fixed === null,
    JSON.stringify(cfg)
  );
  const { data: configured } = await admin.rpc('pricing_configured' as never, {} as never);
  check('pricing_configured() reports false', configured === false, `got ${configured}`);

  const { error: emptyRuleError } = await admin
    .from('pricing_rules')
    .insert({ name: 'verify probe', target: 'customer_price', component: 'base_fee', active: true } as never);
  check(
    'an active pricing rule with no value is refused',
    Boolean(emptyRuleError),
    emptyRuleError ? undefined : 'an empty active rule was accepted'
  );

  const { count: ruleCount } = await admin.from('pricing_rules').select('*', { head: true, count: 'exact' });
  check('no pricing rule is live', ruleCount === 0, `count=${ruleCount}`);

  // ---- document requirements: no jurisdiction assumed ----
  const { count: reqCount } = await admin
    .from('document_requirements')
    .select('*', { head: true, count: 'exact' });
  check(
    'no document requirement is assumed for any province',
    reqCount === 0,
    `count=${reqCount} - a requirement exists that nobody verified`
  );

  // ---- service requirements are seeded ----
  const { data: reqs } = await admin
    .from('service_type_requirements')
    .select('problem_type, any_of_capabilities');
  check('every problem type has a service requirement row', (reqs ?? []).length === 8, `count=${(reqs ?? []).length}`);
  check(
    "'other' requires no equipment, so nobody is excluded for it",
    (reqs ?? []).find((r) => r.problem_type === 'other')?.any_of_capabilities?.length === 0
  );

  // ---- detection is live, and returns nothing while no zone is active ----
  const { data: mtl, error: mtlError } = await admin.rpc('regulated_zone_for_point', {
    p_lat: 45.5019,
    p_lng: -73.5674,
  });
  check(
    'downtown Montreal resolves to no active zone today',
    !mtlError && (mtl as { id?: string | null } | null)?.id == null,
    mtlError?.message
  );

  // ---- no test fixture left behind ----
  const { data: strays } = await admin
    .from('regulated_towing_zones')
    .select('id, official_name')
    .eq('jurisdiction', 'RLS integration test');
  check('no test zone is left in the database', (strays ?? []).length === 0, JSON.stringify(strays));

  const { data: strayCompanies } = await admin
    .from('companies')
    .select('id, name')
    .ilike('name', 'RLS Test%');
  check(
    'no test company is left in the database',
    (strayCompanies ?? []).length === 0,
    JSON.stringify(strayCompanies)
  );

  const { data: strayReq } = await admin
    .from('document_requirements')
    .select('id')
    .eq('notes', 'RLS integration test fixture');
  check('no test document requirement is left behind', (strayReq ?? []).length === 0);
}

main()
  .then(() => {
    console.log('\nPhase 6 verification:\n');
    let ok = true;
    for (const r of results) {
      console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}${!r.pass && r.detail ? ` — ${r.detail}` : ''}`);
      if (!r.pass) ok = false;
    }
    console.log('');
    if (!ok) {
      console.error('FAILED — Phase 6 infrastructure is not in the expected state.');
      process.exit(1);
    }
    console.log(`All ${results.length} Phase 6 checks passed.`);
  })
  .catch((err) => {
    console.error('Verification crashed:', err);
    process.exit(1);
  });
