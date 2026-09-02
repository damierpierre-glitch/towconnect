// Phase 9 — Safety Link, exercised as the three people involved.
//
// The customer who shares, the stranger who opens the link, and the attacker
// who has a request id but no token. The third one is the reason this file
// exists: the Safety Link is the first thing in TowConnect readable without an
// account, so "what can somebody see who should see nothing" is the question.
//
//   npm run test:safety
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();
import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js';

import { actAs } from './e2e/session';
import { createSafetyLink, getSafetyLinkStatus, revokeSafetyLink, viewSafetyLink } from '@/lib/actions/safety';
import { listNotifications, markNotificationRead, setNotificationPreference } from '@/lib/actions/notifications';

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const admin = createSupabaseClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
// The public page runs with no session at all. This is that client.
const anon = createSupabaseClient(SUPABASE_URL, ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const MTL = { lat: 45.5019, lng: -73.5674 };

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

interface Actor {
  id: string;
  token: string;
  client: SupabaseClient;
}
const createdUserIds: string[] = [];

async function makeActor(role: 'user' | 'driver', who: string): Promise<Actor> {
  const email = `p9s-${who}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const password = 'test-password-123!';
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { role, full_name: `Phase 9 ${who} Lastname` },
  });
  if (error || !data.user) throw new Error(`could not create ${who}: ${error?.message}`);
  createdUserIds.push(data.user.id);

  const client = createSupabaseClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  for (let attempt = 1; ; attempt++) {
    const { error: signInError } = await client.auth.signInWithPassword({ email, password });
    if (!signInError) break;
    if (!/rate limit/i.test(signInError.message) || attempt >= 5) {
      throw new Error(`could not sign in ${who}: ${signInError.message}`);
    }
    console.log(`  … auth rate limit, waiting 65s (${attempt}/4)`);
    await new Promise((r) => setTimeout(r, 65_000));
  }
  const { data: session } = await client.auth.getSession();
  return { id: data.user.id, token: session.session!.access_token, client };
}

async function main() {
  const rider = await makeActor('user', 'rider');
  const otherRider = await makeActor('user', 'other');
  const driver = await makeActor('driver', 'driver');

  await admin
    .from('driver_profiles')
    .update({
      approval_status: 'approved',
      is_online: true,
      current_lat: MTL.lat + 0.01,
      current_lng: MTL.lng + 0.01,
      last_heartbeat_at: new Date().toISOString(),
      license_plate: 'TEST-999',
    })
    .eq('profile_id', driver.id);

  const { data: request } = await rider.client
    .from('requests')
    .insert({
      user_id: rider.id,
      problem_type: 'battery',
      location_text: 'Phase 9 — safety link fixture',
      lat: MTL.lat,
      lng: MTL.lng,
      price_estimate: 70,
      notes: 'INTERNAL NOTE THAT MUST NEVER LEAK',
    })
    .select('id')
    .single();
  const requestId = request!.id as string;

  let token = '';

  try {
    // ================================================================
    sect('1. The customer creates a link for their own rescue');
    // ================================================================
    actAs(rider.token, 'rider');
    const created = await createSafetyLink(requestId);
    token = created.token;

    ok('a token is returned', token.length >= 40, `${token.length} chars`);
    ok(
      'the token is not the request id, and does not contain it',
      token !== requestId && !token.includes(requestId.slice(0, 8))
    );

    const { data: stored } = await admin
      .from('safety_links')
      .select('token_hash, request_id, expires_at')
      .eq('request_id', requestId)
      .is('revoked_at', null)
      .single();
    ok(
      'the plaintext token is nowhere in the database',
      stored!.token_hash !== token && stored!.token_hash.length === 64,
      'only a SHA-256 should be stored'
    );

    // ================================================================
    sect('2. A stranger with the link can watch');
    // ================================================================
    actAs(null, 'anonymous');
    const view = await viewSafetyLink(token);
    ok('the link resolves without any account', view != null);
    ok('it shows the operational state', Boolean(view?.operational_state), view?.operational_state);
    ok('it shows where the vehicle is', view?.pickup_lat === MTL.lat);

    // ================================================================
    sect('3. It shows only what a stranger needs');
    // ================================================================
    const serialized = JSON.stringify(view ?? {});
    ok(
      'the internal note is not in the payload',
      !serialized.includes('INTERNAL NOTE'),
      'a private note reached a public page'
    );
    ok('no price is exposed', !/\b70\b/.test(serialized) && !serialized.includes('price'), serialized.slice(0, 120));
    ok('no request id is exposed', !serialized.includes(requestId));
    ok('no customer identity is exposed', !serialized.includes(rider.id));
    ok(
      'the fields returned are exactly the documented projection',
      Object.keys(view ?? {}).length === 18,
      `${Object.keys(view ?? {}).length} fields`
    );

    // ================================================================
    sect('4. Once a driver is on the job, the link identifies them — no more');
    // ================================================================
    await admin.from('requests').update({ driver_id: driver.id, status: 'matched' }).eq('id', requestId);
    const matchedView = await viewSafetyLink(token);
    ok('the driver appears once assigned', matchedView?.driver_first_name === 'Phase');
    ok(
      'only the first name is shown, never the full name',
      !JSON.stringify(matchedView).includes('Lastname'),
      'a surname reached the public page'
    );
    ok('the truck can be identified', matchedView?.license_plate === 'TEST-999');
    ok(
      'the driver position comes with its age, so it cannot pass as current',
      matchedView?.driver_location_age_seconds != null,
      String(matchedView?.driver_location_age_seconds)
    );

    // A stale position must still be returned — with its age — rather than
    // silently drawn as if it were now.
    await admin
      .from('driver_profiles')
      .update({ last_heartbeat_at: new Date(Date.now() - 30 * 60_000).toISOString() })
      .eq('profile_id', driver.id);
    const staleView = await viewSafetyLink(token);
    ok(
      'a stale position is reported as stale rather than hidden or faked',
      (staleView?.driver_location_age_seconds ?? 0) > 1500,
      String(staleView?.driver_location_age_seconds)
    );
    await admin
      .from('driver_profiles')
      .update({ last_heartbeat_at: new Date().toISOString() })
      .eq('profile_id', driver.id);

    // ================================================================
    sect('5. Nobody else can reach it');
    // ================================================================
    ok('a wrong token resolves to nothing', (await viewSafetyLink('x'.repeat(43))) == null);
    ok('the request id is not a token', (await viewSafetyLink(requestId)) == null);

    // Another signed-in customer cannot see the link row, and cannot revoke it.
    const { data: crossRead } = await otherRider.client
      .from('safety_links')
      .select('id')
      .eq('request_id', requestId)
      .maybeSingle();
    ok("another customer cannot read somebody else's link", crossRead == null);

    const { error: crossRevoke } = await otherRider.client
      .from('safety_links')
      .update({ revoked_at: new Date().toISOString() })
      .eq('request_id', requestId);
    const stillLive = await viewSafetyLink(token);
    ok(
      "another customer cannot revoke somebody else's link",
      Boolean(crossRevoke) || stillLive != null,
      'a stranger turned off a live rescue link'
    );

    // The anon role must not be able to read the tables behind the page.
    const { data: anonRequests } = await anon.from('requests').select('id').eq('id', requestId);
    const { data: anonLinks } = await anon.from('safety_links').select('id');
    ok('an anonymous visitor cannot read requests directly', (anonRequests ?? []).length === 0);
    ok('an anonymous visitor cannot read safety_links directly', (anonLinks ?? []).length === 0);

    actAs(otherRider.token, 'another customer');
    let crossCreateRefused = false;
    try {
      await createSafetyLink(requestId);
    } catch {
      crossCreateRefused = true;
    }
    ok("another customer cannot create a link for somebody else's rescue", crossCreateRefused);

    // ================================================================
    sect('6. Revoking actually revokes');
    // ================================================================
    actAs(rider.token, 'rider');
    await revokeSafetyLink(requestId);
    ok('the revoked token stops working immediately', (await viewSafetyLink(token)) == null);
    ok('the customer sees no live link', (await getSafetyLinkStatus(requestId)) == null);

    const regenerated = await createSafetyLink(requestId);
    ok('a new link can be issued', (await viewSafetyLink(regenerated.token)) != null);
    ok(
      'and the old one never comes back to life',
      (await viewSafetyLink(token)) == null,
      'a revoked token started working again'
    );
    token = regenerated.token;

    // ================================================================
    sect('7. Expiry is enforced by the database, not by the page');
    // ================================================================
    await admin
      .from('safety_links')
      .update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
      .eq('request_id', requestId)
      .is('revoked_at', null);
    ok('an expired token resolves to nothing', (await viewSafetyLink(token)) == null);

    // ================================================================
    sect('8. Notifications follow the rescue, and only reach their owner');
    // ================================================================
    actAs(rider.token, 'rider');
    const riderNotifications = await listNotifications();
    ok(
      'matching the rider with a driver notified them',
      riderNotifications.some((n) => n.type === 'driver_found' && n.request_id === requestId),
      riderNotifications.map((n) => n.type).join(', ') || 'none'
    );
    ok(
      'the notification carries facts, not a finished sentence',
      riderNotifications.find((n) => n.type === 'driver_found')?.payload?.driver_first_name === 'Phase'
    );

    await admin.from('requests').update({ status: 'en_route' }).eq('id', requestId);
    await admin.from('requests').update({ status: 'arrived' }).eq('id', requestId);
    const progressed = await listNotifications();
    ok(
      'each step of the rescue produced its own notification',
      ['driver_found', 'driver_en_route', 'driver_arrived'].every((t) =>
        progressed.some((n) => n.type === t)
      ),
      progressed.map((n) => n.type).join(', ')
    );

    actAs(otherRider.token, 'another customer');
    const strangerInbox = await listNotifications();
    ok(
      "one customer cannot read another's notifications",
      !strangerInbox.some((n) => n.request_id === requestId),
      'a notification leaked to another account'
    );

    actAs(rider.token, 'rider');
    const first = progressed[0];
    await markNotificationRead(first.id);
    const afterRead = await listNotifications();
    ok('a notification can be marked read', afterRead.find((n) => n.id === first.id)?.read_at != null);

    // Only the read state may change: the text of a delivered notification is
    // a record of something.
    const { error: tamper } = await rider.client
      .from('notifications')
      .update({ payload: { driver_first_name: 'Someone else' } } as never)
      .eq('id', first.id);
    ok('a delivered notification cannot be rewritten', Boolean(tamper));

    let criticalRefused = false;
    try {
      await setNotificationPreference('job_progress', false);
    } catch {
      criticalRefused = true;
    }
    ok('progress notifications about an active rescue cannot be switched off', criticalRefused);

    await setNotificationPreference('messages', false);
    ok('a non-critical category can be switched off', true);
    const { data: prefRow } = await admin
      .from('notification_preferences')
      .select('in_app')
      .eq('profile_id', rider.id)
      .eq('category', 'messages')
      .single();
    ok('and the choice is stored', prefRow!.in_app === false);
  } finally {
    section = 'Cleanup';
    await admin.from('safety_links').delete().eq('request_id', requestId);
    await admin.from('requests').delete().eq('id', requestId);
    for (const id of createdUserIds) {
      await admin.from('notification_preferences').delete().eq('profile_id', id);
      await admin.auth.admin.deleteUser(id);
    }

    const { data: leftoverUsers } = await admin.auth.admin.listUsers({ perPage: 200 });
    ok(
      'no fixture account is left behind',
      leftoverUsers.users.filter((u) => (u.email ?? '').startsWith('p9s-')).length === 0
    );
    const { data: leftoverLinks } = await admin.from('safety_links').select('id');
    ok('no safety link is left active', (leftoverLinks ?? []).length === 0, `${(leftoverLinks ?? []).length}`);
  }
}

main()
  .then(() => {
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length} passed, ${failed.length} failed.`);
    if (failed.length) {
      console.log('\nFailures:');
      for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
      process.exit(1);
    }
  })
  .catch((err) => {
    console.error('\nSafety Link tests crashed:', err);
    process.exit(1);
  });
