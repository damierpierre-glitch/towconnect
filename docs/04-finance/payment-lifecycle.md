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

---

## Before live mode

Stripe stays in test mode through the pilot, and the application refuses a live
secret key at startup. The eleven-item checklist that would have to be
satisfied first — and the three items on it that are not engineering work — is
`04-finance/stripe-live-readiness.md`. The decision itself is ADR-0011.

Two facts that make the rest academic today: `pricing_configured()` returns
`false`, so no job can be priced in production at all; and no Stripe transfer
has ever executed, so *internal payout prepared* has never yet become *Stripe
transfer executed*.


---

## How the webhook is verified, and by whom

Every delivery is signed by Stripe with the endpoint's own secret and checked
with `stripe.webhooks.constructEvent` against the **raw** body before anything
is parsed. A missing signature is a 400, a forged one is a 400, and a handler
with no secret configured refuses to run at all with a 503. The event id is
inserted into `stripe_webhook_events` *before* any handling, so a retry is a
no-op rather than a second financial effect.

### One endpoint, one secret, and where each side is proven

Stripe never returns an endpoint's signing secret after creation. Local and
deployed environments therefore cannot be reconciled by any script, and trying
to keep them equal by hand produced a failure that read as a security problem
and was an environment one.

So the two halves are proven separately, and `npm run test:finance` does both:

| Question | How it is answered |
| --- | --- |
| Does the handler verify, accept and deduplicate correctly? | The signed replay runs **in-process** against the route handler, where signing and verification share one secret |
| Does the live endpoint refuse unsigned and forged traffic? | Posted at the deployment directly — needs no secret |
| Does the deployment hold the endpoint's own secret? | **Stripe's delivery record**: zero events pending delivery over 24h only happens when the deployment verified and accepted them |
| Is there exactly one endpoint, pointing where we think? | `stripe.webhookEndpoints.list()` |

The local `STRIPE_WEBHOOK_SECRET` deliberately no longer participates in any
assertion. Copying the endpoint secret from the Stripe dashboard into
`.env.local` would additionally allow signed traffic to be aimed at the
deployment; nothing requires it.
