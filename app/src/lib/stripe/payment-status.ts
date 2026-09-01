// Pure mapping helpers for Stripe payment state. Deliberately free of any
// server-only import so the rules can be unit-tested directly.

// Stripe signals "this off-session confirmation needs 3D Secure" as a
// payment_intent.payment_failed carrying last_payment_error.code =
// 'authentication_required', with the intent back at
// 'requires_payment_method'. It reads exactly like a decline and is not one:
// the customer is looking at the challenge and can still complete it.
//
// Getting this wrong has broken TowConnect twice, in two different code
// paths - once so that no SCA customer could order at all, once so that a
// live payment was recorded as failed while its challenge was still on
// screen. Hence one shared, tested predicate.
export function isAuthenticationRequired(reason: string | null | undefined) {
  return reason === 'authentication_required';
}
