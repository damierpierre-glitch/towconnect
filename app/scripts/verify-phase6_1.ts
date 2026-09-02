// Phase 6.1 verification against the REAL Supabase project.
//
// Phase 6 built the zone engine and left it holding no boundary. This checks
// the thing that changed: that fifteen Ontario zones now carry a geometry
// derived from official sources, that the geometry actually resolves the way
// it should from GPS coordinates, and - the check that matters most for a
// customer - that it resolves to NOTHING across the area TowConnect actually
// launches in.
//
//   npm run verify:phase6_1
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

const ZONE_CODES = ['1A', '1B', '1C', '1D', '2A', '2B', '2C', '2D', '3A', '3B', '3C', '3D', '4A', '4B', '4C'];

// Midpoints of each zone's own derived centreline. Not typed from memory: each
// was produced by the derivation and then checked against
// regulated_zone_for_point() on this project.
const ON_ROAD: [string, number, number][] = [
  ['1A', 43.72478, -79.47223],
  ['2A', 43.62594, -79.69393],
  ['4A', 43.53927, -79.63127],
];

// Where the customers are. A false positive here is the expensive kind: it
// tells someone in the launch area that TowConnect cannot help them.
const LAUNCH_AREA: [string, number, number][] = [
  ['downtown Montréal', 45.5019, -73.5674],
  ['Longueuil, Rive-Sud', 45.5312, -73.5182],
  ['Brossard, Rive-Sud', 45.4515, -73.4659],
  ['Laval', 45.606, -73.7124],
  ['Montréal, Plateau', 45.5232, -73.5817],
  ['Montréal-Nord', 45.6, -73.6333],
  ['Pointe-Claire, West Island', 45.4487, -73.8168],
  ['Saint-Lambert', 45.4986, -73.5083],
];

// Off the highway but inside the GTHA, where the geometry is real. These are
// the false positives that would matter in Ontario.
const OFF_ROAD_GTHA: [string, number, number][] = [
  ['Yorkdale Mall parking', 43.7256, -79.4522],
  ['Mississauga City Centre', 43.589, -79.6441],
  ['Scarborough Town Centre', 43.7764, -79.258],
  ['downtown Toronto', 43.6561, -79.3802],
  ['Oakville lakefront', 43.44, -79.665],
];

