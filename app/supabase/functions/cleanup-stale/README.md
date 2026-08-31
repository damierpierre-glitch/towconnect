# cleanup-stale

Runs `cleanup_stale()` (defined in [`0002_hardening.sql`](../../migrations/0002_hardening.sql)) every minute:

- flips `pending` requests older than 10 minutes to `expired`
- flips `is_online` drivers with no heartbeat in the last 3 minutes back to offline

The function itself only invokes the Postgres function with a privileged key — all the actual logic is in SQL.

## How it authenticates the caller

This is privileged maintenance, so it must only ever run for the scheduler. Two Edge Function secrets carry that:

| Secret | Purpose |
|---|---|
| `CRON_SECRET` | The shared secret the caller must present in the **`x-cron-secret`** header. Compared in constant time; if it is unset, nothing is accepted. |
| `CRON_DB_KEY` | The privileged key used to reach the database. Falls back to the platform's `SUPABASE_SERVICE_ROLE_KEY` when that is still injected. |

**The secret does not go in `Authorization`.** With the function's "Verify JWT" setting enabled, the platform rejects any `Authorization` value that is not a valid JWT (`UNAUTHORIZED_INVALID_JWT_FORMAT`) before this function's code ever runs. So `Authorization` carries a JWT — the public **anon** key is enough to satisfy the gate — and the real check lives in `x-cron-secret`. Security rests entirely on that header, never on the anon key.

> This replaced comparing the caller against `SUPABASE_SERVICE_ROLE_KEY`, which Supabase now marks deprecated (the default secret set exposes `SUPABASE_SECRET_KEYS`, a JSON dictionary, instead). That version rejected **every** caller — including one carrying the real service_role key — so this function spent a day deployed and silently doing nothing on each scheduled run. Returning HTTP 200 is not evidence that it works; check the database.

Set both secrets under **Edge Functions → Secrets** before scheduling anything.

## Deploy

```bash
supabase functions deploy cleanup-stale
```

## Schedule it

**Supabase Dashboard → Integrations → Cron → Create job**

1. Name: `cleanup-stale-every-minute`
2. Schedule: `* * * * *`
3. Type: **Supabase Edge Function**, method `POST`, target `cleanup-stale`
4. HTTP headers:
   - `Authorization` → `Bearer <ANON_KEY>`
   - `x-cron-secret` → the `CRON_SECRET` value

### Alternative: pg_cron + pg_net from SQL

Only if the schedule itself needs to be under version control. Keep both values in the Vault rather than as literals:

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret('<CRON_SECRET>', 'cron_secret');
select vault.create_secret('<ANON_KEY>', 'anon_key');

select cron.schedule(
  'cleanup-stale-every-minute',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/cleanup-stale',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'anon_key'),
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
```

## Verify it's actually working

`npm run verify:functions` (from `app/`) drives the deployed endpoint on every auth path and then asserts on rows: a driver whose heartbeat has gone stale really goes offline, and a long-unmatched pending request really becomes `expired`. It ages fixtures rather than changing thresholds.

For the schedule specifically:

```sql
select jobname, schedule, active from cron.job;
select status, return_message, start_time from cron.job_run_details order by start_time desc limit 5;
```
