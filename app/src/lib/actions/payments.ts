'use server';

import Stripe from 'stripe';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getStripe, isStripeConfigured } from '@/lib/stripe/server';
import { toMoney } from '@/lib/pricing';
import type { Payment, PaymentStatus } from '@/lib/supabase/types';

export { isStripeConfigured };

// ============================================================
// Stripe Customer — one persistent identity per TowConnect account, created
// lazily on first use. Never the user's email: Stripe Customers carry an
// email as metadata, but the *identity* used everywhere in our own code is
// the opaque stripe_customer_id, so a changed email never breaks a saved
// card's association.
// ============================================================
async function ensureStripeCustomer(): Promise<{ userId: string; customerId: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { data: profile } = await supabase
    .from('profiles')
    .select('stripe_customer_id, full_name')
    .eq('id', user.id)
    .single();

  if (profile?.stripe_customer_id) {
    return { userId: user.id, customerId: profile.stripe_customer_id };
  }

  const stripe = getStripe();
  const customer = await stripe.customers.create({
    email: user.email,
    name: profile?.full_name || undefined,
    metadata: { towconnect_user_id: user.id },
  });

  // service-role write — profiles.stripe_customer_id has no update policy
  // for the user's own session (0013_payments.sql).
  const admin = createAdminClient();
  const { error } = await admin.from('profiles').update({ stripe_customer_id: customer.id }).eq('id', user.id);
  if (error) throw error;

  return { userId: user.id, customerId: customer.id };
}

// ============================================================
// Saved payment methods
// ============================================================
export interface SavedPaymentMethod {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  isDefault: boolean;
}

export async function listPaymentMethods(): Promise<SavedPaymentMethod[]> {
  if (!isStripeConfigured()) return [];
  const { customerId } = await ensureStripeCustomer();
  const stripe = getStripe();

  const [methods, customer] = await Promise.all([
    stripe.paymentMethods.list({ customer: customerId, type: 'card' }),
    stripe.customers.retrieve(customerId),
  ]);

  const defaultId =
    !customer.deleted && typeof customer.invoice_settings?.default_payment_method === 'string'
      ? customer.invoice_settings.default_payment_method
      : null;

  return methods.data
    .filter((m): m is Stripe.PaymentMethod & { card: Stripe.PaymentMethod.Card } => Boolean(m.card))
    .map((m) => ({
      id: m.id,
      brand: m.card.brand,
      last4: m.card.last4,
      expMonth: m.card.exp_month,
      expYear: m.card.exp_year,
      isDefault: m.id === defaultId,
    }));
}

export async function hasDefaultPaymentMethod(): Promise<boolean> {
  if (!isStripeConfigured()) return false;
  const methods = await listPaymentMethods();
  return methods.some((m) => m.isDefault) || methods.length > 0;
}

// Client calls this to get a SetupIntent client secret, then confirms it
// itself with Stripe.js (stripe.confirmSetup / confirmCardSetup) — the card
// number never touches our server, only Stripe's.
export async function createSetupIntent(): Promise<{ clientSecret: string }> {
  const { customerId } = await ensureStripeCustomer();
  const stripe = getStripe();
  const setupIntent = await stripe.setupIntents.create({
    customer: customerId,
    usage: 'off_session',
    automatic_payment_methods: { enabled: true },
  });
  if (!setupIntent.client_secret) throw new Error('Stripe did not return a client secret');
  return { clientSecret: setupIntent.client_secret };
}

export async function setDefaultPaymentMethod(paymentMethodId: string): Promise<void> {
  const { customerId } = await ensureStripeCustomer();
  const stripe = getStripe();
  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: paymentMethodId },
  });
}

export async function removePaymentMethod(paymentMethodId: string): Promise<void> {
  const { customerId } = await ensureStripeCustomer();
  const stripe = getStripe();
  // detach() only succeeds for a payment method actually attached to a
  // customer — implicitly scopes this to the caller's own cards without
  // needing a separate ownership check.
  const method = await stripe.paymentMethods.retrieve(paymentMethodId);
  if (method.customer !== customerId) throw new Error('Not your payment method');
  await stripe.paymentMethods.detach(paymentMethodId);
}

// ============================================================
// Authorization at confirmation time — "authorize now, capture on
// completion" (see TOWCONNECT_PHASE4_REPORT.md §5 for why). Called from
// createRequest() (lib/actions/requests.ts) right after the request row and
// its frozen price snapshot exist. capture_method: 'manual' means this only
// places a hold; no money moves until capturePayment() below runs.
// ============================================================
export interface AuthorizeResult {
  paymentId: string;
  status: PaymentStatus;
  clientSecret: string | null;
  // The card Stripe wants authenticated. Needed because an off-session
  // confirm that trips 3DS leaves the PaymentIntent back at
  // requires_payment_method, so the on-session retry has to name the card
  // again — see the catch block in authorizeRequestPayment().
  paymentMethodId: string | null;
}

