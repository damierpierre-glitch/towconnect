import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { getStripe, isStripeConfigured } from '@/lib/stripe/server';
import { createAdminClient } from '@/lib/supabase/admin';
import type { PaymentStatus } from '@/lib/supabase/types';

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
      break;
    }
    case 'payment_intent.payment_failed': {
      const intent = event.data.object as Stripe.PaymentIntent;
      const reason = intent.last_payment_error?.code ?? intent.last_payment_error?.decline_code ?? 'failed';
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
      if (intentId) await setStatusByIntentId(admin, intentId, 'refunded');
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
