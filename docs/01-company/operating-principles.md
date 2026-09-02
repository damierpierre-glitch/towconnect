# Operating Principles

- **Owner:** Founder / Product
- **Status:** Active
- **Last reviewed:** 2026-09-02
- **Review cycle:** Every phase
- **Related systems:** all

These are not aspirations. Each one is enforced somewhere in the code, and the
enforcement point is named.

## 1. Regulation before commercial preference

A commercial arrangement can never make an illegal dispatch legal. In
`dispatch_candidates()` (0026) preference is read **after** every filter has
run, and a preferred partner's advantage is capped at 60 seconds — it cannot
make an unauthorized provider authorized, an incompatible truck compatible, or
a non-compliant driver dispatchable.

See `10-decisions/ADR-0001-regulation-before-preference.md`.

## 2. Never invent data

No fake driver, no fake availability, no fake rating, no fake ETA, no invented
regulatory boundary, no invented coverage claim.

Concretely:
- a driver with no completed job has **no** rating — the 5.0 default is never
  exported or displayed as if earned;
- an ETA is shown only when there is a fresh driver position to compute it
  from; otherwise the absence is named (`04-finance` has the equivalent rule
  for money);
- Québec's regulated zones are recorded and **inactive**, because no official
  geospatial boundary was found.

## 3. NULL is not zero

"Nobody has decided this" and "the answer is zero" are different facts, and
collapsing them is how a system starts lying quietly.

- no commission configured → provider compensation is `NULL`, never `$0`;
- a rate over an empty denominator → `NULL`, never `0 %`;
- no cancellation policy → `NULL`, not a zero fee.

## 4. The database is the barrier

RLS and `SECURITY DEFINER` guards are the protection. UI checks exist so people
are not offered doors that will not open — they are never the control.

A corollary learned the hard way (0039): a guard written as
`auth.role() <> 'service_role' and ...` fails **open** when the claim is NULL.
Every term must be null-safe.

## 5. Money is frozen at the moment it is agreed

A job's economics are captured at acceptance and never recomputed. A later rate
change cannot reprice work somebody already agreed to.

## 6. Corrections are new facts, not edits

The provider ledger refuses `UPDATE`. A risk observation cannot be rewritten. A
delivered notification cannot be re-worded. Where something must change, a new
row records the change — so the history still says what happened.

## 7. Verify by database effect, never by the absence of an error

Twice in this project's history a clean HTTP response covered a write that did
nothing. Every verification script asserts on rows, not on status codes.
