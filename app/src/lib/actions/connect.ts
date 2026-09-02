'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  createAccountLink,
  createConnectAccount,
  isConnectAvailable,
  isSandbox,
  retrieveConnectAccount,
  summariseAccount,
} from '@/lib/stripe/connect';
import { isStripeConfigured } from '@/lib/stripe/server';
import type { Company } from '@/lib/supabase/types';

// Stripe Connect onboarding for a company. Sandbox only — every path here
// goes through assertSandbox() inside lib/stripe/connect.ts, which throws on a
// live key.
//
// TWO TRUST BOUNDARIES, BOTH DELIBERATE
//  * Authorization is checked here, in server code, because Stripe calls are
//    not RLS-protected: RLS governs our tables, not somebody else's API. Only
//    a company's owner or admin may start onboarding for it.
//  * The resulting state is written with the service role, because the 0034
//    trigger forbids a company from writing its own Connect flags. A company
//    that could set its own payouts_enabled would not need to onboard.

export interface ConnectAvailability {
  stripeConfigured: boolean;
  sandbox: boolean;
  available: boolean;
  reason: string | null;
}

export async function getConnectAvailability(): Promise<ConnectAvailability> {
  const stripeConfigured = isStripeConfigured();
  const sandbox = isSandbox();
  return {
    stripeConfigured,
    sandbox,
    available: isConnectAvailable(),
    reason: !stripeConfigured
      ? 'stripe_not_configured'
      : !sandbox
        ? 'live_mode_refused'
        : null,
  };
}

async function assertCompanyManager(companyId: string): Promise<void> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('is_company_owner_or_admin' as never, {
    p_company_id: companyId,
  } as never);
  if (error) throw error;
  if (data !== true) {
    throw new Error('Only a company owner or admin can manage its Stripe account.');
  }
}

async function baseUrl(): Promise<string> {
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000';
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}

/**
 * Create the account if there isn't one, then hand back a fresh Account Link.
 *
 * The link is generated per click and never stored: Stripe's account links are
 * single-use and expire quickly, so a cached one is a broken door. The account
 * itself is created idempotently, so a double click cannot produce two.
 */
export async function startConnectOnboarding(companyId: string): Promise<{ url: string }> {
  await assertCompanyManager(companyId);

  const admin = createAdminClient();
  const { data: company, error } = await admin
    .from('companies')
    .select('*')
    .eq('id', companyId)
    .single();
  if (error) throw error;

  let accountId = (company as Company).stripe_account_id;

  if (!accountId) {
    const account = await createConnectAccount({
      companyId,
      companyName: (company as Company).display_name || (company as Company).name,
      email: (company as Company).email,
    });
    accountId = account.id;
    const snapshot = summariseAccount(account);
    await admin
      .from('companies')
      .update({
        stripe_account_id: accountId,
        connect_status: snapshot.status,
        connect_charges_enabled: snapshot.chargesEnabled,
        connect_payouts_enabled: snapshot.payoutsEnabled,
        connect_requirements_due: snapshot.requirementsDue,
        connect_disabled_reason: snapshot.disabledReason,
        connect_updated_at: new Date().toISOString(),
      })
      .eq('id', companyId);
  }

  const root = await baseUrl();
  const link = await createAccountLink({
    accountId,
    // Stripe sends the user here when the link expired before they finished.
    refreshUrl: `${root}/dashboard/business?connect=refresh`,
    // ...and here when they come back, finished or not. Stripe does not
    // promise the second means success, which is why the page re-reads the
    // account rather than trusting the redirect.
    returnUrl: `${root}/dashboard/business?connect=return`,
  });

  revalidatePath('/dashboard/business');
  return { url: link.url };
}

/**
 * Re-read the account from Stripe and store what it says.
 *
 * Called when the company comes back from onboarding and from the admin
 * screen. Never trusts the redirect: "returned from Stripe" and "can be paid"
 * are different facts, and only the account object knows the second.
 */
export async function refreshConnectStatus(companyId: string): Promise<void> {
  await assertCompanyManager(companyId);
  const admin = createAdminClient();
  const { data: company } = await admin
    .from('companies')
    .select('stripe_account_id')
    .eq('id', companyId)
    .single();

  const accountId = (company as { stripe_account_id: string | null } | null)?.stripe_account_id;
  if (!accountId) return;

  const account = await retrieveConnectAccount(accountId);
  const snapshot = summariseAccount(account);

  await admin
    .from('companies')
    .update({
      connect_status: snapshot.status,
      connect_charges_enabled: snapshot.chargesEnabled,
      connect_payouts_enabled: snapshot.payoutsEnabled,
      connect_requirements_due: snapshot.requirementsDue,
      connect_disabled_reason: snapshot.disabledReason,
      connect_updated_at: new Date().toISOString(),
    })
    .eq('id', companyId);

  revalidatePath('/dashboard/business');
}
