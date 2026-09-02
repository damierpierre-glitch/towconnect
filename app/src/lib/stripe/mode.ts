// The sandbox guard, in a module with no server-only import.
//
// It lives apart from connect.ts for one reason: this is the single piece of
// Phase 7 that decides whether real money may move, so it has to be unit
// testable. connect.ts imports `server-only`, which makes any test that
// touches it fail to load — and a guard nobody can test is a guard nobody can
// trust.
//
// Stripe's own key prefixes are the signal. `sk_test_` is a test-mode key;
// `sk_live_` is not. Anything else — a restricted key, a malformed value — is
// refused too, because a key we cannot classify is a key we should not spend
// money with.

export class LiveModeRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveModeRefused';
  }
}

export function stripeKeyMode(secretKey: string | undefined): 'test' | 'live' | 'unknown' {
  if (!secretKey) return 'unknown';
  if (secretKey.startsWith('sk_test_') || secretKey.startsWith('rk_test_')) return 'test';
  if (secretKey.startsWith('sk_live_') || secretKey.startsWith('rk_live_')) return 'live';
  return 'unknown';
}

export function isSandbox(): boolean {
  return stripeKeyMode(process.env.STRIPE_SECRET_KEY) === 'test';
}

export function assertSandbox(): void {
  const mode = stripeKeyMode(process.env.STRIPE_SECRET_KEY);
  if (mode === 'test') return;
  throw new LiveModeRefused(
    mode === 'live'
      ? 'Stripe Connect is refused with a live key. Phase 7 is sandbox only: no real account may be ' +
        'created and no real money may move. Set a test-mode key (sk_test_…) to use these flows.'
      : 'Stripe Connect requires a recognisable test-mode key (sk_test_…). Refusing to proceed with a ' +
        'key whose mode cannot be determined.'
  );
}
