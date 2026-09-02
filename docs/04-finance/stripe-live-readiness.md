# Stripe live readiness — the checklist, and why it is not ticked

- **Owner:** Founder / Finance
- **Status:** Active
- **Last reviewed:** 2026-09-02
- **Review cycle:** Before any consideration of live mode
- **Related systems:** `src/lib/stripe/mode.ts`, `connect_status`, `provider_payouts`, `refunds`

**Stripe is in test mode and stays there.** Not as an oversight — the
application refuses a live secret key at startup, and a unit test asserts the
refusal. Going live is a deliberate act with the checklist below, and it is
outside the scope of a closed pilot.

## Why a pilot does not need live mode

A closed pilot answers "does the chain work". The sandbox answers that
completely: authorization, capture, supplements, partial and full refunds,
cancellation economics, ledger, payouts — 125 assertions run against real
Stripe test objects and real database rows. Nothing about live mode makes those
answers more true; it only makes the mistakes cost real money.

The one thing the sandbox cannot prove is that a real bank account receives a
real transfer. That is the last item, not the first.

## The checklist

Every line needs evidence, in the same spirit as `launch_readiness_items`.

| # | Item | State today |
| --- | --- | --- |
| 1 | Connect identity verification complete for the platform account | **One requirement outstanding**: `individual.verification.proof_of_liveness` |
| 2 | `charges_enabled` on the platform account | **True** |
| 3 | `payouts_enabled` on the platform account | Blocked by item 1 |
| 4 | Business identity: legal entity, registration, address | Not established |
| 5 | Bank account attached | Not established — and never entered by TowConnect |
| 6 | Production webhook endpoint registered, with its own signing secret | Not created. The signature check exists and is unit-tested |
| 7 | Live secrets stored as environment variables, never in the repository | Enforced today by `verify:phase10`'s secret scan |
| 8 | Refund process documented and authorized by capability | **Done** — `04-finance/refunds-and-payouts.md`, `finance` capability |
| 9 | Dispute process | **Not written.** Nobody has decided who answers a chargeback |
| 10 | Accounting reconciliation between Stripe and the ledger | **Done in the sandbox** — `ops_reconciliation_exceptions()`, `verify:finance` |
| 11 | A commission rate exists | **No.** `pricing_configured()` returns false |

Item 11 is the one that makes the rest academic: with no configured rate, no
job can be priced in production at all.

## The order these have to happen in

1. Finish the Connect identity check (item 1). It is a human step on Stripe's
   own hosted flow and nobody at TowConnect can do it on the founder's behalf.
2. **Execute one sandbox transfer.** Until money has actually moved in test
   mode, "the partner gets paid" is an untested claim — the ledger says
   *internal payout prepared*, which is not the same sentence as *Stripe
   transfer executed*, and the finance screen distinguishes them for exactly
   this reason.
3. Decide the commission (item 11). This is a business decision. Engineering
   has never chosen one and must not.
4. Establish the legal entity and the bank account (items 4 and 5).
5. Write the dispute process (item 9).
6. Register the production webhook and rotate to live secrets (items 6 and 7).
7. Only then, live mode — with the first live job watched by a human from
   request to payout.

## What must never happen

- A live key in `.env.local`, in the repository, or in a report.
- A live transaction to "test the integration". That is what the sandbox is.
- Bank details, identity documents or any KYC field entered into TowConnect.
  All of it goes to Stripe's hosted onboarding, and none of it is ever stored
  here.
