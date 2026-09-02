import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { getStripe, isStripeConfigured } from '@/lib/stripe/server';
import { createAdminClient } from '@/lib/supabase/admin';
import type { PaymentStatus } from '@/lib/supabase/types';
import { isAuthenticationRequired } from '@/lib/stripe/payment-status';
import { summariseAccount } from '@/lib/stripe/connect';
import { releaseHeldEarnings } from '@/lib/actions/finance';

// Stripe is the source of truth for payment state — this webhook is the
// only thing that gets to call a payment truly settled. The optimistic
// updates in lib/actions/payments.ts (right after creating/capturing a
// PaymentIntent) are for snappy UI only; whatever arrives here always wins.
export async function POST(request: Request) {
  if (!isStripeConfigured()) {
    return NextResponse.json({ error: 'Stripe not configured' }, { status: 503 });
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return NextResponse.json({ error: 'STRIPE_WEBHOOK_SECRET not configured' }, { status: 503 });
  }

  const signature = request.headers.get('stripe-signature');
  if (!signature) {
    return NextResponse.json({ error: 'Missing signature' }, { status: 400 });
  }

  const rawBody = await request.text();
  const stripe = getStripe();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    // Invalid/forged signature — rejected outright, never processed.
    console.error('Stripe webhook signature verification failed', err);
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  const admin = createAdminClient();

  // Idempotency: insert the event id before doing anything else. A unique
  // constraint conflict means this exact event was already processed
  // (Stripe retries webhooks that don't return 2xx quickly) — return 200
  // immediately without touching payment state a second time.
  const { error: insertError } = await admin
    .from('stripe_webhook_events')
    .insert({ stripe_event_id: event.id, type: event.type });
  if (insertError) {
    return NextResponse.json({ ok: true, deduplicated: true });
  }

  try {
    await handleEvent(event, admin);
  } catch (err) {
    console.error(`Stripe webhook handler failed for ${event.type} (${event.id})`, err);
    return NextResponse.json({ error: 'Handler failed' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

async function handleEvent(event: Stripe.Event, admin: ReturnType<typeof createAdminClient>) {
  switch (event.type) {
    // Fired once the authorization succeeds (manual capture) — the intent
    // becomes capturable. This is the authoritative "authorized" signal.
    case 'payment_intent.amount_capturable_updated':
    case 'payment_intent.processing': {
      const intent = event.data.object as Stripe.PaymentIntent;
      await setStatusByIntentId(admin, intent.id, 'authorized');
      break;
    }
    // Fired on a successful capture.
    case 'payment_intent.succeeded': {
      const intent = event.data.object as Stripe.PaymentIntent;
      await setStatusByIntentId(admin, intent.id, 'captured');
      // A capture that only succeeded here — after the driver closed the job,
      // or on a retry — left the provider's earning recorded but not payable.
      // The ledger cannot be edited, so releaseHeldEarnings() writes the
      // correcting pair instead. Nothing happens when there was nothing held.
      await releaseEarningsForIntent(admin, intent.id);
      break;
    }
    case 'payment_intent.payment_failed': {
      const intent = event.data.object as Stripe.PaymentIntent;
      const reason = intent.last_payment_error?.code ?? intent.last_payment_error?.decline_code ?? 'failed';

      if (isAuthenticationRequired(reason)) {
        // Not a decline. Stripe reports an off-session confirmation that
        // needs SCA as payment_intent.payment_failed with this code, leaving
        // the intent at 'requires_payment_method' - while the customer is
        // looking at the 3D Secure challenge and can still complete it.
        //
        // Recording 'failed' here overwrote the 'requires_action' that
        // createRequest() had correctly just written, so the rider was told
        // their payment had failed mid-challenge and support saw a dead
        // payment that was actually live. This is the same misreading the
        // app-side path was fixed for in Phase 4 - the webhook half, which
        // deliberately wins over every optimistic write, was missed.
        await admin
          .from('payments')
          .update({ status: 'requires_action' satisfies PaymentStatus, failure_reason: null })
          .eq('stripe_payment_intent_id', intent.id);
        break;
      }

      await admin
        .from('payments')
        .update({ status: 'failed' satisfies PaymentStatus, failure_reason: reason })
        .eq('stripe_payment_intent_id', intent.id);
      break;
    }
    case 'payment_intent.canceled': {
      const intent = event.data.object as Stripe.PaymentIntent;
      await setStatusByIntentId(admin, intent.id, 'canceled');
      break;
    }
    case 'charge.refunded': {
      const charge = event.data.object as Stripe.Charge;
      const intentId = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
      // Only a FULL refund settles the payment. A partial one leaves a
      // captured payment with part of the money returned, and marking that
      // 'refunded' would tell support the customer got everything back.
      if (intentId && charge.amount_refunded >= charge.amount) {
        await setStatusByIntentId(admin, intentId, 'refunded');
      }
      break;
    }

    // Stripe, not our optimistic write, decides whether a refund happened.
    case 'refund.created':
    case 'refund.updated':
    case 'refund.failed': {
      const refund = event.data.object as Stripe.Refund;
      const status =
        refund.status === 'succeeded'
          ? 'succeeded'
          : refund.status === 'failed'
            ? 'failed'
            : refund.status === 'canceled'
              ? 'canceled'
              : 'pending';
      await admin
        .from('refunds')
        .update({ status, failure_reason: refund.failure_reason ?? null })
        .eq('stripe_refund_id', refund.id);
      break;
    }

    // A company's Connect account changed on Stripe's side — new requirements,
    // verification cleared, payouts disabled. These flags are only ever
    // written from Stripe's own answer; nothing in the app may set them, and
    // the 0034 trigger enforces that.
    case 'account.updated': {
      const account = event.data.object as Stripe.Account;
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
        .eq('stripe_account_id', account.id);
      break;
    }

    // Payout lifecycle. Matched on the transfer id we stored when the payout
    // was sent; an event for a transfer we do not know about is ignored rather
    // than guessed at.
    case 'transfer.created': {
      const transfer = event.data.object as Stripe.Transfer;
      await admin.from('provider_payouts').update({ state: 'paid', paid_at: new Date().toISOString() })
        .eq('stripe_transfer_id', transfer.id);
      break;
    }
    case 'transfer.reversed': {
      const transfer = event.data.object as Stripe.Transfer;
      await reversePayoutByTransfer(admin, transfer.id, 'Reversed by Stripe');
      break;
    }
    case 'payout.paid': {
      const payout = event.data.object as Stripe.Payout;
      await admin.from('provider_payouts').update({ state: 'paid', paid_at: new Date().toISOString() })
        .eq('stripe_transfer_id', payout.id);
      break;
    }
    case 'payout.failed': {
      const payout = event.data.object as Stripe.Payout;
      await reversePayoutByTransfer(admin, payout.id, payout.failure_message ?? 'Payout failed');
      break;
    }
    default:
      // Not a payment status transition TowConnect V1 acts on — ignored.
      break;
  }
}

async function setStatusByIntentId(admin: ReturnType<typeof createAdminClient>, intentId: string, status: PaymentStatus) {
  await admin.from('payments').update({ status }).eq('stripe_payment_intent_id', intentId);
}

async function releaseEarningsForIntent(admin: ReturnType<typeof createAdminClient>, intentId: string) {
  const { data: payment } = await admin
    .from('payments')
    .select('request_id')
    .eq('stripe_payment_intent_id', intentId)
    .maybeSingle();
  if (payment?.request_id) await releaseHeldEarnings(payment.request_id);
}

/**
 * A payout that came back is not an edit of the payout that went out.
 *
 * The row's state moves to 'reversed' and a new positive ledger entry puts the
 * money back into the provider's available balance. The original negative
 * entry stays exactly as written — that is what makes the history readable
 * afterwards.
 */
async function reversePayoutByTransfer(
  admin: ReturnType<typeof createAdminClient>,
  transferId: string,
  reason: string
) {
  const { data: payout } = await admin
    .from('provider_payouts')
    .select('id, company_id, amount, state')
    .eq('stripe_transfer_id', transferId)
    .maybeSingle();
  if (!payout || payout.state === 'reversed') return;

  await admin
    .from('provider_payouts')
    .update({ state: 'reversed', reversed_at: new Date().toISOString(), failure_reason: reason })
    .eq('id', payout.id);

  await admin.from('provider_ledger_entries').insert({
    company_id: payout.company_id,
    payout_id: payout.id,
    entry_type: 'payout_reversal',
    amount: Number(payout.amount),
    available_at: new Date().toISOString(),
    description: `Payout reversed: ${reason}`,
  } as never);
}
