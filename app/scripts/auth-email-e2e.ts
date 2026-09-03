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
const ALLOWED_ORIGIN = 'https://towconnect-chi.vercel.app';

function freshClient() {
  return createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
}

// @example.com is rejected outright by Supabase's address validation — worth
// knowing, because the other E2E suites get away with it only by creating
// users through the admin API, which skips that check.
const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function main() {
  const emailPublic = `p10-auth-public-${stamp()}@towconnect.ca`;
  const emailLink = `p10-auth-link-${stamp()}@towconnect.ca`;

  // ================================================================
  sect('1. The public signup path — the one a customer uses');
  // ================================================================
  const { data: signup, error: signupError } = await freshClient().auth.signUp({
    email: emailPublic,
    password: PASSWORD,
    options: { data: { role: 'user', full_name: 'Auth Lifecycle Public' } },
  });

  const rateLimited = /rate limit/i.test(signupError?.message ?? '');
  ok(
    'a new customer can sign up',
    !signupError,
    rateLimited
      ? 'EMAIL RATE LIMIT. Supabase’s built-in mailer allows 2 messages per hour for the whole ' +
        'project and cannot be raised without a custom SMTP provider. This is the launch blocker ' +
        'product.signup_email, reproduced.'
      : signupError?.message
  );
  ok('no session is issued before confirmation', signup.session == null);

  if (signup.user?.id) {
    const { data: listed } = await admin.auth.admin.listUsers({ perPage: 200 });
    const row = listed.users.find((u) => u.id === signup.user!.id) as
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
  sect('9. Cleanup');
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
