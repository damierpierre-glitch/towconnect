# Payment Lifecycle

- **Owner:** Founder / Product (future: Head of Finance)
- **Status:** Active — **sandbox only**
- **Last reviewed:** 2026-09-02
- **Review cycle:** Before any move to live
- **Related systems:** `payments`, `pricing_configs`, `provider_ledger_entries`

## Authorize now, capture on completion

1. The customer confirms → a PaymentIntent is created with
   `capture_method: 'manual'`. **A hold, not a charge.**
2. The driver accepts → the economics are **frozen** onto the request.
3. The driver marks the job complete → the payment is captured.
4. The provider's compensation is credited to the ledger.

Stripe is the authority on payment state. The optimistic writes in the app are
for a responsive UI; whatever the webhook says wins. That webhook write is
**monotonic** — a late authorization event cannot un-capture a captured
payment (a real bug, found in Phase 7.1).

## Frozen economics

At acceptance, the request records `partner_amount`, `commission_amount`,
`payment_processing_cost`, `pricing_config_id` and `pricing_config_version`.

`request_provider_compensation()` returns the **frozen** value, never a
recomputation. A rate change tomorrow cannot reprice a job accepted today.

`NULL` means no configuration was active at acceptance. It is rendered as "not
configured" and **never as $0**.

## The identity

```
customer price = provider compensation + TowConnect margin + processing cost
```

Verified to the cent by `verify:finance` and by `ops_reconciliation_exceptions()`.
Measured drift across every scenario: **$0.0000**.

## Supplements

An extra proposed by the driver and approved by the customer.

- Only the customer may approve (database trigger, 0027).
- TowConnect first tries to grow the existing hold. **This account is not
  eligible for incremental authorization**, so in practice it always falls
  through.
- The fallback is a PaymentIntent of the supplement's own, captured
  immediately — the customer has just agreed to that specific amount for work
  in progress.
- Nothing is credited until Stripe says `succeeded`. `requires_action` is its
  own state: money in flight is neither collected nor failed.
- The provider's share is **marginal**: the job with the supplement minus the
  job without it, on the job's **frozen** configuration.

## No commission is configured

`pricing_configured()` returns `false`. Everything above works and computes
nothing, because that decision has not been made.
