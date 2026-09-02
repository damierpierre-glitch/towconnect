# ADR-0007 — Supplements fall back to their own PaymentIntent

- **Status:** Accepted · **Date:** Phase 8.1 · **Owner:** Founder / Product

## Context

An approved supplement was added to the fare's existing authorization. Phase 7.1
proved against real Stripe that **this platform account is not eligible for
incremental authorization at all** — requesting it breaks every authorization.
So every approved supplement ended `uncollected` and the provider was credited
nothing. Safe, and useless.

## Decision

Try the incremental path first; on failure, charge the supplement on a
PaymentIntent of its own, captured immediately. Nothing is credited until
Stripe confirms.

## Consequences

- `requires_action` becomes a first-class state: money in flight is neither
  collected nor failed.
- Idempotency is structural — an idempotency key plus a `UNIQUE` intent id per
  supplement, and a `UNIQUE` ledger entry per supplement.
- A supplement is refundable independently of the fare.
- The provider's share is **marginal** (the job with it, minus without it),
  which is order-independent — the first version subtracted what the ledger
  already held and over-credited by the whole fare's share, because supplements
  settle before the job finishes.
