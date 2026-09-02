import { describe, expect, it } from 'vitest';
import { stripeKeyMode } from './mode';

// The guard is tested directly rather than through the Stripe client, because
// what matters is the classification: everything else in connect.ts refuses on
// anything but 'test'. It lives in ./mode precisely so this file can import it
// without dragging in `server-only`.
describe('Stripe Connect sandbox guard', () => {
  it('recognises a test key', () => {
    expect(stripeKeyMode('sk_test_abc123')).toBe('test');
    expect(stripeKeyMode('rk_test_abc123')).toBe('test');
  });

  it('recognises a live key', () => {
    expect(stripeKeyMode('sk_live_abc123')).toBe('live');
    expect(stripeKeyMode('rk_live_abc123')).toBe('live');
  });

  it('refuses to classify anything else, rather than assuming test', () => {
    // Defaulting an unrecognised key to "test" would be the dangerous
    // direction: a key we cannot classify is a key we should not spend with.
    expect(stripeKeyMode(undefined)).toBe('unknown');
    expect(stripeKeyMode('')).toBe('unknown');
    expect(stripeKeyMode('pk_test_abc')).toBe('unknown');
    expect(stripeKeyMode('whsec_abc')).toBe('unknown');
    expect(stripeKeyMode('sk_abc')).toBe('unknown');
  });
});
