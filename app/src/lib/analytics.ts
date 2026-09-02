'use client';

import { recordEvent } from '@/lib/actions/analytics';
import type { ProductEventName, ProductEventProps } from '@/lib/supabase/types';

// The browser half of the funnel.
//
// WHAT IS STORED IN THE BROWSER, AND WHY IT IS SO LITTLE
// One random string, so an anonymous landing view can be joined to the signup
// that followed it — otherwise every conversion rate in the product is
// unmeasurable. It is not an identity: nothing resolves it to a person, it is
// never sent anywhere but our own server, and clearing site data ends it.
//
// And one attribution code, when somebody arrives through a partner QR or
// link, so we can tell which channel actually produced work. It carries no
// money and changes no price.

const ANON_KEY = 'tc_anon';
const ATTR_KEY = 'tc_attr';

/** Every read and write is guarded: private windows and blocked site data throw. */
function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* A visitor who blocks storage is still a visitor. Nothing here is essential. */
  }
}

export function anonId(): string | null {
  if (typeof window === 'undefined') return null;
  const existing = readStorage(ANON_KEY);
  if (existing && /^[A-Za-z0-9_-]{8,64}$/.test(existing)) return existing;

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  writeStorage(ANON_KEY, id);
  return id;
}

/**
 * Remember which partner sent this visitor, if any.
 *
 * Read from `?p=` once and kept, because the code is on the poster in the
 * tyre shop and the request happens three screens later.
 */
export function captureAttribution(): string | null {
  if (typeof window === 'undefined') return null;
  const fromUrl = new URLSearchParams(window.location.search).get('p');
  if (fromUrl && /^[a-z0-9][a-z0-9-]{2,31}$/.test(fromUrl.toLowerCase())) {
    writeStorage(ATTR_KEY, fromUrl.toLowerCase());
    return fromUrl.toLowerCase();
  }
  return readStorage(ATTR_KEY);
}

export function attributionCode(): string | null {
  if (typeof window === 'undefined') return null;
  return readStorage(ATTR_KEY);
}

/**
 * Record a funnel step.
 *
 * Deliberately not awaited by callers and deliberately unable to reject: a
 * counter must never be able to interrupt somebody asking for a tow truck.
 */
export function track(
  name: ProductEventName,
  props?: ProductEventProps,
  requestId?: string | null
): void {
  if (typeof window === 'undefined') return;
  void recordEvent({
    name,
    anonId: anonId(),
    requestId: requestId ?? null,
    attributionCode: attributionCode(),
    props: {
      ...props,
      // Shape, not identity: which class of device, not which device.
      platform: window.innerWidth < 768 ? 'mobile' : 'desktop',
    },
  }).catch(() => {
    /* See the module note: analytics never breaks a rescue. */
  });
}