export async function authorizeRequestPayment(requestId: string, amount: number): Promise<AuthorizeResult> {
  const { customerId } = await ensureStripeCustomer();
  const stripe = getStripe();
  const admin = createAdminClient();

  const methods = await stripe.paymentMethods.list({ customer: customerId, type: 'card' });
  const customer = await stripe.customers.retrieve(customerId);
  const defaultId =
    !customer.deleted && typeof customer.invoice_settings?.default_payment_method === 'string'
      ? customer.invoice_settings.default_payment_method
      : null;
  const paymentMethodId = defaultId ?? methods.data[0]?.id;
  if (!paymentMethodId) {
    throw new Error('No saved payment method — add one before requesting help.');
  }

  const { data: paymentRow, error: insertError } = await admin
    .from('payments')
    .insert({ request_id: requestId, amount, status: 'requires_payment_method' })
    .select('*')
    .single();
  if (insertError || !paymentRow) throw insertError ?? new Error('Could not create payment record');

  try {
    const intent = await stripe.paymentIntents.create(
      {
        amount: Math.round(amount * 100),
        currency: 'cad',
        customer: customerId,
        payment_method: paymentMethodId,
        capture_method: 'manual',
        confirm: true,
        off_session: true,
        // NOT requesting incremental authorization, deliberately.
        //
        // An approved supplement can only be added to THIS hold if
        // `request_incremental_authorization` was set at creation time, so the
        // Phase 7.1 run tried it — and Stripe refused the PaymentIntent
        // outright: "This account is not eligible for the requested card
        // features." Asking for it does not degrade gracefully; it breaks
        // every authorization on this account.
        //
        // The consequence is stated rather than hidden: an approved
        // supplement is recorded as `uncollected` with Stripe's reason, and
        // the provider is credited nothing for it. Collecting a supplement
        // needs a separate charge, which Phase 7 did not build.
        metadata: { towconnect_request_id: requestId, towconnect_payment_id: paymentRow.id },
      },
      { idempotencyKey: `authorize-${paymentRow.id}` }
    );

    const status: PaymentStatus = intent.status === 'requires_capture' ? 'authorized' : 'requires_action';
    await admin
      .from('payments')
      .update({ stripe_payment_intent_id: intent.id, status })
      .eq('id', paymentRow.id);

    return {
      paymentId: paymentRow.id,
      status,
      clientSecret: status === 'requires_action' ? intent.client_secret : null,
      paymentMethodId,
    };
  } catch (err) {
    // An off_session confirm that needs 3DS comes back as an ERROR (Stripe
    // can't pop a challenge with no browser in the loop) carrying the
    // PaymentIntent, and the customer must return on-session to authenticate.
    //
    // Do NOT key this off payment_intent.status === 'requires_action': the
    // live run proved Stripe leaves the intent at 'requires_payment_method'
    // in this case and signals the real reason through
    // code === 'authentication_required'. Matching on the status alone
    // misclassified every 3DS card as a hard decline, so anyone whose bank
    // enforces SCA could never complete a request. See
    // TOWCONNECT_LIVE_VALIDATION_REPORT.md.
    const cardError = err instanceof Stripe.errors.StripeCardError ? err : null;
    const intent = cardError?.payment_intent;
    const needsAuthentication =
      Boolean(intent?.client_secret) &&
      (cardError?.code === 'authentication_required' || intent?.status === 'requires_action');

    if (cardError && intent && needsAuthentication) {
      await admin
        .from('payments')
        .update({ stripe_payment_intent_id: intent.id, status: 'requires_action' })
        .eq('id', paymentRow.id);
      return {
        paymentId: paymentRow.id,
        status: 'requires_action',
        clientSecret: intent.client_secret ?? null,
        paymentMethodId,
      };
    }

    const reason = err instanceof Stripe.errors.StripeCardError ? err.code ?? err.decline_code ?? 'card_error' : 'error';
    await admin.from('payments').update({ status: 'failed', failure_reason: reason }).eq('id', paymentRow.id);
    throw new Error('PAYMENT_FAILED');
  }
}

