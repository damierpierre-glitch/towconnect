// Verifies the security-critical primitive the Stripe webhook route depends
// on: a request is only ever processed if its `stripe-signature` header is a
// genuine HMAC over the exact raw body, computed with our webhook secret.
//
// This needs no Stripe account and makes no network call — signature
// verification is pure local crypto against a shared secret, which is
// exactly why it can be validated here while the rest of the payment flow
// remains blocked on real Stripe credentials.
//
// What this does NOT cover (documented in
// TOWCONNECT_LIVE_VALIDATION_REPORT.md): the route's Supabase wiring — the
// `stripe_webhook_events` idempotency insert and the `payments` status
// updates — which needs a live database.
import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';

// Not a real key: `Stripe` only needs a syntactically plausible string to
// construct, and `webhooks.constructEvent` never authenticates to Stripe.
const stripe = new Stripe('sk_test_not_a_real_key_used_only_for_local_crypto');

const WEBHOOK_SECRET = 'whsec_test_secret_for_unit_tests_only';

const payload = JSON.stringify({
  id: 'evt_test_00000000000001',
  type: 'payment_intent.succeeded',
  data: { object: { id: 'pi_test_00000000000001', status: 'succeeded' } },
});

function signedHeader(body: string, secret: string) {
  return stripe.webhooks.generateTestHeaderString({ payload: body, secret });
}

describe('Stripe webhook signature verification', () => {
  it('accepts a correctly signed payload and returns the parsed event', () => {
    const event = stripe.webhooks.constructEvent(
      payload,
      signedHeader(payload, WEBHOOK_SECRET),
      WEBHOOK_SECRET
    );
    expect(event.id).toBe('evt_test_00000000000001');
    expect(event.type).toBe('payment_intent.succeeded');
  });

  it('rejects a payload signed with the wrong secret (forged sender)', () => {
    const forged = signedHeader(payload, 'whsec_an_attackers_own_secret');
    expect(() => stripe.webhooks.constructEvent(payload, forged, WEBHOOK_SECRET)).toThrow();
  });

  it('rejects a tampered body even when the signature itself is well-formed', () => {
    // The classic attack this guards against: replay a real event's signature
    // over a body whose amount/status has been swapped.
    const header = signedHeader(payload, WEBHOOK_SECRET);
    const tampered = payload.replace('"succeeded"', '"REPLACED"');
    expect(() => stripe.webhooks.constructEvent(tampered, header, WEBHOOK_SECRET)).toThrow();
  });

  it('rejects a missing or garbage signature header', () => {
    expect(() => stripe.webhooks.constructEvent(payload, '', WEBHOOK_SECRET)).toThrow();
    expect(() => stripe.webhooks.constructEvent(payload, 'not-a-signature', WEBHOOK_SECRET)).toThrow();
  });

  it('rejects a signature whose timestamp is outside the tolerance (replay)', () => {
    const old = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: WEBHOOK_SECRET,
      timestamp: Math.floor(Date.now() / 1000) - 60 * 60, // an hour ago
    });
    // 300s tolerance, the same default the route relies on.
    expect(() => stripe.webhooks.constructEvent(payload, old, WEBHOOK_SECRET, 300)).toThrow();
  });
});
