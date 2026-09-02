'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getStripe, isStripeConfigured } from '@/lib/stripe/server';
import { assertSandbox } from '@/lib/stripe/connect';
import { settle, settleCancellation, type EconomicConfig } from '@/lib/economics';
import type {
  PricingConfig,
  ProviderBalances,
  ProviderLedgerEntry,
  ProviderPayout,
  Refund,
} from '@/lib/supabase/types';

// Refunds, the provider ledger, and payouts.
//
// AUTHORIZATION IS CHECKED IN CODE HERE, NOT ONLY BY RLS
// The writes below go through the service role, because `refunds`,
// `provider_ledger_entries` and `provider_payouts` deliberately have no INSERT
// policy for anybody — a browser session must not be able to move money, and
// the surest way to guarantee that is for the capability not to exist. That
// makes the explicit is_refund_authorizer() / admin checks in this file the
// real gate, so each one is stated plainly rather than assumed.

async function assertRefundAuthorizer(): Promise<string> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { data, error } = await supabase.rpc('is_refund_authorizer' as never, {} as never);
  if (error) throw error;
  if (data !== true) {
    throw new Error('Only a platform admin can issue a refund.');
  }
  return user.id;
}

async function assertPlatformAdmin(): Promise<string> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (profile?.role !== 'admin') throw new Error('Admins only.');
  return user.id;
}

// ---------------------------------------------------------------- refunds

export async function listRefunds(requestId?: string): Promise<Refund[]> {
  const supabase = await createClient();
  let query = supabase.from('refunds').select('*').order('created_at', { ascending: false });
  if (requestId) query = query.eq('request_id', requestId);
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

/**
 * Issue a full or partial refund, in sandbox.
 *
 * The order matters: the row is written as 'pending' BEFORE Stripe is called,
 * so a refund that succeeds at Stripe and then fails to record leaves a
 * pending row somebody can see and reconcile, rather than money that moved
 * with no trace on our side. The opposite order loses refunds silently.
 */
export async function issueRefund(input: {
  requestId: string;
  amount: number;
  reason: string;
}): Promise<Refund> {
  const actorId = await assertRefundAuthorizer();
  if (!isStripeConfigured()) throw new Error('Stripe is not configured.');
  assertSandbox();

  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw new Error('A refund needs a positive amount.');
  }
  if (!input.reason.trim()) {
    throw new Error(
      "A refund needs a reason. An unexplained movement of somebody else's money is not acceptable."
    );
  }

  const admin = createAdminClient();

  const { data: payment } = await admin
    .from('payments')
    .select('id, stripe_payment_intent_id, amount, status')
    .eq('request_id', input.requestId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!payment?.stripe_payment_intent_id) {
    throw new Error('There is no captured payment on this request to refund.');
  }
  if (payment.status !== 'captured') {
    throw new Error(`This payment is ${payment.status}, not captured — there is nothing to refund yet.`);
  }

  const { data: alreadyRefunded } = await admin.rpc('request_refunded_total' as never, {
    p_request_id: input.requestId,
  } as never);
  const remaining = Number(payment.amount) - Number(alreadyRefunded ?? 0);
  if (input.amount > remaining + 0.005) {
    throw new Error(
      `Only $${remaining.toFixed(2)} of this payment is left to refund.`
    );
  }

  const { data: refund, error: insertError } = await admin
    .from('refunds')
    .insert({
      request_id: input.requestId,
      payment_id: payment.id,
      amount: Math.round(input.amount * 100) / 100,
      reason: input.reason.trim(),
      status: 'pending',
      created_by: actorId,
    })
    .select('*')
    .single();
  if (insertError) throw insertError;

  try {
    const stripe = getStripe();
    const stripeRefund = await stripe.refunds.create(
      {
        payment_intent: payment.stripe_payment_intent_id,
        amount: Math.round(input.amount * 100),
        metadata: { towconnect_refund_id: refund.id, reason: input.reason.slice(0, 400) },
      },
      { idempotencyKey: `refund-${refund.id}` }
    );

    await admin
      .from('refunds')
      .update({
        status: stripeRefund.status === 'succeeded' ? 'succeeded' : 'pending',
        stripe_refund_id: stripeRefund.id,
      })
      .eq('id', refund.id);

    if (stripeRefund.status === 'succeeded') {
      await reverseProviderEarningForRefund(input.requestId, input.amount, refund.id);
      const fullyRefunded = input.amount >= remaining - 0.005;
      if (fullyRefunded) {
        await admin.from('payments').update({ status: 'refunded' }).eq('id', payment.id);
      }
    }
  } catch (e) {
    await admin
      .from('refunds')
      .update({
        status: 'failed',
        failure_reason: e instanceof Error ? e.message.slice(0, 400) : 'stripe_refund_failed',
      })
      .eq('id', refund.id);
    throw e;
  }

  revalidatePath('/dashboard/admin/finance');
  const { data: final } = await admin.from('refunds').select('*').eq('id', refund.id).single();
  return final as Refund;
}

