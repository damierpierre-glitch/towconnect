// What a person is told when something goes wrong.
//
// THE PROBLEM THIS SOLVES
// Until Phase 10 a failure reached the customer as either the raw thrown
// message or a single generic sentence. Both are bad in the same way: the
// first leaks how the system is built (a Postgres error code, a Stripe
// decline reason, a policy name) and tells the person nothing they can act
// on; the second tells them nothing at all, which at the roadside means they
// sit there wondering whether help is coming.
//
// So an error is turned into a CODE here, and the code is translated where
// every other sentence in the product is translated. The original error is
// never rendered — it goes to the server log, where the person who can act
// on it will actually see it.
//
// The mapping runs on the server (classifying a thrown error before it
// crosses the boundary) and in the browser (a Stripe.js or geolocation
// failure), and it is unit-tested. Its only import is a type — erased at
// build time, and the reason a code with no written sentence fails to
// compile instead of failing at the roadside.
import type { DictKey } from '@/lib/i18n/dictionary';

export type ErrorCode =
  // The pilot gate — expected refusals, each with something useful to say.
  | 'pilot_paused'
  | 'pilot_outside_territory'
  | 'pilot_outside_hours'
  | 'pilot_not_on_allowlist'
  // Money.
  | 'card_declined'
  | 'card_authentication_required'
  | 'payment_unavailable'
  // Identity and permission.
  | 'signed_out'
  | 'not_permitted'
  // The world.
  | 'network'
  | 'location_denied'
  | 'location_unavailable'
  // Everything else.
  | 'generic';

/** The i18n key for each code. Every code has one; there is no fallthrough. */
export const ERROR_MESSAGE_KEYS: Record<ErrorCode, DictKey> = {
  pilot_paused: 'err_pilot_paused',
  pilot_outside_territory: 'err_pilot_outside_territory',
  pilot_outside_hours: 'err_pilot_outside_hours',
  pilot_not_on_allowlist: 'err_pilot_not_on_allowlist',
  card_declined: 'err_card_declined',
  card_authentication_required: 'err_card_authentication_required',
  payment_unavailable: 'err_payment_unavailable',
  signed_out: 'err_signed_out',
  not_permitted: 'err_not_permitted',
  network: 'err_network',
  location_denied: 'err_location_denied',
  location_unavailable: 'err_location_unavailable',
  generic: 'error_generic',
};

function messageOf(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const e = err as { message?: unknown; code?: unknown; decline_code?: unknown };
    const parts = [e.message, e.code, e.decline_code].filter((p) => typeof p === 'string');
    return parts.join(' ');
  }
  return '';
}

/**
 * Classify a failure.
 *
 * Deliberately conservative: anything not recognised is `generic`. Guessing
 * at an error and telling somebody the wrong thing — "your card was
 * declined" when the network dropped — is worse than saying less.
 */
export function errorCode(err: unknown): ErrorCode {
  const raw = messageOf(err);
  const m = raw.toLowerCase();
  if (!m) return 'generic';

  // The pilot gate raises `pilot_closed:<reason>` (0047).
  if (m.includes('pilot_closed:paused')) return 'pilot_paused';
  if (m.includes('pilot_closed:outside_territory')) return 'pilot_outside_territory';
  if (m.includes('pilot_closed:outside_hours')) return 'pilot_outside_hours';
  if (m.includes('pilot_closed:not_on_allowlist')) return 'pilot_not_on_allowlist';

  // Stripe. `authentication_required` is checked before the generic decline
  // patterns because it arrives AS a decline and means the opposite thing:
  // the card is fine, the bank wants the cardholder present.
  if (m.includes('authentication_required') || m.includes('3d secure') || m.includes('3ds')) {
    return 'card_authentication_required';
  }
  if (
    m.includes('card_declined') ||
    m.includes('insufficient_funds') ||
    m.includes('expired_card') ||
    m.includes('incorrect_cvc') ||
    m.includes('your card was declined')
  ) {
    return 'card_declined';
  }
  if (m.includes('stripe') || m.includes('payment_intent') || m.includes('paymentintent')) {
    return 'payment_unavailable';
  }

  if (m.includes('not authenticated') || m.includes('jwt') || m.includes('session')) {
    return 'signed_out';
  }
  // 42501 is Postgres for insufficient_privilege, which is what every RLS
  // policy and every capability guard in this system raises.
  if (
    m.includes('42501') ||
    m.includes('row-level security') ||
    m.includes('row level security') ||
    m.includes('not authorized') ||
    m.includes('capability')
  ) {
    return 'not_permitted';
  }

  if (
    m.includes('failed to fetch') ||
    m.includes('networkerror') ||
    m.includes('network error') ||
    m.includes('econnrefused') ||
    m.includes('fetch failed') ||
    m.includes('timeout')
  ) {
    return 'network';
  }

  if (m.includes('user denied geolocation') || m.includes('permission denied')) {
    return 'location_denied';
  }
  if (m.includes('position unavailable') || m.includes('geolocation')) {
    return 'location_unavailable';
  }

  return 'generic';
}

/** The i18n key to render for a failure. Never the failure itself. */
export function errorMessageKey(err: unknown): DictKey {
  return ERROR_MESSAGE_KEYS[errorCode(err)];
}

/**
 * The one place a raw error is allowed to be seen: the server log.
 *
 * Kept here rather than at each call site so that "log the detail, show the
 * sentence" is a single habit with a single shape.
 */
export function logAndClassify(context: string, err: unknown): ErrorCode {
  const code = errorCode(err);
  console.error(`[${context}] ${code}:`, err);
  return code;
}
