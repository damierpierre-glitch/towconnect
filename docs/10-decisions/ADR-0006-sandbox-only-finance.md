# ADR-0006 — Finance stays in sandbox until launch

- **Status:** Accepted · **Date:** Phase 7 · **Owner:** Founder / Product

## Context

The money layer had to be built and proven before there were customers, but a
mistake with a live key moves real money belonging to real people.

## Decision

Every financial path calls `assertSandbox()`, which throws on a live key **and**
on any key it cannot classify. Sandbox-only is a property of the code, not a
note in a report.

## Consequences

- A `sk_live_` key makes the finance paths refuse rather than misbehave.
- An unrecognisable key is refused too: a key we cannot classify is a key we
  should not spend with.
- The whole chain has been executed against real Stripe sandbox — 125
  assertions — so "it should work" was replaced by "it did".
