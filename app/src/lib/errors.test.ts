import { describe, expect, it } from 'vitest';
import { ERROR_MESSAGE_KEYS, errorCode, errorMessageKey } from './errors';
import { dictionary } from './i18n/dictionary';

// The point of these tests is not that the mapping is clever. It is that the
// mapping is CLOSED: every code has a sentence in both languages, and an
// unrecognised error falls to the generic one instead of guessing.
describe('errorCode', () => {
  it('recognises each pilot gate refusal', () => {
    expect(errorCode(new Error('pilot_closed:paused'))).toBe('pilot_paused');
    expect(errorCode(new Error('pilot_closed:outside_territory'))).toBe('pilot_outside_territory');
    expect(errorCode(new Error('pilot_closed:outside_hours'))).toBe('pilot_outside_hours');
    expect(errorCode(new Error('pilot_closed:not_on_allowlist'))).toBe('pilot_not_on_allowlist');
  });

  it('separates a card that was declined from a card that needs the cardholder', () => {
    expect(errorCode({ code: 'card_declined', decline_code: 'insufficient_funds' })).toBe('card_declined');
    // This one arrives AS a decline and means the opposite: the card is fine.
    expect(errorCode({ code: 'card_declined', decline_code: 'authentication_required' })).toBe(
      'card_authentication_required'
    );
  });

  it('maps every privilege failure this system can raise to one code', () => {
    expect(errorCode(new Error('new row violates row-level security policy for table "requests"'))).toBe(
      'not_permitted'
    );
    expect(errorCode({ code: '42501', message: 'Not authorized to read system health' })).toBe('not_permitted');
    expect(errorCode(new Error('This action needs the "finance" capability.'))).toBe('not_permitted');
  });

  it('does not guess', () => {
    expect(errorCode(new Error('Unexpected token < in JSON at position 0'))).toBe('generic');
    expect(errorCode(undefined)).toBe('generic');
    expect(errorCode({})).toBe('generic');
    expect(errorCode('')).toBe('generic');
  });

  it('recognises a browser that could not reach the server', () => {
    expect(errorCode(new TypeError('Failed to fetch'))).toBe('network');
    expect(errorCode(new Error('fetch failed'))).toBe('network');
  });

  it('separates a refused location from an unavailable one', () => {
    expect(errorCode({ message: 'User denied Geolocation' })).toBe('location_denied');
    expect(errorCode({ message: 'Position unavailable' })).toBe('location_unavailable');
  });
});

describe('the mapping is closed', () => {
  it('gives every code a sentence in both languages', () => {
    const fr = dictionary.fr as Record<string, string>;
    const en = dictionary.en as Record<string, string>;
    for (const [code, key] of Object.entries(ERROR_MESSAGE_KEYS)) {
      expect(fr[key], `fr is missing ${key} for ${code}`).toBeTruthy();
      expect(en[key], `en is missing ${key} for ${code}`).toBeTruthy();
    }
  });

  it('never returns a key that is not in the dictionary', () => {
    const fr = dictionary.fr as Record<string, string>;
    expect(fr[errorMessageKey(new Error('something nobody anticipated'))]).toBeTruthy();
  });

  it('never leaks the original message', () => {
    const secretish = new Error('PGRST301 JWT expired for user 8f3a-... at pgsodium key');
    const key = errorMessageKey(secretish);
    const fr = dictionary.fr as Record<string, string>;
    expect(fr[key]).toBeTruthy();
    expect(fr[key]).not.toContain('pgsodium');
    expect(fr[key]).not.toContain('8f3a');
  });
});
