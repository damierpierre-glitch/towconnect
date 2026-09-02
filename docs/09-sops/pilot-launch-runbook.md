# Runbook — Opening and closing the pilot

- **Owner:** Founder / Operations
- **Status:** Active
- **Last reviewed:** 2026-09-02
- **Review cycle:** Before each change of pilot mode, and after every pilot day
- **Related systems:** `pilot_config`, `pilot_gate()`, `guard_pilot_gate()`, `pilot_go_no_go()`, `/dashboard/admin/operations/pilot`

The pilot can be opened, narrowed, paused and reopened **without a deploy**.
Everything below is a change to one row in `pilot_config`, enforced by a
trigger on `requests` — so a forgotten code path cannot walk around it, and
nothing here requires an engineer.

## The three modes

| Mode | What happens to a new request | Jobs already running |
| --- | --- | --- |
| `off` | Accepted, exactly as before the pilot existed | Untouched |
| `pilot` | Checked against allowlist, hours and territory | Untouched |
| `paused` | Refused, with the reason you wrote shown to the customer | Untouched |

**Pausing never abandons anybody.** The gate is `BEFORE INSERT` on `requests`
only. A driver on the way to somebody keeps going, the chat keeps working, the
payment still captures at completion.

---

## Prelaunch — the day before

1. **Read the go/no-go screen.** `/dashboard/admin/operations/pilot`. Every
   criterion is computed or recorded; a criterion nobody has decided reads
   *undecided*, never *pass*.
2. **Every blocking readiness item is `ready` or `not_applicable`.** An item
   cannot be marked ready without evidence — the database refuses it.
3. **Decide the two numbers nobody has decided yet**, and record them:
   - `pilot_config.min_ready_partners` — how many ready partners before a
     customer may be refused for lack of capacity.
   - `pilot_config.hours_start` / `hours_end` — or leave both null and state
     explicitly that no hours are promised.
4. **Confirm at least one partner is genuinely ready**: `pilot_partner_readiness()`
   with an empty `blocking_reasons`, not merely a `ready` pilot status.
5. **Confirm the money side.** `npm run verify:finance`, and the finance screen
   shows zero reconciliation exceptions.
6. **Confirm Stripe is NOT live.** `npm run test` asserts it; check the key
   prefix as well. A pilot runs in the sandbox.

## T-24h

1. `npm run test:integration` — 213 RLS assertions against the live database.
2. `npm run verify:phase10` — the launch checklist, the gate, the analytics
   whitelist, the secret scan.
3. Read the health screen. Every component `ok`. **A component reading
   `unknown` is not a pass** — it means the signal could not be read.
4. Decide who is watching tomorrow, and from what device. There is no alert
   delivery yet: alerts appear on the operations screen and nowhere else.
5. Tell every `active` partner the pilot opens, and what to expect: offers
   arrive in the driver app, they may decline without penalty.

## Launch

1. Set `pilot_config.mode = 'pilot'` from the pilot screen.
2. Decide the allowlist. On for a genuinely closed pilot; off once you are
   willing to take a request from anybody in the territory. **An empty
   allowlist with the flag on means nobody** — which is a legitimate thing to
   want on the morning of a launch and a terrible accident to have.
3. Make one request yourself, from a phone, in the territory. Watch it reach a
   driver. Cancel it before anybody drives.
4. Watch `/dashboard/admin/operations` (the attention queue) and
   `/dashboard/admin/operations/health` for the first hour.

## The first real request

1. **Watch it, do not touch it.** The point of the first one is to find out
   what the system does unattended.
2. Note the timestamps yourself: request created, matched, arrived, completed.
   Compare afterwards with `ops_kpis()` — if they disagree, the instrumentation
   is wrong and that matters more than the numbers.
3. If dispatch finds nobody, **say so to the customer** rather than leaving
   them waiting. See `runbook-dispatch-failure.md`.
4. Open an incident for anything a human had to do. That is what makes
   "requests needing human" a real number instead of an impression.

## Incident during the pilot

1. Open an `operational_incident` immediately — before diagnosing. A missing
   incident is a KPI that lies.
2. Follow the specific runbook: dispatch, payment, safety link.
3. If the problem is systemic (dispatch failing repeatedly, payments failing,
   the scheduler down), **pause intake** rather than letting more people walk
   into it.

## Pause / rollback

1. Pilot screen → write the reason → **Mettre en pause**. The reason is shown
   to the customer, so write it for them, not for yourself:
   *"Aucun partenaire disponible ce soir"*, not *"dispatch bug"*.
2. Finish the jobs already running. Nothing about the pause touches them.
3. If the cause is a bad deploy, roll the deployment back. The pilot mode and
   the deployment are independent switches on purpose: you can close intake in
   ten seconds while the rollback takes minutes.

## Reopening

1. Confirm the cause is actually gone — not "probably gone".
2. Set the mode back to `pilot` (or `off`).
3. Tell anybody who was refused during the pause. They were told to try later;
   that is a promise.

## End of day

1. **Numbers:** `ops_kpis()` for the day. Time to match, time to arrival, match
   rate, completion rate, failed payment rate.
2. **Exceptions:** reconciliation exceptions must be zero before the day is
   considered closed.
3. **Incidents:** every one resolved or explicitly carried, with a note.
4. **Funnel:** `/dashboard/admin/operations/health`. Where did people stop?
5. **Partners:** anybody who declined every offer, or went offline mid-shift,
   is a conversation for tomorrow — not a penalty.
6. Write down one thing that surprised you. Pilots are for surprises; the point
   is to catch them while the number of people affected is still small.
