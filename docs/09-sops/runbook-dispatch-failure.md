# Runbook — Nobody is being matched

- **Owner:** Founder / Product (future: Operations)
- **Status:** Active
- **Last reviewed:** 2026-09-02
- **Review cycle:** After any dispatch incident
- **Related systems:** `dispatch_candidates()`, `/dashboard/admin/operations/dispatch`

## Symptom

`no_candidate_found` or `request_pending_too_long` in the attention queue, or a
customer reporting nobody has come.

## Steps

1. **Open the job** → Dispatch tab. This is the engine's own answer, not a
   reconstruction.
2. **Read the first failing rule** for each candidate. The most common are:
   - `stale_heartbeat` — drivers are online but their apps stopped reporting.
     Check `/dashboard/admin/operations/directory` for how many are stale.
   - `outside_company_service_area` — no company covers this location.
   - `regulated_zone_not_authorized` — the law restricts who may tow here.
     This is not a failure to fix; it is the answer.
   - `documents_not_in_good_standing` — a compliance backlog. Check pending
     document reviews.
3. **If every candidate is `already_on_a_job`**, there is no capacity. Say so
   to the customer rather than leaving them waiting.
4. **Open an incident** of type `dispatch_failure` if a person had to
   intervene, so the KPI "requests needing human" reflects reality.

## What not to do

Do not reassign a driver into a regulated zone they are not authorized for. The
database will refuse it, and attempting it is a compliance event in itself.
