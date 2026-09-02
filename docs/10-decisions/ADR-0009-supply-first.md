# ADR-0009 — Supply before demand

- **Status:** Accepted
- **Date:** 2026-09-02
- **Owner:** Founder / Commercial
- **Related:** `12-commercial/30-day-pilot-plan.md`

## Context

Both sides of a marketplace can be grown first. Demand is easier to buy and
easier to measure, which is why it is usually chosen — and why marketplaces
usually fail at exactly the moment the traffic arrives.

For roadside assistance the asymmetry is extreme. A customer arrives at their
worst moment of the month, with no patience and no alternative in hand. A
failure to match is not a lost conversion; it is somebody standing beside a
highway who told a friend about us.

## Decision

No paid demand acquisition until there is supply that can serve it. The 30-day
plan spends its first two weeks entirely on towing companies. Demand channels
in the pilot are free and high-intent: partner counters with a QR code, local
search pages, word of mouth from completed jobs.

The minimum number of ready partners before opening beyond an allowlist is a
commercial decision recorded in `pilot_config.min_ready_partners`. It is
**deliberately null**: engineering has not chosen it, and a number invented
here would be quoted back as the answer.

## Consequences

- `pilot_go_no_go()` reports "Minimum ready partners" as **undecided** rather
  than as a pass. An unmade decision must not be able to look like a made one.
- The go/no-go screen counts partners with an **empty** `blocking_reasons`, not
  partners whose commercial status happens to say `ready`.
- The commercial plan's early targets are partner counts, not job counts.

## What was rejected

*Advertise first and recruit operators with the demand as proof.* It is a real
strategy and it works in categories where a failed request costs nothing. This
is not one of them.
