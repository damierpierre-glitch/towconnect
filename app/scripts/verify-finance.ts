// Financial state verification against the REAL database.
//
// Where finance-e2e.ts *performs* a cycle and is slow and destructive, this is
// cheap, read-mostly and safe to run any time — including after a deploy or a
// support incident. It answers one question: does the money in this database
// still add up?
//
// Every assertion is a DB effect. Nothing here trusts an HTTP status.
//
//   npm run verify:finance
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
const money = (v: unknown) => Number(v ?? 0);
const near = (a: number, b: number, tol = 0.005) => Math.abs(a - b) < tol;

async function main() {
  // ---- 1. no commission is configured -------------------------------
  // Stated first because it is the fact most likely to be quietly untrue
  // after somebody experiments, and the one with the largest consequence.
  const { data: active } = await admin.from('pricing_configs').select('id, label, version').eq('status', 'active');
  check(
    'no economic configuration is active',
    (active ?? []).length === 0,
    (active ?? []).map((c) => `v${c.version} ${c.label}`).join(', ')
  );
  const { data: configured } = await admin.rpc('pricing_configured' as never, {} as never);
  check('pricing_configured() is false', configured === false, String(configured));

  const { data: fixtures } = await admin.from('pricing_configs').select('id, status, label').ilike('label', 'FIXTURE%');
  check(
    'every test fixture configuration is archived',
    (fixtures ?? []).every((c) => c.status === 'archived'),
    (fixtures ?? []).filter((c) => c.status !== 'archived').map((c) => c.label).join(', ')
  );

  // ---- 2. the economic identity holds on every priced job ------------
  const { data: priced } = await admin
    .from('requests')
    .select('id, price_estimate, partner_amount, commission_amount, payment_processing_cost')
    .not('partner_amount', 'is', null);

  let worstDrift = 0;
  let worstId = '';
  for (const r of priced ?? []) {
    const sum = money(r.partner_amount) + money(r.commission_amount) + money(r.payment_processing_cost);
    const drift = Math.abs(sum - money(r.price_estimate));
    if (drift > worstDrift) {
      worstDrift = drift;
      worstId = r.id;
    }
  }
  check(
    `customer price = provider + TowConnect + processing, on all ${(priced ?? []).length} priced job(s)`,
    worstDrift < 0.005,
    worstDrift > 0 ? `worst drift $${worstDrift.toFixed(4)} on ${worstId}` : undefined
  );

  // ---- 3. nothing was priced without a configuration -----------------
  const { data: orphanPriced } = await admin
    .from('requests')
    .select('id')
    .not('partner_amount', 'is', null)
    .is('pricing_config_id', null);
  check(
    'no job carries compensation that came from no configuration',
    (orphanPriced ?? []).length === 0,
    `${(orphanPriced ?? []).length} job(s)`
  );

  const { data: frozenUnaccepted } = await admin
    .from('requests')
    .select('id')
    .not('economics_frozen_at', 'is', null)
    .is('driver_id', null);
  check(
    'no job froze its economics without a driver to owe them to',
    (frozenUnaccepted ?? []).length === 0,
    `${(frozenUnaccepted ?? []).length} job(s)`
  );

  // ---- 4. the ledger agrees with the jobs it came from ---------------
  const { data: entries } = await admin
    .from('provider_ledger_entries')
    .select('id, company_id, request_id, entry_type, amount, available_at');

  const earningsByRequest = new Map<string, number>();
  for (const e of entries ?? []) {
    if (e.entry_type !== 'earning' || !e.request_id) continue;
    earningsByRequest.set(e.request_id, (earningsByRequest.get(e.request_id) ?? 0) + 1);
  }
  check(
    'no job was credited twice',
    [...earningsByRequest.values()].every((n) => n === 1),
    [...earningsByRequest.entries()].filter(([, n]) => n > 1).map(([id]) => id).join(', ')
  );

  const pricedById = new Map((priced ?? []).map((r) => [r.id, r]));
  const mismatched: string[] = [];
  for (const e of entries ?? []) {
    if (e.entry_type !== 'earning' || !e.request_id) continue;
    const request = pricedById.get(e.request_id);
    if (request && !near(money(e.amount), money(request.partner_amount))) {
      mismatched.push(`${e.request_id}: ledger ${e.amount} vs frozen ${request.partner_amount}`);
    }
  }
  check('every earning equals the compensation frozen on its job', mismatched.length === 0, mismatched.join('; '));

  // ---- 5. balances are the sum of their entries ----------------------
  const companyIds = [...new Set((entries ?? []).map((e) => e.company_id))];
  const balanceProblems: string[] = [];
  for (const companyId of companyIds) {
    const { data: balances } = await admin.rpc('provider_balances' as never, {
      p_company_id: companyId,
    } as never);
    const row = (balances as { pending: number; available: number; paid_total: number }[] | null)?.[0];
    const own = (entries ?? []).filter((e) => e.company_id === companyId);
    const expectedPending = own
      .filter((e) => !e.available_at || new Date(e.available_at).getTime() > Date.now())
      .reduce((s, e) => s + money(e.amount), 0);
    const expectedAvailable = own
      .filter((e) => e.available_at && new Date(e.available_at).getTime() <= Date.now())
      .reduce((s, e) => s + money(e.amount), 0);
    if (!row || !near(money(row.pending), expectedPending) || !near(money(row.available), expectedAvailable)) {
      balanceProblems.push(
        `${companyId}: pending ${row?.pending}/${expectedPending.toFixed(2)}, available ${row?.available}/${expectedAvailable.toFixed(2)}`
      );
    }
  }
  check(
    `provider_balances() reconciles with the ledger for all ${companyIds.length} company/ies`,
    balanceProblems.length === 0,
    balanceProblems.join('; ')
  );

  // ---- 6. payouts never exceed what was earned -----------------------
  const overdrawn: string[] = [];
  for (const companyId of companyIds) {
    const own = (entries ?? []).filter((e) => e.company_id === companyId);
    const credited = own
      .filter((e) => ['earning', 'supplement', 'adjustment', 'refund_reversal'].includes(e.entry_type))
      .reduce((s, e) => s + money(e.amount), 0);
    const paidOut = -own.filter((e) => e.entry_type === 'payout').reduce((s, e) => s + money(e.amount), 0);
    const reversed = own.filter((e) => e.entry_type === 'payout_reversal').reduce((s, e) => s + money(e.amount), 0);
    if (paidOut - reversed > credited + 0.005) {
      overdrawn.push(`${companyId}: paid ${(paidOut - reversed).toFixed(2)} of ${credited.toFixed(2)} earned`);
    }
  }
  check('no company was paid more than it earned', overdrawn.length === 0, overdrawn.join('; '));

  // ---- 7. refunds are reflected on both sides -----------------------
  const { data: refunds } = await admin.from('refunds').select('request_id, amount, status');
  const succeeded = (refunds ?? []).filter((r) => r.status === 'succeeded');
  const missingReversal: string[] = [];
  for (const refund of succeeded) {
    const hasEarning = (entries ?? []).some(
      (e) => e.request_id === refund.request_id && e.entry_type === 'earning'
    );
    if (!hasEarning) continue;
    const hasReversal = (entries ?? []).some(
      (e) => e.request_id === refund.request_id && e.entry_type === 'refund_reversal'
    );
    if (!hasReversal) missingReversal.push(refund.request_id);
  }
  check(
    `every succeeded refund on a credited job has a reversal (${succeeded.length} refund(s))`,
    missingReversal.length === 0,
    missingReversal.join(', ')
  );

  const overRefunded: string[] = [];
  for (const requestId of new Set(succeeded.map((r) => r.request_id))) {
    const refunded = succeeded.filter((r) => r.request_id === requestId).reduce((s, r) => s + money(r.amount), 0);
    const { data: payment } = await admin
      .from('payments')
      .select('amount')
      .eq('request_id', requestId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (payment && refunded > money(payment.amount) + 0.005) {
      overRefunded.push(`${requestId}: refunded ${refunded.toFixed(2)} of ${payment.amount}`);
    }
  }
  check('no payment was refunded for more than it was worth', overRefunded.length === 0, overRefunded.join('; '));

  // ---- 8. an approved supplement never credits money that was not taken ----
  const { data: supplements } = await admin
    .from('request_supplements')
    .select('request_id, status, payment_state, amount');
  const creditedButUncollected: string[] = [];
  for (const supplement of supplements ?? []) {
    if (supplement.status !== 'approved' || supplement.payment_state !== 'uncollected') continue;
    const hasSupplementEntry = (entries ?? []).some(
      (e) => e.request_id === supplement.request_id && e.entry_type === 'supplement'
    );
    if (hasSupplementEntry) creditedButUncollected.push(supplement.request_id);
  }
  check(
    'no uncollected supplement credited a provider',
    creditedButUncollected.length === 0,
    creditedButUncollected.join(', ')
  );
}

main()
  .then(() => {
    console.log('\nFinancial reconciliation:\n');
    let allPass = true;
    for (const r of results) {
      console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}${!r.pass && r.detail ? ` — ${r.detail}` : ''}`);
      if (!r.pass) allPass = false;
    }
    console.log('');
    if (!allPass) {
      console.error('FAILED — the financial state does not reconcile.');
      process.exit(1);
    }
    console.log(`All ${results.length} financial checks passed.`);
  })
  .catch((err) => {
    console.error('Verification crashed:', err);
    process.exit(1);
  });
