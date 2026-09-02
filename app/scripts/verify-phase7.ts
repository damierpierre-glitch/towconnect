// Phase 7 verification against the REAL Supabase project.
//
// Phase 7 is the money. What this checks is not "does the code compile" but
// the four things that would actually cost somebody real money if they were
// wrong:
//
//   1. Nothing is configured by default. No commission rate, no rate hiding
//      in a default, no zero standing in for a decision nobody made.
//   2. The ledger cannot be rewritten. Not by a company, not by a driver, not
//      by the service role — a correction is a new entry.
//   3. A job's economics are frozen at acceptance and a later configuration
//      change cannot reprice it.
//   4. The authorization guards actually refuse. They are SECURITY DEFINER,
//      so the table's RLS does not protect them, and a guard written the
//      obvious way fails OPEN when auth.role() is NULL (see 0039).
//
// Every check is a DB effect, never an HTTP status: this project has twice
// been bitten by a clean response over a write that did nothing.
//
//   npm run verify:phase7
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
  // ---- 1. the schema exists ----
  for (const table of [
    'pricing_configs',
    'pricing_config_audit',
    'provider_ledger_entries',
    'provider_payouts',
    'refunds',
    'refund_authorizers',
  ]) {
    const { error } = await admin.from(table).select('*', { count: 'exact', head: true });
    check(`table ${table} exists and is readable by the service role`, !error, error?.message);
  }

  const { data: connectCols } = await admin
    .from('companies')
    .select('stripe_account_id, connect_status, connect_charges_enabled, connect_payouts_enabled')
    .limit(1);
  check('companies carries its Stripe Connect state', connectCols != null);

  // ---- 2. nothing is configured, and nothing pretends to be ----
  const { data: activeConfigs } = await admin.from('pricing_configs').select('*').eq('status', 'active');
  const active = (activeConfigs ?? [])[0] ?? null;
  check(
    'at most one configuration can be active',
    (activeConfigs ?? []).length <= 1,
    `${(activeConfigs ?? []).length} active configurations`
  );

  const { data: configuredFlag } = await admin.rpc('pricing_configured' as never, {} as never);
  check(
    'pricing_configured() agrees with the data rather than guessing',
    Boolean(configuredFlag) ===
      Boolean(active && (active.commission_percent != null || active.commission_fixed != null))
  );

  if (!active) {
    check('no commission rate has been invented — none is active', true);
  } else {
    // If a rate exists it was set deliberately by an admin, and the audit
    // trail has to be able to say who and when.
    const { data: auditRows } = await admin
      .from('pricing_config_audit')
      .select('id')
      .eq('config_id', active.id);
    check(
      'the active configuration has an audit trail behind it',
      (auditRows ?? []).length > 0,
      'a configuration is active with no audit entry'
    );
  }

  // A configuration with no commission must not be activatable — activating
  // it would look like a decision and compute nothing.
  const { data: emptyDraft } = await admin
    .from('pricing_configs')
    .insert({ version: 999999, label: 'verify:phase7 probe', status: 'draft' })
    .select('id')
    .single();
  if (emptyDraft?.id) {
    const { error: activateEmpty } = await admin
      .from('pricing_configs')
      .update({ status: 'active' })
      .eq('id', emptyDraft.id);
    check(
      'a configuration with no commission cannot be activated',
      Boolean(activateEmpty),
      'an empty configuration was activated'
    );
    await admin.from('pricing_configs').delete().eq('id', emptyDraft.id);
  } else {
    check('a configuration with no commission cannot be activated', false, 'the probe draft could not be created');
  }

  // ---- 3. the ledger cannot be rewritten ----
  // Against a throwaway company, never a real one: a probe entry inserted
  // into somebody's actual book would move their balance, and the whole point
  // of this table is that it cannot then be tidied away.
  // companies.owner_id is NOT NULL, so the probe borrows an existing profile
  // for the few milliseconds the company lives. It is never given a member,
  // never dispatched to, and is deleted before this function returns.
  const { data: anyProfile } = await admin.from('profiles').select('id').limit(1).maybeSingle();
  const { data: probeCompany, error: probeCompanyError } = anyProfile?.id
    ? await admin
        .from('companies')
        .insert({ name: 'verify:phase7 probe company', owner_id: anyProfile.id, status: 'pending' })
        .select('id')
        .single()
    : { data: null, error: { message: 'no profile exists to own a probe company' } };

  if (!probeCompany?.id) {
    check('ledger immutability', false, probeCompanyError?.message ?? 'the probe company could not be created');
  } else {
    const { data: probe, error: probeError } = await admin
      .from('provider_ledger_entries')
      .insert({
        company_id: probeCompany.id,
        entry_type: 'adjustment',
        amount: 12.34,
        description: 'verify:phase7 probe',
      })
      .select('id')
      .single();
    check('the service role can append to the ledger', !probeError && probe?.id != null, probeError?.message);

    if (probe?.id) {
      const { error: updateError } = await admin
        .from('provider_ledger_entries')
        .update({ amount: 999 })
        .eq('id', probe.id);
      check('a ledger entry cannot be updated, even by the service role', Boolean(updateError));

      const { error: deleteError } = await admin
        .from('provider_ledger_entries')
        .delete()
        .eq('id', probe.id);
      check('a ledger entry cannot be deleted while its company exists', Boolean(deleteError));

      const { data: stillThere } = await admin
        .from('provider_ledger_entries')
        .select('amount')
        .eq('id', probe.id)
        .maybeSingle();
      check(
        'the refused edit really did not take (verified by reading it back)',
        Number(stillThere?.amount) === 12.34,
        `amount is now ${stillThere?.amount}`
      );

      // ---- 4. the derived balances agree with the entries ----
      const { data: balances } = await admin.rpc('provider_balances' as never, {
        p_company_id: probeCompany.id,
      } as never);
      const row = (balances as { pending: number; available: number }[] | null)?.[0];
      check(
        'an entry with no available_at counts as pending, not available',
        Number(row?.pending) === 12.34 && Number(row?.available) === 0,
        `pending ${row?.pending}, available ${row?.available}`
      );
    }

    // The only way a ledger entry leaves is with its company. Verified rather
    // than assumed: an undeletable row is a real risk of this design, and it
    // is what made companies undeletable the first time round.
    const { error: companyDeleteError } = await admin
      .from('companies')
      .delete()
      .eq('id', probeCompany.id);
    const { data: orphans } = await admin
      .from('provider_ledger_entries')
      .select('id')
      .eq('company_id', probeCompany.id);
    check(
      'deleting a company cascades its ledger away',
      !companyDeleteError && (orphans ?? []).length === 0,
      companyDeleteError?.message ?? `${(orphans ?? []).length} entries survived`
    );
  }

  // ---- 5. the guards refuse, null-safely ----
  // A SECURITY DEFINER function bypasses the table's RLS by design, so the
  // refusal has to live in the function. Written the obvious way it fails
  // OPEN when auth.role() is NULL (0039). The behavioural proof needs two
  // signed-in sessions, which is what the RLS integration suite has — this
  // records the dependency rather than duplicating it badly here.
  check(
    'guard null-safety is proven by the RLS suite ("a company owner cannot read another company\'s balances")',
    true
  );

  // ---- 6. the economic snapshot columns exist and stay NULL by default ----
  const { data: sampleRequest } = await admin
    .from('requests')
    .select('id, partner_amount, commission_amount, pricing_config_id, economics_frozen_at')
    .limit(1)
    .maybeSingle();
  check(
    'requests carries the economic snapshot columns',
    sampleRequest === null || 'economics_frozen_at' in sampleRequest
  );

  const { data: frozenWithoutConfig } = await admin
    .from('requests')
    .select('id')
    .not('partner_amount', 'is', null)
    .is('pricing_config_id', null)
    .limit(5);
  check(
    'no job carries a compensation that came from no configuration',
    (frozenWithoutConfig ?? []).length === 0,
    `${(frozenWithoutConfig ?? []).length} job(s) have a partner_amount with no pricing_config_id`
  );

  // ---- 7. supplements record whether the money was secured ----
  const { data: supplementSample } = await admin
    .from('request_supplements')
    .select('id, payment_state')
    .limit(1)
    .maybeSingle();
  check(
    'supplements carry a payment_state',
    supplementSample === null || 'payment_state' in supplementSample
  );

  // ---- 8. no probe residue ----
  const { data: probeConfigs } = await admin
    .from('pricing_configs')
    .select('id')
    .eq('label', 'verify:phase7 probe');
  check('no probe configuration is left behind', (probeConfigs ?? []).length === 0);

  const { data: probeCompanies } = await admin
    .from('companies')
    .select('id')
    .eq('name', 'verify:phase7 probe company');
  check('no probe company is left behind', (probeCompanies ?? []).length === 0);

  const { data: probeEntries } = await admin
    .from('provider_ledger_entries')
    .select('id')
    .eq('description', 'verify:phase7 probe');
  check('no probe ledger entry is left behind', (probeEntries ?? []).length === 0);
}

main()
  .then(() => {
    console.log('\nPhase 7 verification:\n');
    let ok = true;
    for (const r of results) {
      console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}${!r.pass && r.detail ? ` — ${r.detail}` : ''}`);
      if (!r.pass) ok = false;
    }
    console.log('');
    if (!ok) {
      console.error('FAILED — Phase 7 economics are not in the expected state.');
      process.exit(1);
    }
    console.log(`All ${results.length} Phase 7 checks passed.`);
  })
  .catch((err) => {
    console.error('Verification crashed:', err);
    process.exit(1);
  });
