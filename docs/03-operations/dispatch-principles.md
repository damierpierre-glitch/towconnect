# Dispatch Principles

- **Owner:** Founder / Product (future: Head of Operations)
- **Status:** Active
- **Last reviewed:** 2026-09-02
- **Review cycle:** Quarterly, or on any change to `dispatch_candidates()`
- **Related systems:** `dispatch_candidates()`, `dispatch_offers`, `requests`

## One query is the truth

`dispatch_candidates()` (migration 0026) produces the candidate list, each
driver's eligibility, the first rule they failed, and the score. The engine
takes its top eligible row; the admin explain view renders all of it. **They
cannot disagree, because they are the same query.**

## Filters, in the order the product states them

An excluded driver is reported with the FIRST rule they failed, in this order:

1. `regulated_zone_not_authorized` — the law says they may not tow here
2. `documents_not_in_good_standing` — compliance
3. `service_not_compatible` — the truck cannot do this job
4. `outside_company_service_area` — the company does not serve here
5. `already_on_a_job`
6. `stale_heartbeat` — the app is not reporting
7. `already_offered_this_request`

## Scoring

`0.65 × proximity + 0.20 × rating + 0.15 × service compatibility`

The rating is Bayesian-shrunk toward the population mean (`driver_effective_rating()`),
so a driver with one five-star job does not outrank a proven one.

## Timings — and where they live

| Rule | Value | Defined in |
| --- | --- | --- |
| Offer window | 18 s | `dispatch_offer_window()` |
| Heartbeat freshness | 2 min | `driver_heartbeat_max_age()` |

The command centre **calls these functions**, it does not copy their values.
`ops_threshold_drift()` proves the numbers shown to an operator still match the
rules the engine enforces.

## Sequential, never broadcast

One offer at a time, enforced by a unique index. A declined or expired offer
advances to the next candidate in the same call — no cron dependency.
