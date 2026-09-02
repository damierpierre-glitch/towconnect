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
