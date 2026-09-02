# Terms of service — review record

- **Owner:** Founder / Legal
- **Status:** DRAFT — LEGAL REVIEW REQUIRED
- **Last reviewed:** 2026-09-02
- **Review cycle:** Before the pilot opens to anybody outside the allowlist
- **Related systems:** `src/lib/content/publicPages.ts` (`terms`), `/conditions`

The published text is at `/conditions`. This page records what it claims and
what it cannot yet claim.

## Claims, and how each was verified

| Claim | Verified against |
| --- | --- |
| TowConnect is an intermediary; the work is done by independent companies | No TowConnect-owned vehicle or employed driver exists in the model |
| The price is shown before confirmation | `StepEstimate` renders it; the amount charged is computed server-side |
| Payment is authorized then captured at completion | Manual-capture PaymentIntents; `test:finance` asserts the sequence |
| A supplement requires the customer's acceptance | `request_supplements` status transitions, guarded by trigger |
| Cancellation uses the economics frozen at creation | `economics_frozen_at`, `pricing_config_id` on `requests` |
| Regulated zones are refused, not worked around | ADR-0001; `verify:phase6_1` |
| No commission rate is configured | `pricing_configured()` returns `false` |

## The open point that blocks finalisation

**The commission is not decided.** A terms document that describes how a
customer is charged, while the platform cannot price a job at all, is not a
finished document. The draft says so explicitly rather than leaving a blank.

## What a reviewer must decide

1. Is the intermediary framing adequate to limit TowConnect's liability for the
   tow itself, under Québec consumer law?
2. Are the cancellation terms enforceable as described, given that the fee is
   computed from a snapshot the customer never sees?
3. Is a distance-selling / cooling-off provision required for a service
   requested and performed immediately?
4. What must be said about the absence of any availability or response-time
   guarantee, to make the absence itself enforceable?
