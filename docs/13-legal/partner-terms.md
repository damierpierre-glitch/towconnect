# Partner terms — review record

- **Owner:** Founder / Legal
- **Status:** DRAFT — LEGAL REVIEW REQUIRED
- **Last reviewed:** 2026-09-02
- **Review cycle:** Before any partner signs anything
- **Related systems:** `src/lib/content/publicPages.ts` (`partner-terms`), `/conditions-partenaires`

The published text is at `/conditions-partenaires`.

## Claims, and how each was verified

| Claim | Verified against |
| --- | --- |
| Declining an offer carries no penalty | `respond_to_dispatch_offer()` advances to the next candidate; no score exists |
| A non-compliant driver cannot go online or be dispatched | `driver_online_blocked()` / `driver_dispatch_blocked()` (0025) |
| Compensation is frozen at acceptance | `economics_frozen_at` on `requests`; `test:finance` |
| Payouts run through Stripe Connect | `provider_payouts`, `connect_payouts_enabled` |
| Credited is not the same as paid | The finance screen distinguishes *internal payout prepared* from *Stripe transfer executed* |

## The two open points

1. **No commission rate.** These terms cannot be final without it. A partner
   asked to sign a compensation agreement with the rate missing is being asked
   to sign nothing.
2. **Insurance and liability are asserted, not established.** The draft says
   the towing company carries its own cover for damage during a job. That is a
   description of the intended arrangement. It has not been validated by an
   insurer or a lawyer, and whether TowConnect needs its own liability cover as
   an intermediary is an open question — recorded as the readiness item
   `legal.insurance`.

## What a reviewer must decide

1. Is the towing company an independent contractor under this arrangement, and
   does anything in the dispatch model risk re-characterising the relationship?
2. Who is liable to the customer for damage during a tow, and does TowConnect
   need its own cover regardless of the answer?
3. Does an intermediary arranging towing in Québec require a permit, a licence
   or a registration? This is recorded separately as
   `regulatory.operating_authority` and is the largest unknown in the pilot.
4. What notice period, if any, applies to a partner leaving or being removed?
