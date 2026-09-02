# Runbook — A payment did not work

- **Owner:** Founder / Product (future: Finance)
- **Status:** Active
- **Last reviewed:** 2026-09-02
- **Review cycle:** After any payment incident
- **Related systems:** `payments`, `request_supplements`, Stripe

## Symptom

`payment_failed`, `payment_unresolved`, `supplement_charge_failed` or
`supplement_awaiting_authentication` in the attention queue.

## First: the operational job is not blocked

Payment status and job status are deliberately decoupled. A driver can complete
a rescue whose payment failed. Do not cancel a job over a payment problem.

## Steps by symptom

| Symptom | Meaning | Action |
| --- | --- | --- |
| `payment_failed` | The card was refused | Support asks the customer for another card; the request can be retried |
| `payment_unresolved` | Stuck before a terminal state for over an hour | Check the PaymentIntent in Stripe; the webhook is authoritative |
| `supplement_awaiting_authentication` | The bank wants the customer to confirm | The customer must act. **Nothing is owed to the provider yet** |
| `supplement_charge_failed` | Stripe refused the extra | Finance decides whether to pursue it |
| `supplement_uncollected` | It could not be charged at all | The provider is credited nothing. The receipt already says "not charged" |

## Reconciliation

`/dashboard/admin/operations` shows live reconciliation exceptions — the same
invariants `verify:finance` checks. If any appears, money and ledger disagree
and that is investigated before anything else.

## Escalation

Refunds and payouts require the **finance** capability. Support cannot perform
them and should not be asked to.