// Re-attempt after a failure or after the client fixes their default
// payment method. Deliberately takes no `amount` from the caller — the
// browser has already shown a stale/failed price to the user, but the
// amount actually authorized always comes back out of requests.price_estimate
// (the frozen server snapshot), never a client-supplied number.
export async function retryRequestPayment(requestId: string): Promise<AuthorizeResult> {
  const supabase = await createClient();
  const { data: request, error } = await supabase
    .from('requests')
    .select('price_estimate')
    .eq('id', requestId)
    .single();
  if (error || !request) throw error ?? new Error('Request not found');

  return authorizeRequestPayment(requestId, toMoney(request.price_estimate));
}

// Called after the client completes a 3DS challenge with Stripe.js
// (stripe.confirmCardPayment) for a 'requires_action' authorization.
// Re-checks the PaymentIntent directly with Stripe — never trusts that the
// browser reaching a "success" callback means the payment actually went
// through — and reconciles our local `payments` row to match.
export async function finalizeAuthorization(requestId: string): Promise<PaymentStatus> {
  const admin = createAdminClient();
  const { data: payment } = await admin
    .from('payments')
    .select('*')
    .eq('request_id', requestId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!payment || !payment.stripe_payment_intent_id) return payment?.status ?? 'requires_payment_method';

  const stripe = getStripe();
  const intent = await stripe.paymentIntents.retrieve(payment.stripe_payment_intent_id);

  const status: PaymentStatus =
    intent.status === 'requires_capture'
      ? 'authorized'
      : intent.status === 'succeeded'
        ? 'captured'
        : intent.status === 'canceled'
          ? 'canceled'
          : intent.status === 'requires_action'
            ? 'requires_action'
            : 'failed';

  if (status !== payment.status) {
    await admin.from('payments').update({ status }).eq('id', payment.id);
  }
  return status;
}

// ============================================================
// Capture — called when the driver marks the job 'completed'
// (advanceRequestStatus() in lib/actions/driver.ts). Idempotent: capturing
// an already-captured (or no longer capturable) PaymentIntent is a no-op
// here, not an error that blocks the driver's workflow — operational status
// and payment status are deliberately decoupled.
// ============================================================
export async function captureRequestPayment(requestId: string): Promise<void> {
  if (!isStripeConfigured()) return;
  const admin = createAdminClient();

  const { data: payment } = await admin
    .from('payments')
    .select('*')
    .eq('request_id', requestId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!payment || payment.status !== 'authorized' || !payment.stripe_payment_intent_id) return;

  const stripe = getStripe();
  try {
    await stripe.paymentIntents.capture(payment.stripe_payment_intent_id, undefined, {
      idempotencyKey: `capture-${payment.id}`,
    });
    // Optimistic — the webhook (payment_intent.succeeded) is the
    // authoritative confirmation and will reconcile this if it disagrees.
    await admin.from('payments').update({ status: 'captured' }).eq('id', payment.id);
  } catch {
    await admin.from('payments').update({ status: 'failed', failure_reason: 'capture_failed' }).eq('id', payment.id);
  }
}

// Releases the authorization hold when a request is cancelled before the job
// was done. Without this, cancelling left the PaymentIntent sitting at
// requires_capture — the customer's card stays encumbered for ~$X until
// Stripe's own multi-day expiry drops it, and our payments row stays
// 'authorized' forever, so the record never reconciles. Found by the live
// end-to-end run; see TOWCONNECT_LIVE_VALIDATION_REPORT.md.
//
// Only ever cancels an UNCAPTURED intent. A payment that already captured
// needs a refund, which is deliberately out of scope here (Phase 5) — money
// that already moved must not be silently voided.
export async function cancelRequestPayment(requestId: string): Promise<void> {
  if (!isStripeConfigured()) return;
  const admin = createAdminClient();

  const { data: payment } = await admin
    .from('payments')
    .select('*')
    .eq('request_id', requestId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!payment) return;
  const cancellable: PaymentStatus[] = ['requires_payment_method', 'requires_action', 'authorized'];
  if (!cancellable.includes(payment.status)) return;

  if (payment.stripe_payment_intent_id) {
    const stripe = getStripe();
    try {
      await stripe.paymentIntents.cancel(payment.stripe_payment_intent_id);
    } catch {
      // Already cancelled/captured/expired on Stripe's side — the status
      // write below still reconciles our record, and the webhook remains the
      // authority if Stripe disagrees.
    }
  }

  await admin.from('payments').update({ status: 'canceled' }).eq('id', payment.id);
}

export async function getPaymentForRequest(requestId: string): Promise<Payment | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from('payments')
    .select('*')
    .eq('request_id', requestId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}
