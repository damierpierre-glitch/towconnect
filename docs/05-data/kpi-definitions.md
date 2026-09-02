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
