# KPI Definitions

- **Owner:** Founder / Product (future: Data)
- **Status:** Active
- **Last reviewed:** 2026-09-02
- **Review cycle:** Whenever `ops_kpis()` changes
- **Related systems:** `ops_kpis()`, `request_events`

**These are transcribed from `ops_kpis()`. There is no second definition
anywhere.** If this table and that function disagree, the function is right and
this document is a bug.

| KPI | Definition |
| --- | --- |
| Time to Match | first `matched` event − `requests.created_at` (median) |
| Time to Arrival | first `arrived` event − `requests.created_at` (median) |
| Match rate | requests that ever reached `matched` ÷ requests created |
| Acceptance rate | offers accepted ÷ offers made |
| Completion rate | requests completed ÷ requests that ever matched |
| Cancellation rate | requests cancelled ÷ requests created |
| Requests needing human | requests with at least one incident attached |
| Regulated-zone requests | requests with `regulated_zone_id` not null |
| Failed payment rate | requests whose latest payment is `failed` ÷ requests with a payment |

## Two properties that are part of the definition

**Timings come from `request_events`.** That table is written by a trigger on
`requests`, so it captures every path to a status. It also means a request
whose status changes predate the table has **no** timing — and nothing is
back-filled or estimated.

**A rate over an empty denominator is `NULL`, never `0`.** "Nothing happened"
and "everything failed" are different facts, and a `0 %` reads as the second.

## The funnel is a different measurement, and says so

`funnel_summary()` (Phase 10) measures how many people reach each step of
acquisition. It is **not** a second definition of anything above:

- It counts **browser events**, which can be missed — a closed tab, a blocked
  script. `ops_kpis()` counts database facts, which cannot.
- Its conversion is computed on distinct **sessions**, not events, so a page
  that mounts twice is one session.
- A `NULL` conversion means the previous step never happened, not 0 %.

**When a number matters, take it from `ops_kpis()`.** The funnel answers where
people stopped; the KPIs answer what the platform did. The full event list is
`05-data/analytics-events.md`.

## Phone-call-required rate

`requests_needing_human ÷ requests created`, both from `ops_kpis()`. It is the
number a pilot is actually for: it says how much of the platform is still a
person. It only means anything if every intervention is recorded as an
incident, which is why `06-support/pilot-support-runbook.md` insists on it.
