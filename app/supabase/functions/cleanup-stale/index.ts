// Runs on a schedule (see README.md in this folder) to keep two things from
// going stale: pending requests nobody ever matched, and drivers whose app
// stopped sending location pings without explicitly going offline.
//
// All the actual logic lives in the cleanup_stale() Postgres function
// (supabase/migrations/0002_hardening.sql) — this function's only job is to
// invoke it with the service role, since cleanup_stale() is intentionally
// not exposed to anon/authenticated clients.
import { createClient } from 'jsr:@supabase/supabase-js@2';

Deno.serve(async (req) => {
  // Edge Functions are invoked over HTTP; without this, anyone who finds the
  // URL could trigger it. The scheduler (pg_cron via pg_net, or the Dashboard
  // Cron Jobs UI) sends the project's own service role key as the bearer
  // token — see README.md for how that's wired up.
  // SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are auto-injected by the
  // Supabase platform into every Edge Function — no manual secret setup
  // needed for these two.
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const authHeader = req.headers.get('Authorization') ?? '';
  if (authHeader !== `Bearer ${serviceRoleKey}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, serviceRoleKey);

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
