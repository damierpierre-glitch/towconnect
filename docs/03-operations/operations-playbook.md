# Operations Playbook

- **Owner:** Founder / Product (future: Head of Operations)
- **Status:** Active
- **Last reviewed:** 2026-09-02
- **Review cycle:** Monthly
- **Related systems:** `/dashboard/admin/operations`

## The screen to open on shift

`/dashboard/admin/operations` — the attention queue. It contains only things a
person can act on. If it is empty, that is a result.

## What each queue item means, and what to do

| Item | What happened | First move |
| --- | --- | --- |
| `no_candidate_found` | Dispatch ran and found nobody | Open the job → Dispatch tab → read the first failing rule per driver |
| `request_pending_too_long` | Nobody has matched it | Same; check whether any driver is online in that area |
| `assigned_driver_stale` | The assigned driver's app stopped reporting | Contact the driver; consider reassigning |
| `regulated_capacity_wait` | Regulated zone, no authorized provider free | Tell the motorist honestly; there is no dispatch to force |
| `payment_failed` | The card was refused | Support contacts the customer; the job is not blocked by this |
| `supplement_uncollected` | Approved extra could not be charged | Finance decides whether to collect separately |
| `supplement_charge_failed` | Stripe refused the extra | Same |
| `supplement_awaiting_authentication` | The customer's bank wants confirmation | Customer must act; nothing is owed to the provider yet |
| `refund_unresolved` | A refund is pending or failed | Finance |
| `payout_awaiting_action` | A payout is prepared, not sent | Finance |
| `connect_payouts_disabled` | A company cannot be paid | Operations: chase their Stripe onboarding |
| `open_incident` | Somebody opened one | Whoever is assigned |

## Thresholds

Two are **derived** from rules the dispatch engine enforces (heartbeat, offer
window) and cannot drift. Two are **engineering defaults**, labelled as such on
screen: `pending_without_match` (5 min) and `payment_unresolved` (1 h). Neither
is a service-level commitment — **no SLA has been agreed**, and these numbers
must not be quoted as one.

## Incidents

Four statuses: `open` → `investigating` → `resolved` / `dismissed`. The status
history is written by a database trigger, so "who dismissed this, and when" is
always answerable. Resolving requires a note.

---

## Phase 10 — the pilot, health and alerts

### The pilot switch

`/dashboard/admin/operations/pilot`. Three modes, changed without a deploy:
`off` behaves exactly as before the pilot existed, `pilot` enforces territory,
hours and any allowlist, `paused` refuses new requests with the reason you
write. **Pausing never touches a job already running.**

Enforcement is a `BEFORE INSERT` trigger on `requests`, so it cannot be walked
around by a code path that forgets to check. The full procedure — prelaunch,
T-24h, first request, incident, pause, reopen, end of day — is
`09-sops/pilot-launch-runbook.md`.

### Platform health

`/dashboard/admin/operations/health`. Seven components, and **three** states.

`unknown` is the one to read carefully: it means the signal could not be read,
not that the component is fine. A health board that renders green because it
failed to ask the question converts an outage into a reassurance.

| Component | What "attention" means |
| --- | --- |
| Database | Not reachable at all |
| Scheduler (pg_cron) | No run in five minutes, or a failed run. Dispatch timeouts and stale-job cleanup are stopped |
| Stripe webhook | Payments unresolved past the threshold, or no event ever recorded |
| Dispatch | Requests pending with no live offer |
| Realtime | No table published — tracking and chat stop updating live |
| Finance reconciliation | The ledger, the payments and the payouts disagree |
| Administrative access | Nobody holds `super_admin` |

### Alerts

The same screen. **An alert list that is usually non-empty trains people to
ignore it**, so the test for inclusion is hard: if the honest response is "yes,
I know", it is a number and belongs on the KPI screen instead.

Each alert carries the action it requires. Two do not come from health:

- **`pilot_paused`** — intake is closed. A pause nobody lifts is an outage
  nobody reported.
- **`partner_cannot_be_paid`** — a `ready` or `active` partner whose Connect
  account cannot pay out. A commitment we cannot honour, better found now than
  after their first job.

There is **no alert delivery yet**. Alerts appear on this screen and nowhere
else, which is acceptable only while somebody is watching it.

### The go/no-go checklist

`pilot_go_no_go()` combines computed criteria with the human judgements
recorded in `launch_readiness_items`. A criterion nobody has decided reports
**undecided**, never *pass* — an unmade decision must not be able to look like
a made one.
