import 'server-only';
import type Stripe from 'stripe';
import { getStripe, isStripeConfigured } from './server';
import { assertSandbox, isSandbox } from './mode';

// Re-exported so callers keep importing the guard from the module they
// already use; the implementation lives in ./mode so it can be tested.
export { LiveModeRefused, stripeKeyMode, isSandbox, assertSandbox } from './mode';

// Stripe Connect, sandbox only.
//
// THE GUARD IS THE POINT
// Every function in this file calls assertSandbox() before it touches Stripe.
// A live secret key makes them all throw. That is deliberate and it is not a
// developer convenience: Connect onboarding creates real accounts and payouts
// move real money, and this phase was scoped to build the machinery, not to
// run it. The guard is what makes "sandbox only" a property of the code rather
// than a note in a report.
//
// Stripe's own key prefixes are the signal. `sk_test_` is a test-mode key;
// `sk_live_` is not. Anything else — a restricted key, a malformed value — is
// refused too, because a key we cannot classify is a key we should not spend
// money with.

export function isConnectAvailable(): boolean {
  return isStripeConfigured() && isSandbox();
}

/**
 * Create a Connect account for a company.
 *
 * Express accounts, so onboarding happens on Stripe's hosted flow: TowConnect
 * never sees a bank account number, a card, or a KYC document. That is a
 * deliberate architectural choice and not only a convenience — data we never
 * receive cannot leak from us.
 */
export async function createConnectAccount(input: {
  companyName: string;
  email?: string | null;
  companyId: string;
}): Promise<Stripe.Account> {
  assertSandbox();
  const stripe = getStripe();
  return stripe.accounts.create(
    {
      type: 'express',
      country: 'CA',
      email: input.email ?? undefined,
      business_type: 'company',
      company: { name: input.companyName },
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      metadata: { towconnect_company_id: input.companyId },
    },
    // Two clicks on "connect" must not create two accounts.
    { idempotencyKey: `connect-account-${input.companyId}` }
  );
}

/**
 * A one-time link into Stripe's hosted onboarding.
 *
 * Generated server-side, every time, and never stored: account links are
 * single-use and short-lived by design, so caching one would hand somebody an
 * expired door. `refresh_url` is where Stripe sends the user when the link has
 * expired before they finished; `return_url` is where it sends them when they
 * come back, finished or not — Stripe does not promise the second means
 * success, which is why the caller re-reads the account rather than believing
 * the redirect.
 */
export async function createAccountLink(input: {
  accountId: string;
  refreshUrl: string;
  returnUrl: string;
}): Promise<Stripe.AccountLink> {
  assertSandbox();
  const stripe = getStripe();
  return stripe.accountLinks.create({
    account: input.accountId,
    refresh_url: input.refreshUrl,
    return_url: input.returnUrl,
    type: 'account_onboarding',
  });
}

export async function retrieveConnectAccount(accountId: string): Promise<Stripe.Account> {
  assertSandbox();
  return getStripe().accounts.retrieve(accountId);
}

export type ConnectStatus = 'not_started' | 'pending' | 'restricted' | 'enabled' | 'disabled';

export interface ConnectSnapshot {
  status: ConnectStatus;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  requirementsDue: string[];
  disabledReason: string | null;
}

/**
 * Turn a Stripe account into the five facts the product needs.
 *
 * Read from Stripe's own booleans rather than inferred from onboarding having
 * been "completed": a company can finish the form and still be restricted,
 * and a company can be enabled with requirements due later. Believing the
 * redirect instead of the account is how a partner ends up thinking they can
 * be paid when they cannot.
 */
export function summariseAccount(account: Stripe.Account): ConnectSnapshot {
  const requirements = account.requirements;
  const due = [
    ...(requirements?.currently_due ?? []),
    ...(requirements?.past_due ?? []),
  ];
  const disabledReason = requirements?.disabled_reason ?? null;

  let status: ConnectStatus;
  if (account.charges_enabled && account.payouts_enabled) {
    status = 'enabled';
  } else if (disabledReason) {
    status = requirements?.past_due?.length ? 'restricted' : 'disabled';
  } else {
    status = 'pending';
  }

  return {
    status,
    chargesEnabled: Boolean(account.charges_enabled),
    payoutsEnabled: Boolean(account.payouts_enabled),
    requirementsDue: [...new Set(due)],
    disabledReason,
  };
}