async function main() {
  const { data: zones } = await admin
    .from('regulated_towing_zones')
    .select('id, province, zone_code, active, geometry_confidence, dispatch_mode, authority_phone, effective_to, source_url');

  const onZones = (zones ?? []).filter((z) => z.province === 'ON' && z.zone_code !== null);
  check('all fifteen Ontario zones exist as individual rows', onZones.length === 15, `count=${onZones.length}`);
  check(
    'every official zone code is present exactly once',
    ZONE_CODES.every((c) => onZones.filter((z) => z.zone_code === c).length === 1),
    JSON.stringify(onZones.map((z) => z.zone_code).sort())
  );
  check(
    'all fifteen are active with a derived geometry',
    onZones.every((z) => z.active && z.geometry_confidence === 'derived_from_official_text'),
    JSON.stringify(onZones.map((z) => [z.zone_code, z.active, z.geometry_confidence]))
  );
  check(
    'none claims to be an official published boundary',
    onZones.every((z) => z.geometry_confidence !== 'official_geospatial'),
    'a zone claims official_geospatial provenance that Ontario has not published'
  );
  check(
    'every zone routes the motorist to 511 rather than to dispatch',
    onZones.every((z) => z.authority_phone === '511' && z.dispatch_mode === 'external_authority_required')
  );

  const programme = (zones ?? []).find((z) => z.province === 'ON' && z.zone_code === null);
  check(
    'the Phase 6 programme-level row is retired, not deleted',
    Boolean(programme) && programme!.active === false && programme!.effective_to !== null,
    JSON.stringify(programme)
  );

  const qc = (zones ?? []).find((z) => z.province === 'QC');
  check(
    'Quebec is still inactive with no geometry, because none is published',
    Boolean(qc) && qc!.active === false && qc!.geometry_confidence === 'none',
    JSON.stringify(qc)
  );

  // ---- each operator sits on its own zone now ----
  const { data: providers } = await admin
    .from('regulated_zone_providers')
    .select('zone_id, official_operator_name, company_id');
  const zoneIds = new Set(onZones.map((z) => z.id));
  const onProviders = (providers ?? []).filter((p) => zoneIds.has(p.zone_id));
  check(
    'each of the fifteen operators is attached to its own zone',
    onProviders.length === 15 && new Set(onProviders.map((p) => p.zone_id)).size === 15,
    `${onProviders.length} providers across ${new Set(onProviders.map((p) => p.zone_id)).size} zones`
  );
  check(
    'no operator was invented as a TowConnect company',
    (providers ?? []).every((p) => p.company_id === null)
  );

  // ---- live PostGIS detection ----
  for (const [code, lat, lng] of ON_ROAD) {
    const { data } = await admin.rpc('regulated_zone_for_point', { p_lat: lat, p_lng: lng });
    const z = data as { id: string | null; zone_code: string | null } | null;
    check(`a point on the roadway of zone ${code} resolves to zone ${code}`, z?.zone_code === code,
      `resolved to ${z?.zone_code ?? 'nothing'}`);
  }

  for (const [name, lat, lng] of LAUNCH_AREA) {
    const { data } = await admin.rpc('regulated_zone_for_point', { p_lat: lat, p_lng: lng });
    const z = data as { id: string | null; zone_code: string | null } | null;
    check(`launch area is unaffected: ${name}`, z?.id == null, `resolved to ${z?.zone_code}`);
  }

  for (const [name, lat, lng] of OFF_ROAD_GTHA) {
    const { data } = await admin.rpc('regulated_zone_for_point', { p_lat: lat, p_lng: lng });
    const z = data as { id: string | null; zone_code: string | null } | null;
    check(`off the highway in the GTHA: ${name}`, z?.id == null, `resolved to ${z?.zone_code}`);
  }

  // ---- the boundary can be inspected ----
  const sample = onZones[0];
  const { data: geo } = await admin.rpc('regulated_zone_geojson' as never, { p_zone_id: sample.id } as never);
  const feature = geo as { geometry?: { type?: string }; bbox?: number[] } | null;
  // Polygon or MultiPolygon: a zone whose parts merge into one after
  // simplification comes back as a Polygon, and both are valid GeoJSON for a
  // map to draw.
  check(
    'a zone boundary can be fetched as GeoJSON for inspection',
    ['Polygon', 'MultiPolygon'].includes(feature?.geometry?.type ?? '') &&
      Array.isArray(feature?.bbox) &&
      feature!.bbox!.length === 4,
    JSON.stringify({ type: feature?.geometry?.type, bbox: feature?.bbox })
  );

  // ---- Ontario document requirements ----
  const { data: docRules } = await admin
    .from('document_requirements')
    .select('province, document_type, required, blocks_online, blocks_dispatch, source_url');
  check(
    'Ontario has exactly the two requirements ontario.ca states',
    (docRules ?? []).filter((r) => r.province === 'ON').length === 2,
    JSON.stringify(docRules)
  );
  check(
    'both cite ontario.ca',
    (docRules ?? [])
      .filter((r) => r.province === 'ON')
      .every((r) => (r.source_url ?? '').startsWith('https://www.ontario.ca/')),
  );
  check(
    'nothing is asserted for Quebec, where no source was found',
    (docRules ?? []).filter((r) => r.province === 'QC').length === 0
  );
  check(
    'no province-agnostic "Canada" rule was invented',
    (docRules ?? []).filter((r) => r.province === null).length === 0
  );

  // ---- no test residue ----
  const { data: strays } = await admin
    .from('regulated_towing_zones')
    .select('id')
    .or('jurisdiction.eq.RLS integration test,jurisdiction.eq.Manual verification fixture');
  check('no test zone is left in the database', (strays ?? []).length === 0);
  const { data: strayCo } = await admin.from('companies').select('id').ilike('name', 'RLS %');
  check('no test company is left in the database', (strayCo ?? []).length === 0);
}

main()
  .then(() => {
    console.log('\nPhase 6.1 verification:\n');
    let ok = true;
    for (const r of results) {
      console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}${!r.pass && r.detail ? ` — ${r.detail}` : ''}`);
      if (!r.pass) ok = false;
    }
    console.log('');
    if (!ok) {
      console.error('FAILED — Phase 6.1 regulatory data is not in the expected state.');
      process.exit(1);
    }
    console.log(`All ${results.length} Phase 6.1 checks passed.`);
  })
  .catch((err) => {
    console.error('Verification crashed:', err);
    process.exit(1);
  });