/**
 * Take back the provider's share of a refunded amount.
 *
 * A new negative entry, never an edit of the earning: the ledger refuses
 * UPDATE, and more importantly "we paid you $80, then the customer was
 * refunded $40, so $32 came back" is a story the ledger should be able to
 * tell. Rewriting the original earning would erase it.
 *
 * The provider's share of the refund is proportional to their share of the
 * job, which keeps the split honest in both directions: TowConnect gives back
 * its margin on the refunded portion too.
 */
async function reverseProviderEarningForRefund(
  requestId: string,
  refundAmount: number,
  refundId: string
): Promise<void> {
  const admin = createAdminClient();

  const { data: earning } = await admin
    .from('provider_ledger_entries')
    .select('id, company_id, driver_id, amount')
    .eq('request_id', requestId)
    .eq('entry_type', 'earning')
    .maybeSingle();
  if (!earning) return;

  const { data: request } = await admin
    .from('requests')
    .select('price_estimate')
    .eq('id', requestId)
    .single();

  const customerTotal = Number(request?.price_estimate ?? 0);
  if (customerTotal <= 0) return;

  const providerShare = Number(earning.amount) / customerTotal;
  const clawback = Math.round(refundAmount * providerShare * 100) / 100;
  if (clawback <= 0) return;

  await admin.from('provider_ledger_entries').insert({
    company_id: earning.company_id,
    driver_id: earning.driver_id,
    request_id: requestId,
    entry_type: 'refund_reversal',
    amount: -clawback,
    available_at: new Date().toISOString(),
    description: `Customer refunded $${refundAmount.toFixed(2)}; provider share returned`,
    metadata: { refund_id: refundId, provider_share: providerShare },
  } as never);
}

// ---------------------------------------------------------------- ledger

export async function listLedgerEntries(companyId: string, limit = 100): Promise<ProviderLedgerEntry[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('provider_ledger_entries')
    .select('*')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

export async function getProviderBalances(companyId: string): Promise<ProviderBalances> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('provider_balances' as never, {
    p_company_id: companyId,
  } as never);
  if (error) throw error;
  const row = (data as ProviderBalances[] | null)?.[0];
  return row ?? { pending: 0, available: 0, paid_total: 0, lifetime_earned: 0 };
}

function toEconomicConfig(row: PricingConfig | null | undefined): EconomicConfig | null {
  if (!row) return null;
  const num = (v: number | string | null) => (v == null ? null : Number(v));
  return {
    commissionPercent: num(row.commission_percent),
    commissionFixed: num(row.commission_fixed),
    commissionMin: num(row.commission_min),
    commissionMax: num(row.commission_max),
    providerMinimum: num(row.provider_minimum),
    paymentProcessingPercent: num(row.payment_processing_percent),
    paymentProcessingFixed: num(row.payment_processing_fixed),
  };
}

/**
 * What the provider should end up with once secured supplements are counted.
 *
 * Computed on the WHOLE job at its new total, not on the supplement alone.
 * Splitting a $20 supplement by itself would re-apply the per-job floors and
 * caps a second time — a $60 provider minimum would turn a $20 extra into
 * another $60. Recomputing the job and subtracting what is already credited
 * applies each floor exactly once, and makes the function safe to re-run.
 *
 * Only supplements whose money was actually secured count. An approved
 * supplement that could not be added to the authorization is a promise, and
 * crediting a promise is how a provider gets paid for cash that never came.
 */
