# ADR-0004 — The provider ledger is append-only

- **Status:** Accepted · **Date:** Phase 7 · **Owner:** Founder / Product

## Context

Provider balances could have been a stored number updated on each event. That
is simpler and it is how balances silently drift from the movements behind them.

## Decision

`provider_ledger_entries` refuses `UPDATE` — including for the service role —
and refuses `DELETE` while the company exists. Balances are **derived** by
`provider_balances()`. A correction is a new entry.

## Consequences

- No stored balance can contradict its movements.
- `available_at` is decided at insertion and never revised; releasing a held
  earning writes a **pair** of entries rather than editing one.
- A company's deletion cascades its ledger — the only way an entry leaves.
  Getting this wrong once made companies permanently undeletable (fixed in
  0040).
