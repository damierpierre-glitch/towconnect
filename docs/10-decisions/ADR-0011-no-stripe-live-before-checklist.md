# ADR-0011 — No Stripe live mode before the live checklist

- **Status:** Accepted
- **Date:** 2026-09-02
- **Owner:** Founder / Finance
- **Related:** ADR-0006 (sandbox-only finance), `04-finance/stripe-live-readiness.md`

## Context

ADR-0006 established that the finance layer is built and proven in Stripe's
sandbox. Phase 10 asks whether a closed pilot with real users changes that.

## Decision

It does not. Stripe stays in test mode through the pilot. Live mode requires
the eleven-item checklist in `04-finance/stripe-live-readiness.md`, and the
first three items are not engineering work:

1. The platform's Connect identity verification is finished (one requirement
   outstanding: proof of liveness).
2. **A sandbox transfer has actually executed.** Until money has moved in test
   mode, "the partner gets paid" is an untested claim — the ledger says
   *internal payout prepared*, which is a different sentence from *Stripe
   transfer executed*.
3. A commission rate exists. `pricing_configured()` returns `false`, so no job
   can be priced in production at all.

## Consequences

- The application refuses a live secret key at startup, and a unit test asserts
  the refusal. Going live is a deliberate act, not a configuration drift.
- A pilot that cannot charge real money is a pilot that answers operational
  questions rather than commercial ones. That is the right order.
- `finance.payout_execution` is recorded as a **blocked** launch item, not a
  green one, and blocks the go/no-go.

## What was rejected

*Go live for the pilot so the first jobs are real transactions.* Every part of
the chain that live mode would exercise is already exercised in the sandbox by
125 assertions. The only thing live mode adds at this stage is the cost of a
mistake.