async function providerTargetFor(request: {
  id: string;
  price_estimate: number | string | null;
  partner_amount: number | string | null;
  pricing_config_id: string | null;
}): Promise<number | null> {
  if (request.partner_amount == null) return null;
  const base = Number(request.partner_amount);
  if (!request.pricing_config_id) return base;

  const admin = createAdminClient();
  const { data: supplements } = await admin
    .from('request_supplements')
    .select('amount, payment_state')
    .eq('request_id', request.id)
    .eq('status', 'approved');

  const secured = (supplements ?? [])
    .filter((s) => s.payment_state === 'authorized' || s.payment_state === 'settled')
    .reduce((sum, s) => sum + Number(s.amount), 0);
  if (secured <= 0) return base;

  const { data: config } = await admin
    .from('pricing_configs')
    .select('*')
    .eq('id', request.pricing_config_id)
    .maybeSingle();

  const total = Number(request.price_estimate ?? 0) + secured;
  return settle(total, toEconomicConfig(config)).providerCompensation ?? base;
}

/**
 * Credit a completed job to the provider's ledger.
 *
 * Called after the capture attempt. Deliberately does nothing when the job
 * carries no frozen compensation: no economic configuration was active when
 * it was accepted, so there is no amount to credit, and inventing one
 * retroactively is exactly what the snapshot exists to prevent.
 *
 * `available_at` is decided here and never revised, because the ledger refuses
 * UPDATE. A job whose capture failed is earned but not payable, and
 * releaseHeldEarnings() below is what later makes it payable — by writing new
 * entries, not by editing these.
 */
