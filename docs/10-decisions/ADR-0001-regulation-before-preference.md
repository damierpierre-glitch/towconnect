# ADR-0001 — Regulation before commercial preference

- **Status:** Accepted · **Date:** Phase 6 · **Owner:** Founder / Product

## Context

Commercial partnerships are a plausible revenue lever: a partner company could
pay to be offered jobs first. Some highways are legally restricted to providers
contracted by a public authority.

## Decision

Commercial preference is read **after** every eligibility filter, and is capped
at a 60-second head start. It can never make an unauthorized provider
authorized, an incompatible truck compatible, or a non-compliant driver
dispatchable.

## Consequences

- Preference is structurally incapable of causing an illegal dispatch.
- `head_start_seconds` defaults to 0, so a preference created without an
  explicit value does nothing.
- Revenue from preference is bounded by design. That is the point.
