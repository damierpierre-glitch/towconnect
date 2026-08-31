# dispatch-tick

Runs `process_dispatch_timeouts()` (defined in [`0006_smart_dispatch.sql`](../../migrations/0006_smart_dispatch.sql)):

- flips expired `dispatch_offers` (`status = 'offered'` past `expires_at`) to `timeout`, and clears `requests.driver_id` if it still points at that driver
- re-runs `dispatch_next_candidate()` for every `pending` request that is currently driverless, offering the next-best candidate

The function itself only invokes the Postgres function with the service role key — all the actual logic is in SQL, same pattern as [`cleanup-stale`](../cleanup-stale/README.md).

## Deploy

```bash
supabase functions deploy dispatch-tick
```

## Schedule it

**As of Phase 2.5, this cron is a backstop, not the primary latency path.** Two things now happen without waiting on it at all:

- An explicit decline (`respond_to_dispatch_offer(p_accept := false)`) advances to the next candidate in the same call — no cron involved.
- A silent timeout (driver never responds) is normally caught within a few seconds by `nudge_dispatch()`, polled every ~5s by both the rider's tracking screen and the offered driver's dashboard while a request is searching/waiting — see `TOWCONNECT_PHASE2_5_REPORT.md`. Either side's open tab is enough.

This tick only matters for the case where **every** relevant tab is closed (rider stepped away, driver's device died) — it's what eventually reclaims an abandoned offer with nobody around to nudge it. Offers use an 18-second window (`dispatch_offer_window()` in the migration); this tick doesn't need to run anywhere near that fast to be useful.

**Known limitation:** the Supabase Dashboard Cron Jobs UI and standard `pg_cron` syntax only support minute-level granularity out of the box. Since this is now a backstop rather than the primary mechanism, **scheduling it every minute is a fine, simple default** — sub-minute scheduling (below) is a nice-to-have, not a requirement. **This does not weaken security either way**: an expired offer can never be accepted or declined regardless of tick frequency — `respond_to_dispatch_offer()` checks `expires_at` inline on every call, independent of this function entirely.

Recommended default:

1. Supabase Dashboard → **Integrations → Cron Jobs → Create a new cron job**.
2. Type: **Supabase Edge Function**, target `dispatch-tick`.
3. Schedule: `* * * * *` (every minute), or a sub-minute schedule if your `pg_cron` version supports it.

### pg_cron + pg_net (sub-minute, if supported)

```sql
select cron.schedule(
  'dispatch-tick-every-15s',
  '15 seconds',
  $$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/dispatch-tick',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body := '{}'::jsonb
  );
  $$
);
```

Reuses the same `service_role_key` Vault secret set up for `cleanup-stale` — see its README for how to create it.

## Verify it's running

```sql
select * from dispatch_offers order by offered_at desc limit 10;
select * from cron.job_run_details order by start_time desc limit 5;
```