export async function recordJobEarning(requestId: string): Promise<void> {
  const admin = createAdminClient();

  const { data: request } = await admin
    .from('requests')
    .select('id, driver_id, price_estimate, partner_amount, pricing_config_id, status')
    .eq('id', requestId)
    .maybeSingle();
  if (!request?.driver_id || request.partner_amount == null) return;
  if (request.status !== 'completed') return;

  const { data: companyIdRaw } = await admin.rpc('driver_company_id' as never, {
    p_profile_id: request.driver_id,
  } as never);
  const companyId = companyIdRaw as unknown as string | null;
  if (!companyId) return;

  const { data: payment } = await admin
    .from('payments')
    .select('status')
    .eq('request_id', requestId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const availableAt = payment?.status === 'captured' ? new Date().toISOString() : null;

  const base = Number(request.partner_amount);

  // The unique index refuses a second earning for the same job, which is what
  // makes this safe to replay. A conflict here is the expected outcome of a
  // retry, not a failure, so it must not stop the supplement below.
  await admin
    .from('provider_ledger_entries')
    .insert({
      company_id: companyId,
      driver_id: request.driver_id,
      request_id: requestId,
      entry_type: 'earning',
      amount: base,
      available_at: availableAt,
      description: 'Completed job',
    } as never);

  const target = await providerTargetFor(request);
  if (target == null) return;

  const { data: credited } = await admin
    .from('provider_ledger_entries')
    .select('amount')
    .eq('request_id', requestId)
    .in('entry_type', ['earning', 'supplement']);
  const already = (credited ?? []).reduce((sum, e) => sum + Number(e.amount), 0);

  const delta = Math.round((target - already) * 100) / 100;
  if (delta > 0.005) {
    await admin.from('provider_ledger_entries').insert({
      company_id: companyId,
      driver_id: request.driver_id,
      request_id: requestId,
      entry_type: 'supplement',
      amount: delta,
      available_at: availableAt,
      description: 'Approved supplements, provider share',
    } as never);
  }
}

/**
 * Make an earning payable after a capture that only succeeded later.
 *
 * The ledger cannot be edited, so availability is not flipped: the held entry
 * is cancelled by an equal negative entry and re-credited as an available one.
 * The balance ends up right and the history still says what happened, which is
 * the whole reason the table refuses UPDATE.
 */
export async function releaseHeldEarnings(requestId: string): Promise<void> {
  const admin = createAdminClient();

  const { data: held } = await admin
    .from('provider_ledger_entries')
    .select('*')
    .eq('request_id', requestId)
    .is('available_at', null);
  if (!held?.length) return;

  for (const entry of held) {
    await admin.from('provider_ledger_entries').insert([
      {
        company_id: entry.company_id,
        driver_id: entry.driver_id,
        request_id: requestId,
        entry_type: 'adjustment',
        amount: -Number(entry.amount),
        available_at: new Date().toISOString(),
        description: `Cancels held entry #${entry.id}`,
        metadata: { releases_entry_id: entry.id },
      },
      {
        company_id: entry.company_id,
        driver_id: entry.driver_id,
        request_id: requestId,
        entry_type: 'adjustment',
        amount: Number(entry.amount),
        available_at: new Date().toISOString(),
        description: 'Payment captured — earning released',
        metadata: { releases_entry_id: entry.id },
      },
    ] as never);
  }
}

/**
 * An approved supplement changes what the customer owes. Try to add it to the
 * hold we already have; say so plainly when we cannot.
 *
 * Stripe will not always let an existing authorization grow — the increment is
 * only available on eligible card authorizations, and an already-captured
 * payment cannot be increased at all. Rather than pretend, the supplement is
 * marked 'uncollected' with the reason, and nothing is credited for it.
 */
export async function settleApprovedSupplement(supplementId: string): Promise<void> {
  const admin = createAdminClient();

  const { data: supplement } = await admin
    .from('request_supplements')
    .select('*')
    .eq('id', supplementId)
    .maybeSingle();
  if (!supplement || supplement.status !== 'approved' || supplement.payment_state !== 'pending') return;

  const mark = async (state: string, note: string | null) => {
    await admin
      .from('request_supplements')
      .update({
        payment_state: state,
        payment_note: note,
        payment_settled_at: state === 'pending' ? null : new Date().toISOString(),
      } as never)
      .eq('id', supplementId);
  };

  if (!isStripeConfigured()) {
    await mark('uncollected', 'Stripe is not configured; this supplement must be collected separately.');
    return;
  }
  assertSandbox();

  const { data: request } = await admin
    .from('requests')
    .select('id, price_estimate')
    .eq('id', supplement.request_id)
    .single();

  const { data: payment } = await admin
    .from('payments')
    .select('id, stripe_payment_intent_id, status')
    .eq('request_id', supplement.request_id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!payment?.stripe_payment_intent_id) {
    await mark('uncollected', 'There is no card authorization on this request to add to.');
    return;
  }
  if (payment.status !== 'authorized') {
    await mark('uncollected', `The payment is already ${payment.status}; collect this supplement separately.`);
    return;
  }

  const { data: approved } = await admin
    .from('request_supplements')
    .select('id, amount, payment_state')
    .eq('request_id', supplement.request_id)
    .eq('status', 'approved');

  const securedSoFar = (approved ?? [])
    .filter((s) => s.payment_state === 'authorized' || s.payment_state === 'settled')
    .reduce((sum, s) => sum + Number(s.amount), 0);
  const newTotal = Number(request?.price_estimate ?? 0) + securedSoFar + Number(supplement.amount);
  const cents = Math.round(newTotal * 100);

  const stripe = getStripe();
  try {
    await stripe.paymentIntents.incrementAuthorization(
      payment.stripe_payment_intent_id,
      { amount: cents },
      { idempotencyKey: `supplement-${supplementId}` }
    );
  } catch (e) {
    await mark(
      'uncollected',
      e instanceof Error
        ? `The authorization could not be increased: ${e.message.slice(0, 200)}`
        : 'The authorization could not be increased.'
    );
    return;
  }

  await admin.from('payments').update({ amount: Math.round(newTotal * 100) / 100 }).eq('id', payment.id);
  await mark('authorized', null);
  revalidatePath('/dashboard/driver');
}

// ---------------------------------------------------------- cancellations

/**
 * What a cancellation costs and what it pays.
 *
 * Returns whether a fee was actually captured, because the caller must not
 * then also release the hold — capturing and cancelling the same authorization
 * are mutually exclusive.
 *
 * Both numbers stay NULL when no cancellation policy is configured. That is
 * not the same as a zero fee, and this is not the place to invent one.
 */
export async function settleCancellationEconomics(
  requestId: string,
  stage: 'before_match' | 'after_match'
): Promise<{ feeCaptured: boolean }> {
  const admin = createAdminClient();

  const { data: request } = await admin
    .from('requests')
    .select('id, driver_id, pricing_config_id, cancellation_settled_at')
    .eq('id', requestId)
    .maybeSingle();
  if (!request || request.cancellation_settled_at) return { feeCaptured: false };

  const { data: config } = request.pricing_config_id
    ? await admin.from('pricing_configs').select('*').eq('id', request.pricing_config_id).maybeSingle()
    : { data: null };

  const outcome = settleCancellation(stage, {
    ...(toEconomicConfig(config) ?? {}),
    cancellationFeeCustomer: config?.cancellation_fee_customer == null ? null : Number(config.cancellation_fee_customer),
    cancellationCompensationProvider:
      config?.cancellation_compensation_provider == null
        ? null
        : Number(config.cancellation_compensation_provider),
  });

  if (outcome.status === 'not_configured') {
    // Nothing decided, so nothing recorded. The columns stay NULL and say so.
    return { feeCaptured: false };
  }

  let feeCaptured = false;
  const fee = outcome.customerCharge ?? 0;

  if (fee > 0 && isStripeConfigured()) {
    assertSandbox();
    const { data: payment } = await admin
      .from('payments')
      .select('id, stripe_payment_intent_id, status')
      .eq('request_id', requestId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (payment?.stripe_payment_intent_id && payment.status === 'authorized') {
      try {
        const stripe = getStripe();
        await stripe.paymentIntents.capture(
          payment.stripe_payment_intent_id,
          { amount_to_capture: Math.round(fee * 100) },
          { idempotencyKey: `cancellation-fee-${requestId}` }
        );
        await admin.from('payments').update({ status: 'captured' }).eq('id', payment.id);
        feeCaptured = true;
      } catch {
        // The rest of the hold is released by the caller. The fee simply was
        // not collected, and the row below will say what was owed.
      }
    }
  }

  await admin
    .from('requests')
    .update({
      cancellation_fee_charged: outcome.customerCharge,
      cancellation_compensation: outcome.providerCompensation,
      cancellation_settled_at: new Date().toISOString(),
    })
    .eq('id', requestId);

  const compensation = outcome.providerCompensation ?? 0;
  if (compensation > 0 && request.driver_id) {
    const { data: companyIdRaw } = await admin.rpc('driver_company_id' as never, {
      p_profile_id: request.driver_id,
    } as never);
    const companyId = companyIdRaw as unknown as string | null;
    if (companyId) {
      await admin.from('provider_ledger_entries').insert({
        company_id: companyId,
        driver_id: request.driver_id,
        request_id: requestId,
        entry_type: 'adjustment',
        amount: compensation,
        // Payable only if the fee that funds it was actually collected.
        available_at: feeCaptured ? new Date().toISOString() : null,
        description: 'Cancellation compensation',
      } as never);
    }
  }

  return { feeCaptured };
}

// ---------------------------------------------------------------- payouts

export async function listPayouts(companyId: string): Promise<ProviderPayout[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('provider_payouts')
    .select('*')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

/**
 * Prepare a payout. Prepares — it does not send money.
 *
 * The brief is explicit that nothing pays out automatically after a job, and
 * this phase is sandbox only, so a payout starts life as 'pending' and a
 * matching negative ledger entry is written so the balance stops counting the
 * money as available. Actually transferring it is a separate, later decision.
 */
export async function preparePayout(companyId: string, amount: number): Promise<ProviderPayout> {
  const actorId = await assertPlatformAdmin();
  const admin = createAdminClient();

  const { data: balances } = await admin.rpc('provider_balances' as never, {
    p_company_id: companyId,
  } as never);
  const available = Number((balances as ProviderBalances[] | null)?.[0]?.available ?? 0);

  if (!Number.isFinite(amount) || amount <= 0) throw new Error('A payout needs a positive amount.');
  if (amount > available + 0.005) {
    throw new Error(`Only $${available.toFixed(2)} is available for payout.`);
  }

  const { data: payout, error } = await admin
    .from('provider_payouts')
    .insert({
      company_id: companyId,
      amount: Math.round(amount * 100) / 100,
      state: 'pending',
      requested_by: actorId,
      notes: 'Prepared in sandbox — no transfer sent.',
    })
    .select('*')
    .single();
  if (error) throw error;

  await admin.from('provider_ledger_entries').insert({
    company_id: companyId,
    payout_id: payout.id,
    entry_type: 'payout',
    amount: -Math.round(amount * 100) / 100,
    available_at: new Date().toISOString(),
    description: 'Payout prepared',
  } as never);

  revalidatePath('/dashboard/admin/finance');
  return payout as ProviderPayout;
}

export async function setPayoutState(
  payoutId: string,
  state: ProviderPayout['state'],
  failureReason?: string
): Promise<void> {
  await assertPlatformAdmin();
  const admin = createAdminClient();

  const patch: Partial<ProviderPayout> = { state };
  if (state === 'paid') patch.paid_at = new Date().toISOString();
  if (state === 'reversed') patch.reversed_at = new Date().toISOString();
  if (failureReason) patch.failure_reason = failureReason;

  const { data: payout } = await admin
    .from('provider_payouts')
    .select('company_id, amount, state')
    .eq('id', payoutId)
    .single();

  await admin.from('provider_payouts').update(patch).eq('id', payoutId);

  // A reversal is its own entry, putting the money back where it came from.
  // The original payout entry stays exactly as it was written.
  if (state === 'reversed' && payout && payout.state !== 'reversed') {
    await admin.from('provider_ledger_entries').insert({
      company_id: payout.company_id,
      payout_id: payoutId,
      entry_type: 'payout_reversal',
      amount: Number(payout.amount),
      available_at: new Date().toISOString(),
      description: failureReason ? `Payout reversed: ${failureReason}` : 'Payout reversed',
    } as never);
  }

  revalidatePath('/dashboard/admin/finance');
}

// ------------------------------------------------------------ admin views

export interface CompanyFinanceRow {
  id: string;
  name: string;
  connectStatus: string;
  payoutsEnabled: boolean;
  pending: number;
  available: number;
  paidTotal: number;
  lifetimeEarned: number;
}

export interface AdminFinanceOverview {
  /** NULL where nothing was configured — deliberately not folded into a zero. */
  customerTotal: number;
  providerTotal: number;
  processingTotal: number;
  marginTotal: number;
  jobsWithEconomics: number;
  jobsWithoutEconomics: number;
  refundedTotal: number;
  companies: CompanyFinanceRow[];
  refunds: Refund[];
  payouts: ProviderPayout[];
}

/**
 * The platform's own numbers.
 *
 * Jobs accepted while nothing was configured are counted separately rather
 * than summed as zeros: "we made $0 on 40 jobs" and "40 jobs predate any
 * commission" are different statements, and only the second is true.
 */
export async function getAdminFinanceOverview(): Promise<AdminFinanceOverview> {
  await assertPlatformAdmin();
  const admin = createAdminClient();

  const { data: requests } = await admin
    .from('requests')
    .select('id, price_estimate, partner_amount, commission_amount, payment_processing_cost, status')
    .eq('status', 'completed');

  let customerTotal = 0;
  let providerTotal = 0;
  let processingTotal = 0;
  let marginTotal = 0;
  let jobsWithEconomics = 0;
  let jobsWithoutEconomics = 0;

  for (const r of requests ?? []) {
    if (r.partner_amount == null) {
      jobsWithoutEconomics += 1;
      continue;
    }
    jobsWithEconomics += 1;
    customerTotal += Number(r.price_estimate ?? 0);
    providerTotal += Number(r.partner_amount);
    processingTotal += Number(r.payment_processing_cost ?? 0);
    marginTotal += Number(r.commission_amount ?? 0);
  }

  const { data: refunds } = await admin
    .from('refunds')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50);
  const refundedTotal = (refunds ?? [])
    .filter((r) => r.status === 'succeeded')
    .reduce((sum, r) => sum + Number(r.amount), 0);

  const { data: payouts } = await admin
    .from('provider_payouts')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50);

  const { data: companies } = await admin
    .from('companies')
    .select('id, name, display_name, connect_status, connect_payouts_enabled')
    .order('name');

  const rows: CompanyFinanceRow[] = [];
  for (const c of companies ?? []) {
    const { data: balances } = await admin.rpc('provider_balances' as never, {
      p_company_id: c.id,
    } as never);
    const b = (balances as ProviderBalances[] | null)?.[0];
    rows.push({
      id: c.id,
      name: c.display_name || c.name,
      connectStatus: c.connect_status ?? 'not_started',
      payoutsEnabled: Boolean(c.connect_payouts_enabled),
      pending: Number(b?.pending ?? 0),
      available: Number(b?.available ?? 0),
      paidTotal: Number(b?.paid_total ?? 0),
      lifetimeEarned: Number(b?.lifetime_earned ?? 0),
    });
  }

  return {
    customerTotal: Math.round(customerTotal * 100) / 100,
    providerTotal: Math.round(providerTotal * 100) / 100,
    processingTotal: Math.round(processingTotal * 100) / 100,
    marginTotal: Math.round(marginTotal * 100) / 100,
    jobsWithEconomics,
    jobsWithoutEconomics,
    refundedTotal: Math.round(refundedTotal * 100) / 100,
    companies: rows,
    refunds: (refunds ?? []) as Refund[],
    payouts: (payouts ?? []) as ProviderPayout[],
  };
}
