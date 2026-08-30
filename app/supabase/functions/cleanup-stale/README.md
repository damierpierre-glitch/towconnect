# cleanup-stale

Runs `cleanup_stale()` (defined in [`0002_hardening.sql`](../../migrations/0002_hardening.sql)) every minute:

- flips `pending` requests older than 10 minutes to `expired`
- flips `is_online` drivers with no heartbeat in the last 3 minutes back to offline

The function itself only invokes the Postgres function with the service role key — all the actual logic is in SQL.

## Deploy

```bash
supabase functions deploy cleanup-stale
```

## Schedule it (pick one)

### Option A — Dashboard Cron Jobs UI (recommended, no secrets in code)

1. Supabase Dashboard → **Integrations → Cron Jobs → Create a new cron job**.
2. Type: **Supabase Edge Function**, target `cleanup-stale`.
3. Schedule: `* * * * *` (every minute).

The dashboard handles auth for you — the request arrives with the service role key already set as the bearer token, matching the check in `index.ts`.

### Option B — pg_cron + pg_net from SQL

Only use this if you need the schedule itself under version control. **Do not commit the service role key.** Store it first:

```sql
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

-- Run once, replacing the placeholders — this stores the key in the
-- Supabase Vault, not as a plain-text literal in a migration file.
select vault.create_secret('<your-service-role-key>', 'service_role_key');
```

Then schedule it, reading the key back out of the vault at call time:

```sql
select cron.schedule(
  'cleanup-stale-every-minute',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/cleanup-stale',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body := '{}'::jsonb
  );
  $$
);
```

Replace `<project-ref>` with your project's ref (visible in the project URL).

## Verify it's running

```sql
select * from cron.job_run_details order by start_time desc limit 5;
```

Or check `driver_profiles.last_heartbeat_at` / `requests.status = 'expired'` directly.
