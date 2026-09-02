# ADR-0003 — Economics are frozen at acceptance

- **Status:** Accepted · **Date:** Phase 7 · **Owner:** Founder / Product

## Context

Provider compensation was computed on demand from the active configuration.
Changing the commission would therefore have changed what somebody was owed for
work already agreed.

## Decision

At acceptance, the request records the amounts **and** the configuration
version that produced them. `request_provider_compensation()` returns the
frozen value and never recomputes.

## Consequences

- A rate change cannot reprice past work.
- "Why was I paid this?" is answerable years later.
- A supplement's share is computed against the job's frozen configuration, not
  today's — including supplements approved long after acceptance.
- `NULL` means no configuration was active. It is never rendered as `$0`.
