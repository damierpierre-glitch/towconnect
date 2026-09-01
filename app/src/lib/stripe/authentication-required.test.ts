import { describe, it, expect } from 'vitest';
import { isAuthenticationRequired } from '@/lib/stripe/payment-status';

// This one distinction has now been got wrong twice, in two different code
// paths, and both times it broke the same thing: a customer who has SCA on
// their card could not order at all, or was told mid-challenge that their
// payment had failed. Stripe signals "needs 3D Secure" on an off-session
// confirmation as a payment_intent.payment_failed carrying
// last_payment_error.code = 'authentication_required' — which reads like a
// decline and is not one. Pinned so the third time is caught here.
describe('isAuthenticationRequired', () => {
  it('treats an SCA challenge as recoverable, not as a decline', () => {
    expect(isAuthenticationRequired('authentication_required')).toBe(true);
  });

  it('treats real declines as declines', () => {
    for (const code of ['card_declined', 'insufficient_funds', 'expired_card', 'incorrect_cvc', 'failed']) {
      expect(isAuthenticationRequired(code)).toBe(false);
    }
  });

  it('is safe when Stripe sends no code at all', () => {
    expect(isAuthenticationRequired(null)).toBe(false);
    expect(isAuthenticationRequired(undefined)).toBe(false);
  });
});
