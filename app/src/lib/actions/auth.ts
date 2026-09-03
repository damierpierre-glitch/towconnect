'use server';

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { createClient } from '@/lib/supabase/server';

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/');
}

/**
 * Where a recovery link is allowed to come back to.
 *
 * Built from the request's own origin rather than taken from the browser, so
 * there is nothing here for a caller to point somewhere else. Supabase refuses
 * anything outside its redirect allow list as well — this is the first of the
 * two locks, not the only one.
 *
 * IT POINTS STRAIGHT AT THE PAGE, NOT THROUGH /auth/callback.
 * Supabase can return a recovery session in either of two shapes: `?code=`
 * for the PKCE flow, or tokens in the URL FRAGMENT. A fragment is never sent
 * to a server, so a route handler in the middle sees an empty request and
 * bounces the person to the login screen holding a link that was perfectly
 * valid. The page is a client component and the browser client consumes both
 * shapes on load, so sending the link there handles either — and removes a
 * hop while it is at it.
 */
async function recoveryRedirect(): Promise<string> {
  const configured = process.env.NEXT_PUBLIC_SITE_URL;
  if (configured) return `${configured.replace(/\/$/, '')}/nouveau-mot-de-passe`;

  const requestHeaders = await headers();
  const host = requestHeaders.get('host') ?? 'localhost:3000';
  const proto = requestHeaders.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}/nouveau-mot-de-passe`;
}

/**
 * Start a password reset.
 *
 * THE ANSWER IS THE SAME WHETHER OR NOT THE ACCOUNT EXISTS.
 * A reset form that says "no account with that address" is a form that will be
 * used to find out which addresses have accounts — by anybody, for free, at
 * whatever rate they like. So this returns nothing at all: not a boolean, not
 * an error, not a different duration if we can help it. The screen shows one
 * sentence, and it is true either way — we have sent a link *if* the address
 * belongs to an account.
 *
 * Errors are logged and swallowed for the same reason. A rate-limit message
 * leaking back to the browser would tell an enumerator that their previous
 * guess did something.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const address = email.trim();
  // A syntactic check only. It refuses an empty submit without revealing
  // anything, and it never says whether the address is registered.
  if (!address || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) return;

  try {
    const supabase = await createClient();
    await supabase.auth.resetPasswordForEmail(address, { redirectTo: await recoveryRedirect() });
  } catch (err) {
    console.error('[auth] password reset request failed', err);
  }
}

/**
 * Finish a password reset, or change a password from inside the account.
 *
 * Only reachable with a session. The recovery link creates one — that IS the
 * proof of ownership — so there is no separate token to validate here, and no
 * second place for one to be got wrong.
 *
 * Returns an error key rather than a message: the sentence is chosen where
 * every other sentence in the product is chosen.
 */
export async function updatePassword(password: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (password.length < 8) return { ok: false, reason: 'too_short' };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, reason: 'no_session' };

  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    console.error('[auth] password update failed', error);
    // Supabase refuses a password identical to the current one; that is worth
    // saying, because the person is looking at a form that appears to work.
    if (/should be different|same as/i.test(error.message)) return { ok: false, reason: 'unchanged' };
    return { ok: false, reason: 'failed' };
  }
  return { ok: true };
}
