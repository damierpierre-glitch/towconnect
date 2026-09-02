# Refunds and Payouts

- **Owner:** Founder / Product (future: Head of Finance)
- **Status:** Active — **sandbox only**
- **Last reviewed:** 2026-09-02
- **Review cycle:** Before any move to live
- **Related systems:** `refunds`, `provider_payouts`, `provider_ledger_entries`

## Refunds

- Only an admin holding the **finance** capability may issue one.
- A reason is **required**. An unexplained movement of somebody else's money is
  not acceptable.
- The provider's share is clawed back **proportionally**, as a new negative
  ledger entry. The original credit is never edited.
- A supplement collected on its own PaymentIntent is refunded against **that**
  intent, not against the fare the customer already accepted.
- A partial refund does not mark the payment `refunded`; only a full one does.

## The provider ledger

Append-only, enforced by a trigger — `UPDATE` is refused outright, including
for the service role. A correction is a new entry.

Balances are **derived** (`provider_balances()`), never stored: there is no
stored total that could contradict the movements that produced it.

`available_at` is decided at insertion and never revised. A capture that only
succeeds later is handled by writing a **pair** of entries, not by editing one.

## Payouts — the distinction that matters

| | |
| --- | --- |
| `internal payout prepared` | Implemented. A `pending` row plus a negative ledger entry. |
| `Stripe transfer executed` | **Not implemented.** No `transfers.create` call exists. |

Nothing is paid out automatically after a job. `stripe_transfer_id` is `NULL`
unless a real transfer happened — the exports carry an explicit
"Exécuté par Stripe" column so a spreadsheet cannot blur the two.

## Connect

Companies onboard through Stripe's **hosted** Express flow. TowConnect never
receives a bank account number, a card or a KYC document. What is stored are
Stripe's own answers (`charges_enabled`, `payouts_enabled`, outstanding
requirements), and a company cannot write those itself — a trigger refuses.
