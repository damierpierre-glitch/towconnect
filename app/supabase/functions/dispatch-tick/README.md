# dispatch-tick

Runs `process_dispatch_timeouts()` (defined in [`0006_smart_dispatch.sql`](../../migrations/0006_smart_dispatch.sql)):

- flips expired `dispatch_offers` (`status = 'offered'` past `expires_at`) to `timeout`, and clears `requests.driver_id` if it still points at that driver
- re-runs `dispatch_next_candidate()` for every `pending` request that is currently driverless, offering the next-best candidate

The function itself only invokes the Postgres function with a privileged key — all the actual logic is in SQL, same pattern as [`cleanup-stale`](../cleanup-stale/README.md).

## How it authenticates the caller

Identical to `cleanup-stale`: the shared secret travels in the **`x-cron-secret`** header (`CRON_SECRET`), `Authorization` carries a JWT only because the platform's "Verify JWT" gate demands one (the public anon key is enough), and the database key comes from `CRON_DB_KEY`. See [that README](../cleanup-stale/README.md#how-it-authenticates-the-caller) for why — it is the fix for a real outage, not a preference.

## Deploy

```bash
supabase functions deploy dispatch-tick
```

## Schedule it

**As of Phase 2.5, this cron is a backstop, not the primary latency path.** Two things now happen without waiting on it at all:

- An explicit decline (`respond_to_dispatch_offer(p_accept := false)`) advances to the next candidate in the same call — no cron involved.
- A silent timeout (driver never responds) is normally caught within a few seconds by `nudge_dispatch()`, polled every ~5s by both the rider's tracking screen and the offered driver's dashboard while a request is searching/waiting — see `TOWCONNECT_PHASE2_5_REPORT.md`. Either side's open tab is enough.

This tick only matters when **every** relevant tab is closed (rider stepped away, driver's device died) — it is what eventually reclaims an abandoned offer with nobody around to nudge it. Offers use an 18-second window (`dispatch_offer_window()` in the migration); this tick does not need to run anywhere near that fast to be useful, and running it slower never weakens security: `respond_to_dispatch_offer()` checks `expires_at` inline on every call, so an expired offer can never be accepted regardless of tick frequency.

**Supabase Dashboard → Integrations → Cron → Create job**

1. Name: `dispatch-tick-every-minute`
2. Schedule: `* * * * *`
3. Type: **Supabase Edge Function**, method `POST`, target `dispatch-tick`
4. HTTP headers:
   - `Authorization` → `Bearer <ANON_KEY>`
   - `x-cron-secret` → the `CRON_SECRET` value

Sub-minute schedules (`'15 seconds'`) work if the project's `pg_cron` supports them, via the SQL form shown in the [`cleanup-stale` README](../cleanup-stale/README.md#alternative-pg_cron--pg_net-from-sql). Nice to have, not required.

## Verify it's actually working

`npm run verify:functions` (from `app/`) is the real check: it offers a request to the nearest of two drivers through the deployed endpoint, ages that offer past its window, ticks again, and asserts that the offer is `timeout` in the database and that the request has moved to the next candidate — with no browser tab open anywhere. HTTP 200 on its own proves nothing.

For the schedule specifically:

```sql
select jobname, schedule, active from cron.job;
select status, return_message, start_time from cron.job_run_details order by start_time desc limit 5;
select * from dispatch_offers order by offered_at desc limit 10;
```
