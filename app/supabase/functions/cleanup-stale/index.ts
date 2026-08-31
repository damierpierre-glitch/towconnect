// Runs on a schedule (see README.md in this folder) to keep two things from
// going stale: pending requests nobody ever matched, and drivers whose app
// stopped sending location pings without explicitly going offline.
//
// All the actual logic lives in the cleanup_stale() Postgres function
// (supabase/migrations/0002_hardening.sql) — this function's only job is to
// invoke it with a privileged key, since cleanup_stale() is intentionally
// not exposed to anon/authenticated clients.
import { createClient } from 'jsr:@supabase/supabase-js@2';

// Only the scheduler may invoke this: it runs privileged maintenance logic.
//
// The trust anchor is CRON_SECRET, an explicit secret set once in the
// project's Edge Function secrets. This used to compare against
// SUPABASE_SERVICE_ROLE_KEY instead, which on this project rejects every
// caller — including one carrying the real legacy service_role key — and
// which Supabase now marks DEPRECATED in favour of SUPABASE_SECRET_KEYS.
// That was a live defect, not a theoretical one: this function had been
// deployed for a day and would have silently done nothing on every run. The
// legacy key is still accepted when the platform provides it, so existing
// deployments keep working.
//
// Fails closed: with neither secret configured, nothing is accepted.
function isAuthorizedCron(req: Request): boolean {
  // The secret travels in its own header, NOT in Authorization. With the
  // function's "Verify JWT" setting enabled, the platform rejects any
  // Authorization header that is not a valid JWT before our code ever runs —
  // an opaque shared secret there is answered with
  // UNAUTHORIZED_INVALID_JWT_FORMAT. Keeping Authorization free for the
  // platform's JWT (the public anon key is enough to satisfy it) and putting
  // our real check in x-cron-secret means this works whether Verify JWT is on
  // or off. Security rests on x-cron-secret, never on the anon key.
  const provided = (
    req.headers.get('x-cron-secret') ??
    (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  ).trim();
  if (!provided) return false;

  // Constant-time compare — a plain !== leaks how much of the secret a
  // guesser got right through response timing.
  const matches = (a: string, b: string) => {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  };

  return [Deno.env.get('CRON_SECRET'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')]
    .map((v) => (v ?? '').trim())
    .filter((v) => v.length > 0)
    .some((expected) => matches(provided, expected));
}

Deno.serve(async (req) => {
  if (!isAuthorizedCron(req)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const url = Deno.env.get('SUPABASE_URL')!;
  // Explicit secret first. The platform's own SUPABASE_SERVICE_ROLE_KEY is
  // kept only as a fallback: it is deprecated, and the default secret set now
  // exposes SUPABASE_SECRET_KEYS (a JSON dictionary) rather than a single
  // ready-to-use key, so relying on it is exactly what broke this before.
  const dbKey = Deno.env.get('CRON_DB_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!dbKey) {
    console.error('No privileged database key available to cleanup-stale');
    return new Response(JSON.stringify({ ok: false, error: 'no database key configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(url, dbKey);

  const { data, error } = await supabase.rpc('cleanup_stale');

  if (error) {
    console.error('cleanup_stale failed', error);
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ ok: true, result: data }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
