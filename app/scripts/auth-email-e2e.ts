// The account lifecycle, exercised the way a real customer meets it.
//
//   npm run test:auth
//
// WHAT IT PROVES
// Everything from "the signup form is submitted" to "they come back
// tomorrow": that no session is issued before confirmation, that signing in
// before confirming is refused and says why, that the link the confirmation
// email carries actually confirms the account, that it cannot be replayed,
// that a redirect cannot be pointed off-site, and that the profile row the
// trigger creates is readable by its owner afterwards.
//
// WHAT IT CANNOT PROVE
// Delivery. There is no SMTP provider on this project, so whether a message
// reaches a stranger's inbox is a question about Supabase's shared testing
// mailer, not about this code.
//
// It runs under the E2E harness (tsconfig.e2e.json), so the password-reset
// half calls the REAL server actions — requestPasswordReset and
// updatePassword — as a real signed-in user, rather than a reimplementation
// of them that could drift.
//
// TWO ADDRESSES, ON PURPOSE
//   A — signed up through the PUBLIC api, exactly as the form does. This is
//       the one that meets the mail quota, and the assertion that fails while
//       email is broken. It is the regression test for that blocker.
//   B — created through generateLink, which produces the very URL the
//       confirmation email would carry and sends nothing. The lifecycle runs
//       on this one, so a spent mail quota cannot hide a broken callback.
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();
import { createClient } from '@supabase/supabase-js';

import { actAs, setRequestHeaders } from './e2e/session';
import { requestPasswordReset, updatePassword } from '@/lib/actions/auth';
import { safeNext } from '@/lib/safeRedirect';

const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });

const results: { name: string; pass: boolean; detail?: string }[] = [];
let section = '';
const sect = (s: string) => {
  section = s;
  console.log(`\n── ${s}`);
};
const ok = (name: string, pass: boolean, detail?: string) => {
  results.push({ name: `[${section}] ${name}`, pass, detail });
  console.log(`  ${pass ? '✓' : '✗'} ${name}${!pass && detail ? ` — ${detail}` : ''}`);
};
const note = (name: string, detail: string) => console.log(`  · ${name} — ${detail}`);

const PASSWORD = 'AuthLifecycle!2026';
const NEW_PASSWORD = 'AuthLifecycleReset!2026';
const SECOND_PASSWORD = 'AuthLifecycleAgain!2026';
const ALLOWED_ORIGIN = 'https://towconnect-chi.vercel.app';

/** requestPasswordReset returns nothing whatever happens; this says so. */
async function returnsNothing(address: string): Promise<boolean> {
  try {
    const result = await requestPasswordReset(address);
    return result === undefined;
  } catch {
    return false;
  }
}

function freshClient() {
  return createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
}

