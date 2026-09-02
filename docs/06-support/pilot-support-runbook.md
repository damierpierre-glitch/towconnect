# Pilot support runbook

- **Owner:** Founder / Support
- **Status:** Active
- **Last reviewed:** 2026-09-02
- **Review cycle:** Weekly during the pilot
- **Related systems:** `/dashboard/admin/operations/support`, `operational_incidents`, `has_admin_capability()`

Eight situations that will actually happen during a Montréal & Rive-Sud pilot.
For each: who looks, what they may see, what they may do, and when it stops
being theirs.

**Two standing rules.**

1. **Capabilities are not advisory.** Support can read a job and its timeline.
   Support cannot refund, cannot pay out, cannot change a zone. That is
   enforced in the database, so "just this once" is not available — escalate
   instead.
2. **Every case where a human had to intervene gets an incident.** Not for
   process theatre: `ops_kpis().requests_needing_human` is built from
   incidents, and an unrecorded intervention makes the platform look more
   autonomous than it is.

---

## Escalation table

| # | Situation | Who looks | What they read | What they may do | Escalate when |
| --- | --- | --- | --- | --- | --- |
| 1 | Customer stuck before a match | Support | Job + dispatch explanation | Explain honestly; open an incident | No candidate at all after 10 min → Operations |
| 2 | Driver cannot find the customer | Support | Job, both positions, chat | Relay in chat; ask the customer to describe a landmark | Driver has been circling > 10 min → Operations |
| 3 | Payment failed | Support | Payment status only | Explain, ask them to add another card | Any money movement → Finance |
| 4 | Refund requested | Support | Job, payment | Nothing. Record the request | Always → Finance |
| 5 | Supplement uncollected | Support | Supplement state | Explain what was agreed | Collection or write-off → Finance |
| 6 | Technical fault | Support | Health screen | Open an incident | Component `attention` → Operations |
| 7 | Regulated zone | Support | Zone instruction shown to the customer | Repeat the official instruction verbatim | Customer disputes it → Operations, never a workaround |
| 8 | Safety incident | Whoever answers | Whatever is needed | **Call 911 first** | Immediately → Founder |

---

## 1. The customer is stuck before a match

**What they say:** "Nobody has come." "It says searching."

Open the job → Dispatch tab. That is the engine's own answer, not a
reconstruction. Read the first failing rule per candidate.

- Candidates exist and are being offered → say so, with the truth: *"An offer
  is out to a driver now; if they do not answer within a few seconds it moves
  to the next."*
- `no_candidate_found` → **do not say "soon".** Say there is nobody available
  in the area right now, and tell them what their options are. The one thing
  that makes this worse is a made-up arrival time.
- `regulated_zone_not_authorized` → this is not a failure. Read them the
  official instruction from the job's zone.

Open an incident of type `dispatch_failure` if you intervened at all.

## 2. The driver cannot find the customer

Open the job → the map shows both positions and the age of the driver's last
one. If the driver's position is stale, say so: *"Their app has not reported
for four minutes"* is more useful than guessing.

Relay in the chat rather than passing telephone numbers around. The chat is
attached to the job, so whoever picks the case up next can see what was said.

## 3. A payment failed

Support may read the payment state. Support may not retry, refund or capture.

Say what is true: nothing has been charged, and the card needs replacing before
dispatch can start. `payment_unresolved` in the attention queue is the same
event from the operator's side — check it is there.

## 4. A refund is requested

Record the request, the job, and the customer's reason in an incident of type
`payment_issue`. Then stop. Refunds require the `finance` capability and are
authorized against the frozen economics of that job — see
`04-finance/refunds-and-payouts.md`.

Do not promise a refund. Say it has been passed to whoever decides, and when
they will hear back.

## 5. A supplement was never collected

An approved supplement that could not be charged appears in the attention queue
as `supplement_uncollected`. The provider has already been credited for the
work, so this is money the platform is owed, not the driver.

Support explains what was agreed and by whom. Whether to pursue it is a finance
decision and an open one — see the Phase 8.1 report.

## 6. Something is broken

Open `/dashboard/admin/operations/health`. Three states, and **`unknown` is not
`ok`** — it means the signal could not be read, which during a pilot deserves
the same attention as a failure.

If any component reads `attention`, the alert on the same screen carries the
action. Follow it, and if the fault is affecting customers, ask Operations to
pause intake (`09-sops/pilot-launch-runbook.md`) rather than letting more
people walk into it.

## 7. A regulated zone refused the request

Repeat the official instruction **verbatim**, including the number to call.
Never offer a workaround, never send a partner "anyway", never suggest the
customer move the vehicle out of the zone to get service. The restriction is
law; TowConnect's position on this is ADR-0001.

If the customer insists the rule does not apply, escalate to Operations with
the zone code. Do not argue about the law with somebody standing on a highway.

## 8. A safety incident

**Call 911 first, or tell them to.** Then open an incident of type
`customer_safety` at severity `high` or `critical`, and notify the founder
directly.

Do not investigate first. Do not collect details first. The incident record can
be written after the ambulance is called.

---

## What support may never do

- Move money in any direction.
- Change a regulated zone, a document status, or a driver's approval.
- Read another customer's job to "compare".
- Give out a driver's telephone number, or a customer's.
- Quote an arrival time the system did not compute.

Each of these is refused by the database as well as by this page. The page
exists so nobody has to discover the refusal in front of a customer.
