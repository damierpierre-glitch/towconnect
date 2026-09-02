// Phase 8.1 — set up, or inspect, the Connect Express onboarding fixture.
//
// WHY THIS EXISTS AS A SCRIPT
// Completing Express onboarding is a human action by design: Stripe collects
// identity and bank details on its own hosted form, and TowConnect never sees
// them. So the machine part is split from the human part —
//
//   npx tsx scripts/connect-onboarding-fixture.ts setup    -> create + print link
//   npx tsx scripts/connect-onboarding-fixture.ts status   -> re-read from Stripe
//   npx tsx scripts/connect-onboarding-fixture.ts link     -> a fresh Account Link
//   npx tsx scripts/connect-onboarding-fixture.ts teardown -> remove the fixture
//
// — and nothing here ever types a bank account number or an identity document.
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY!;

if (!STRIPE_SECRET_KEY?.startsWith('sk_test_') && !STRIPE_SECRET_KEY?.startsWith('rk_test_')) {
  console.error('Refusing to run: STRIPE_SECRET_KEY is not a test-mode key.');
  process.exit(1);
}

const stripe = new Stripe(STRIPE_SECRET_KEY);
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const FIXTURE_COMPANY = 'Phase 8.1 Connect Fixture';
const RETURN_BASE = process.env.CONNECT_RETURN_BASE ?? 'http://localhost:3000';

async function findCompany() {
  const { data } = await admin
    .from('companies')
    .select('id, name, stripe_account_id, connect_status, connect_charges_enabled, connect_payouts_enabled, connect_requirements_due, connect_disabled_reason')
    .eq('name', FIXTURE_COMPANY)
    .maybeSingle();
  return data;
}

async function setup() {
  let company = await findCompany();

  if (!company) {
    // The company needs an owner; borrow the platform admin rather than
    // creating a throwaway account that would outlive the fixture.
    const { data: owner } = await admin
      .from('profiles')
      .select('id')
      .eq('role', 'admin')
      .limit(1)
      .maybeSingle();
    if (!owner?.id) throw new Error('No admin profile exists to own the fixture company.');

    const { data: created, error } = await admin
      .from('companies')
      .insert({ name: FIXTURE_COMPANY, owner_id: owner.id, status: 'active', province: 'QC' })
      .select('id, name, stripe_account_id')
      .single();
    if (error) throw error;
    company = { ...created, connect_status: 'not_started', connect_charges_enabled: false, connect_payouts_enabled: false, connect_requirements_due: [], connect_disabled_reason: null };
    console.log(`company created: ${company.id}`);
  } else {
    console.log(`company reused: ${company.id}`);
  }

  let accountId = company.stripe_account_id;
  if (!accountId) {
    const account = await stripe.accounts.create({
      type: 'express',
      country: 'CA',
      capabilities: { transfers: { requested: true } },
      metadata: { towconnect_company_id: company.id, towconnect_fixture: 'phase-8.1' },
    });
    accountId = account.id;
    await admin
      .from('companies')
      .update({
        stripe_account_id: accountId,
        connect_status: 'pending',
        connect_charges_enabled: account.charges_enabled,
        connect_payouts_enabled: account.payouts_enabled,
        connect_requirements_due: account.requirements?.currently_due ?? [],
        connect_updated_at: new Date().toISOString(),
      })
      .eq('id', company.id);
    console.log(`connect account created: ${accountId}`);
  } else {
    console.log(`connect account reused: ${accountId}`);
  }

  await printLink(accountId);
  await status();
}

async function printLink(accountId?: string) {
  const company = await findCompany();
  const id = accountId ?? company?.stripe_account_id;
  if (!id) throw new Error('No Connect account yet — run `setup` first.');

  // Account Links are single-use and expire quickly, so one is generated on
  // demand rather than stored anywhere.
  const link = await stripe.accountLinks.create({
    account: id,
    refresh_url: `${RETURN_BASE}/dashboard/business?connect=refresh`,
    return_url: `${RETURN_BASE}/dashboard/business?connect=return`,
    type: 'account_onboarding',
  });
  console.log('\nOPEN THIS LINK TO COMPLETE ONBOARDING (expires in a few minutes):');
  console.log(link.url);
  console.log('');
}

async function status() {
  const company = await findCompany();
  if (!company?.stripe_account_id) {
    console.log('No fixture Connect account exists yet.');
    return;
  }

  const account = await stripe.accounts.retrieve(company.stripe_account_id);

  // Stripe is the source of truth; our columns are a cache of its answers.
  await admin
    .from('companies')
    .update({
      connect_status: account.charges_enabled && account.payouts_enabled ? 'enabled' : 'pending',
      connect_charges_enabled: account.charges_enabled,
      connect_payouts_enabled: account.payouts_enabled,
      connect_requirements_due: account.requirements?.currently_due ?? [],
      connect_disabled_reason: account.requirements?.disabled_reason ?? null,
      connect_updated_at: new Date().toISOString(),
    })
    .eq('id', company.id);

  const refreshed = await findCompany();
  console.log('\nSTRIPE SAYS');
  console.log(`  account            ${account.id} (${account.type})`);
  console.log(`  charges_enabled    ${account.charges_enabled}`);
  console.log(`  payouts_enabled    ${account.payouts_enabled}`);
  console.log(`  currently_due      ${JSON.stringify(account.requirements?.currently_due ?? [])}`);
  console.log(`  disabled_reason    ${account.requirements?.disabled_reason ?? 'none'}`);
  console.log('\nOUR DATABASE SAYS');
  console.log(`  connect_status     ${refreshed?.connect_status}`);
  console.log(`  charges_enabled    ${refreshed?.connect_charges_enabled}`);
  console.log(`  payouts_enabled    ${refreshed?.connect_payouts_enabled}`);
  console.log(`  requirements_due   ${JSON.stringify(refreshed?.connect_requirements_due ?? [])}`);
  const inSync =
    refreshed?.connect_charges_enabled === account.charges_enabled &&
    refreshed?.connect_payouts_enabled === account.payouts_enabled;
  console.log(`\n  in sync with Stripe: ${inSync ? 'YES' : 'NO'}`);
  console.log(
    account.payouts_enabled
      ? '\n  Onboarding is COMPLETE. A sandbox transfer can now be attempted.'
      : '\n  Onboarding is INCOMPLETE. The link above must be completed by a human.'
  );
}

async function teardown() {
  const company = await findCompany();
  if (!company) {
    console.log('Nothing to remove.');
    return;
  }
  if (company.stripe_account_id) {
    try {
      await stripe.accounts.del(company.stripe_account_id);
      console.log(`deleted connect account ${company.stripe_account_id}`);
    } catch (e) {
      console.log(`could not delete the connect account: ${(e as Error).message.slice(0, 140)}`);
    }
  }
  await admin.from('provider_payouts').delete().eq('company_id', company.id);
  await admin.from('company_members').delete().eq('company_id', company.id);
  const { error } = await admin.from('companies').delete().eq('id', company.id);
  console.log(error ? `company delete failed: ${error.message}` : 'fixture company removed');
}

const command = process.argv[2] ?? 'status';
const run =
  command === 'setup'
    ? setup
    : command === 'link'
      ? () => printLink()
      : command === 'teardown'
        ? teardown
        : status;

run().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