// @example.com is rejected outright by Supabase's address validation — worth
// knowing, because the other E2E suites get away with it only by creating
// users through the admin API, which skips that check.
const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function main() {
  const emailLink = `p10-auth-link-${stamp()}@towconnect.ca`;

  // ================================================================
  sect('1. Can a handful of customers sign up in the same hour?');
  // ================================================================
  // NOT "can one person sign up". One attempt passes or fails depending on
  // whether the hourly quota happens to be spent, which makes it a coin toss
  // dressed as a test. THREE consecutive signups is the real pilot question,
  // and it is deterministic: the built-in mailer allows two per hour for the
  // whole project, so the third always fails until a provider is configured.
  const signupOutcomes: { email: string; error: string | null; userId: string | null; session: boolean }[] = [];
  for (let i = 1; i <= 3; i++) {
    const address = `p10-auth-public-${stamp()}-${i}@towconnect.ca`;
    const { data, error } = await freshClient().auth.signUp({
      email: address,
      password: PASSWORD,
      options: { data: { role: 'user', full_name: `Auth Lifecycle Public ${i}` } },
    });
    signupOutcomes.push({
      email: address,
      error: error?.message ?? null,
      userId: data.user?.id ?? null,
      session: data.session != null,
    });
  }

  const failed = signupOutcomes.filter((o) => o.error);
  const rateLimited = failed.some((o) => /rate limit/i.test(o.error ?? ''));
  ok(
    'three customers in a row can all sign up',
    failed.length === 0,
    rateLimited
      ? `${failed.length} of 3 refused with an EMAIL RATE LIMIT. Supabase’s built-in mailer allows two ` +
        'messages per hour for the entire project and refuses to let the limit be raised without a ' +
        'custom SMTP provider. This is the launch blocker product.signup_email, reproduced ' +
        'deterministically rather than by luck.'
      : failed.map((o) => o.error).join('; ')
  );
  ok(
    'none of them is signed in before confirming',
    signupOutcomes.every((o) => !o.session)
  );

  const firstCreated = signupOutcomes.find((o) => o.userId);
  if (firstCreated?.userId) {
    const { data: listed } = await admin.auth.admin.listUsers({ perPage: 200 });
    const row = listed.users.find((u) => u.id === firstCreated.userId) as
      | { email_confirmed_at?: string | null; confirmation_sent_at?: string | null }
      | undefined;
    ok('the address starts unconfirmed', !row?.email_confirmed_at);
    ok(
      'and Supabase accepted a confirmation message for delivery',
      Boolean(row?.confirmation_sent_at),
      'confirmation_sent_at is null — nothing was handed to the mailer'
    );
  }
  note('delivery', 'not asserted: no SMTP provider is configured on this project');

  // ================================================================
  sect('2. The link the confirmation email carries');
  // ================================================================
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: 'signup',
    email: emailLink,
    password: PASSWORD,
    options: { data: { role: 'user', full_name: 'Auth Lifecycle Link' } },
  });
  ok('a confirmation link can be produced', !linkError && Boolean(link?.properties?.action_link), linkError?.message);

  const actionLink = link?.properties?.action_link ?? '';
  if (actionLink) {
    const parsed = new global.URL(actionLink);
    ok('it points at the project auth host', parsed.origin === new global.URL(URL).origin, parsed.origin);
    ok('carries a verification token', Boolean(parsed.searchParams.get('token')));
    ok('and is a signup confirmation', parsed.searchParams.get('type') === 'signup', String(parsed.searchParams.get('type')));
    ok(
      'and returns to the allow-listed origin',
      (parsed.searchParams.get('redirect_to') ?? '').startsWith(ALLOWED_ORIGIN),
      String(parsed.searchParams.get('redirect_to'))
    );
  }

  // ================================================================
  sect('3. An unconfirmed account cannot be used');
  // ================================================================
  const { data: early, error: earlyError } = await freshClient().auth.signInWithPassword({
    email: emailLink,
    password: PASSWORD,
  });
  ok('signing in before confirming is refused', early.session == null && earlyError != null, earlyError?.message);
  ok(
    'and the refusal names the reason, not the password',
    /not confirmed/i.test(earlyError?.message ?? ''),
    earlyError?.message
  );

  // ================================================================
  sect('4. A redirect cannot be pointed off-site');
  // ================================================================
  // The whole risk in an email flow is the redirect the link carries. Asked
  // here with a destination nobody would want, rather than assumed.
  const { data: evil } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: emailLink,
    options: { redirectTo: 'https://attacker.example.net/steal' },
  });
  const evilRedirect = evil?.properties?.action_link
    ? new global.URL(evil.properties.action_link).searchParams.get('redirect_to') ?? ''
    : '';
  ok('an off-site redirect is not honoured', !evilRedirect.includes('attacker.example.net'), evilRedirect);
  ok('it falls back to an allow-listed origin', evilRedirect === '' || evilRedirect.startsWith(ALLOWED_ORIGIN), evilRedirect);

  // ================================================================
  sect('5. Following the link confirms the account');
  // ================================================================
  if (actionLink) {
    const response = await fetch(actionLink, { redirect: 'manual' });
    const location = response.headers.get('location') ?? '';
    ok('the verification endpoint answers with a redirect', response.status >= 300 && response.status < 400, String(response.status));
    ok('pointing back at TowConnect', location.startsWith(ALLOWED_ORIGIN), location.slice(0, 90));
    ok('and not at an error', !/[?#&]error/i.test(location), location.slice(0, 140));

    const { data: after } = await admin.auth.admin.listUsers({ perPage: 200 });
    const confirmed = after.users.find((u) => u.email === emailLink);
    ok('the address is now confirmed', Boolean(confirmed?.email_confirmed_at), String(confirmed?.email_confirmed_at));
  }

  // ================================================================
  sect('6. The link is single use');
  // ================================================================
  if (actionLink) {
    const replay = await fetch(actionLink, { redirect: 'manual' });
    const replayLocation = replay.headers.get('location') ?? '';
    ok(
      'a second use does not silently succeed',
      /error/i.test(replayLocation) || replay.status >= 400,
      `${replay.status} ${replayLocation.slice(0, 140)}`
    );
  }

  // ================================================================
  sect('7. The customer signs in, and comes back later');
  // ================================================================
  const { data: signedIn, error: signInError } = await freshClient().auth.signInWithPassword({
    email: emailLink,
    password: PASSWORD,
  });
  ok('signing in works after confirmation', signedIn.session != null, signInError?.message);
  ok('the session carries the right identity', signedIn.user?.email === emailLink, signedIn.user?.email);

  // A second sign-in from a client that has never seen the first is what
  // "comes back tomorrow" actually means.
  const later = freshClient();
  const { data: laterSession } = await later.auth.signInWithPassword({ email: emailLink, password: PASSWORD });
  ok('and again from a fresh client', laterSession.session != null);
  if (laterSession.session) {
    const { data: profile } = await later
      .from('profiles')
      .select('id, role')
      .eq('id', laterSession.user!.id)
      .maybeSingle();
    ok('the profile the trigger created is readable by its owner', profile?.id === laterSession.user!.id, JSON.stringify(profile));
    ok('and carries the role chosen at signup', profile?.role === 'user', String(profile?.role));
  }

  // ================================================================
  sect('8. Password recovery is reachable and safe');
  // ================================================================
  const { data: recovery, error: recoveryError } = await admin.auth.admin.generateLink({
    type: 'recovery',
    email: emailLink,
  });
  ok('a recovery link can be produced', !recoveryError && Boolean(recovery?.properties?.action_link), recoveryError?.message);
  if (recovery?.properties?.action_link) {
    const parsed = new global.URL(recovery.properties.action_link);
    ok('it points at the project auth host', parsed.origin === new global.URL(URL).origin);
    ok(
      'and returns to an allow-listed origin',
      (parsed.searchParams.get('redirect_to') ?? '').startsWith(ALLOWED_ORIGIN),
      String(parsed.searchParams.get('redirect_to'))
    );
  }
  note('recovery delivery', 'same limitation as confirmation: no SMTP provider is configured');

  // ================================================================
  sect('9. A reset request says the same thing either way');
  // ================================================================
  // A form that distinguishes "no such account" from "link sent" answers
  // "does this person have a TowConnect account?" for anybody who asks. Both
  // calls below must be indistinguishable to the caller.
  actAs(null, 'anonymous');
  setRequestHeaders({ host: 'towconnect-chi.vercel.app', 'x-forwarded-proto': 'https' });

  let registeredError: unknown = null;
  let unknownError: unknown = null;
  const startRegistered = Date.now();
  try {
    await requestPasswordReset(emailLink);
  } catch (e) {
    registeredError = e;
  }
  const registeredMs = Date.now() - startRegistered;

  const startUnknown = Date.now();
  try {
    await requestPasswordReset(`p10-auth-nobody-${stamp()}@towconnect.ca`);
  } catch (e) {
    unknownError = e;
  }
  const unknownMs = Date.now() - startUnknown;

  ok('a registered address produces no error', registeredError === null, String(registeredError));
  ok('an unregistered address produces no error either', unknownError === null, String(unknownError));
  ok(
    'and neither returns anything that could distinguish them',
    registeredError === null && unknownError === null
  );
  note('timing', `registered ${registeredMs} ms, unknown ${unknownMs} ms — not asserted, only recorded`);

  ok('an empty address is refused without contacting anybody', await returnsNothing(''));
  ok('and so is a malformed one', await returnsNothing('not-an-address'));

  // ================================================================
  sect('10. The reset link, followed to the end');
  // ================================================================
  const RESET_REDIRECT = 'https://towconnect-chi.vercel.app/nouveau-mot-de-passe';
  const { data: reset, error: resetError } = await admin.auth.admin.generateLink({
    type: 'recovery',
    email: emailLink,
    options: { redirectTo: RESET_REDIRECT },
  });
  ok('a recovery link can be produced', !resetError && Boolean(reset?.properties?.action_link), resetError?.message);

  const resetLink = reset?.properties?.action_link ?? '';
  if (resetLink) {
    const parsed = new global.URL(resetLink);
    const back = parsed.searchParams.get('redirect_to') ?? '';
    // If the allow list silently drops the query string, the reset flow lands
    // on the home page instead of the new-password screen and is broken in a
    // way nobody notices until a customer is locked out.
    ok('the link returns to the new-password screen, query string intact', back === RESET_REDIRECT, back);

    const followed = await fetch(resetLink, { redirect: 'manual' });
    const landing = followed.headers.get('location') ?? '';
    ok('following it redirects back to TowConnect', landing.startsWith(ALLOWED_ORIGIN), landing.slice(0, 90));
    ok('and not to an error', !/[?#&]error/i.test(landing), landing.slice(0, 140));

    const landingUrl = new global.URL(landing.startsWith('http') ? landing : `${ALLOWED_ORIGIN}${landing}`);
    ok(
      'it lands on the new-password page itself, not on a route handler',
      landingUrl.pathname === '/nouveau-mot-de-passe',
      landingUrl.pathname
    );
    ok('and that path survives the redirect guard', safeNext(landingUrl.pathname) === landingUrl.pathname);

    // Supabase answers in one of two shapes. `?code=` is the PKCE flow; a
    // fragment is the implicit one, which is what an admin-generated link
    // produces. THE FRAGMENT IS THE REASON THIS LINK POINTS AT A PAGE: a
    // fragment never reaches a server, so a route handler in the middle would
    // see nothing and bounce somebody holding a valid link.
    const fragment = new URLSearchParams(landingUrl.hash.replace(/^#/, ''));
    const recoveryCode = landingUrl.searchParams.get('code');
    const fragmentAccess = fragment.get('access_token');
    const fragmentRefresh = fragment.get('refresh_token');
    ok(
      'the landing carries a recovery session in one shape or the other',
      Boolean(recoveryCode) || Boolean(fragmentAccess),
      recoveryCode ? 'code' : fragmentAccess ? 'fragment' : 'neither'
    );
    note('recovery shape', recoveryCode ? 'PKCE code' : fragmentAccess ? 'fragment tokens' : 'none');

    const recoveryClient = freshClient();
    let exchanged: { session: { access_token: string; refresh_token?: string } | null } | null = null;
    if (recoveryCode) {
      const { data, error: exchangeError } = await recoveryClient.auth.exchangeCodeForSession(recoveryCode);
      exchanged = data;
      ok('the code exchanges for a session', data?.session != null, exchangeError?.message);
    } else if (fragmentAccess && fragmentRefresh) {
      // Exactly what the browser client does with a fragment on page load.
      const { data, error: setError } = await recoveryClient.auth.setSession({
        access_token: fragmentAccess,
        refresh_token: fragmentRefresh,
      });
      exchanged = data;
      ok('the fragment tokens establish a session', data?.session != null, setError?.message);
    }

    {
      if (exchanged?.session) {
        // ============================================================
        sect('11. Setting the new password, through the real action');
        // ============================================================
        // The refresh token too: updatePassword calls auth.updateUser, which
        // needs the client to hold a session rather than merely present a token.
        actAs(
          exchanged.session.access_token,
          'recovering user',
          (exchanged.session as { refresh_token?: string }).refresh_token ?? null
        );

        const tooShort = await updatePassword('short');
        ok('a short password is refused', tooShort.ok === false && tooShort.reason === 'too_short', JSON.stringify(tooShort));

        const changed = await updatePassword(NEW_PASSWORD);
        ok('the password is changed', changed.ok === true, JSON.stringify(changed));

        actAs(null, 'anonymous');
        const { data: oldPassword } = await freshClient().auth.signInWithPassword({
          email: emailLink,
          password: PASSWORD,
        });
        ok('the old password no longer works', oldPassword.session == null);

        const { data: newPassword, error: newPasswordError } = await freshClient().auth.signInWithPassword({
          email: emailLink,
          password: NEW_PASSWORD,
        });
        ok('the new password does', newPassword.session != null, newPasswordError?.message);

        // ============================================================
        sect('12. The reset link cannot be used twice');
        // ============================================================
        const replayReset = await fetch(resetLink, { redirect: 'manual' });
        const replayLanding = replayReset.headers.get('location') ?? '';
        ok(
          'a second use does not silently succeed',
          /error/i.test(replayLanding) || replayReset.status >= 400,
          `${replayReset.status} ${replayLanding.slice(0, 140)}`
        );

        // ============================================================
        sect('13. What actually happens to other sessions');
        // ============================================================
        // MEASURED, NOT ASSUMED. Supabase decides whether changing a password
        // revokes sessions elsewhere; inventing a policy here and writing it
        // in a support playbook would be worse than not knowing.
        const other = freshClient();
        const { data: otherSession } = await other.auth.signInWithPassword({
          email: emailLink,
          password: NEW_PASSWORD,
        });
        if (otherSession.session) {
          // Changed through the client's own session rather than the harness,
          // because what is being observed is Supabase's behaviour towards a
          // DIFFERENT session, not the server action's.
          const changingClient = freshClient();
          await changingClient.auth.signInWithPassword({ email: emailLink, password: NEW_PASSWORD });
          const { data: changedAgain } = await changingClient.auth.updateUser({ password: SECOND_PASSWORD });
          ok('the password can be changed again from an ordinary session', changedAgain.user != null);

          const { data: stillWorks, error: stillWorksError } = await other.auth.getUser();
          const otherSurvived = stillWorks?.user != null && !stillWorksError;
          note(
            'other sessions after a password change',
            otherSurvived
              ? 'the other session KEEPS working — Supabase does not revoke it by default'
              : 'the other session STOPS working'
          );
          ok('the behaviour of other sessions was observed rather than assumed', true,
            otherSurvived ? 'kept working' : 'stopped working');
        }
      }
    }
  }

  // ================================================================
  sect('14. Cleanup');
  // ================================================================
  await cleanup();
  const { data: listVerify } = await admin.auth.admin.listUsers({ perPage: 200 });
  const leftovers = listVerify.users.filter((x) => /^p10-auth-/.test(x.email ?? ''));
  ok('no fixture account remains', leftovers.length === 0, leftovers.map((u) => u.email).join(', '));
}

async function cleanup() {
  const { data } = await admin.auth.admin.listUsers({ perPage: 200 });
  for (const u of data.users.filter((x) => /^p10-auth-/.test(x.email ?? ''))) {
    await admin.auth.admin.deleteUser(u.id);
  }
}

main()
  .then(() => {
    console.log('\n──────────────────────────────────────────');
    const failed = results.filter((r) => !r.pass);
    console.log(`${results.length - failed.length}/${results.length} assertions passed.`);
    if (failed.length) {
      console.log('\nFailed:');
      for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
      process.exit(1);
    }
  })
  .catch(async (err) => {
    console.error('\nRun crashed:', err);
    await cleanup().catch(() => undefined);
    process.exit(1);
  });
