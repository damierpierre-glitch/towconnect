# Data Dictionary

- **Owner:** Founder / Product (future: Data)
- **Status:** Active
- **Last reviewed:** 2026-09-02
- **Review cycle:** Whenever a concept is added or renamed
- **Related systems:** all

Each term is defined once, here, with where it lives.

| Term | Definition | Where |
| --- | --- | --- |
| **Request** | One motorist asking for help at one place and time. Carries the frozen price and, after acceptance, the frozen economics. | `requests` |
| **Request event** | An append-only record of a status change, written by a trigger on `requests` — so it captures every path to a status. | `request_events` |
| **Dispatch offer** | One job offered to one driver for 18 seconds. Sequential, never a broadcast. | `dispatch_offers` |
| **Match** | A request that reached status `matched`, i.e. a driver accepted. Evidence is the `matched` row in `request_events`, which survives later cancellation. | `request_events` |
| **Provider compensation** | What the tow operator is owed, frozen at acceptance. `NULL` means no configuration was active — never zero. | `requests.partner_amount` |
| **TowConnect margin** | What remains after provider compensation and processing cost. | `requests.commission_amount` |
| **Processing cost** | What the payment processor takes. `NULL` when not configured. | `requests.payment_processing_cost` |
| **Payment** | One Stripe PaymentIntent for a job's fare. Authorized at confirmation, captured at completion. | `payments` |
| **Supplement** | An extra proposed by the driver and approved by the customer. Approved ≠ charged: `payment_state` says which. | `request_supplements` |
| **Refund** | Money returned to a customer. Requires a stated reason. May target the fare or one supplement. | `refunds` |
| **Ledger entry** | One signed movement on a provider's account. Append-only; a correction is a new entry. | `provider_ledger_entries` |
| **Payout** | Money prepared for, or sent to, a company. `stripe_transfer_id` distinguishes prepared from executed. | `provider_payouts` |
| **Regulated zone** | A stretch of road where only authorized providers may tow, with its official source and boundary confidence. | `regulated_towing_zones` |
| **Operational incident** | Something that needed a human, and what came of it. Status history written by a trigger. | `operational_incidents` |
| **Risk flag** | A counted observation about a person, never a verdict and never automatic. Immutable once written. | `risk_flags` |
| **Admin capability** | `super_admin`, `operations`, `finance`, `support`. An admin holds only what is granted. | `admin_grants` |
| **Safety Link** | A revocable, expiring, non-guessable token letting somebody without an account watch one rescue. Only the SHA-256 is stored. | `safety_links` |
| **Notification** | An event delivered to exactly one person, stored as a type plus a payload — never a finished sentence. | `notifications` |
| **Readiness item** | One line of the launch checklist. Cannot be marked ready without evidence — a CHECK constraint, not a habit. | `launch_readiness_items` |
| **Pilot mode** | `off`, `pilot` or `paused`. Decides what happens to a NEW request; never touches a job already running. | `pilot_config` |
| **Coverage area** | Where the pilot *intends* to operate. A commercial declaration, never evidence that anybody is available, and unable to override a regulated zone. | `pilot_coverage_areas` |
| **Partner pilot status** | Where a company sits in TowConnect's rollout: `invited`, `onboarding`, `ready`, `active`, `paused`. Commercial only — dispatch never reads it. | `companies.pilot_status` |
| **Partner link** | A code on a QR sticker or a link, recording where a request came from. Carries no money and changes no price. | `partner_links` |
| **Product event** | One step of the acquisition funnel. Name is an enum; properties are whitelisted by a trigger. | `product_events` |
| **Session (analytics)** | A distinct `anon_id`, or a signed-in `profile_id`. What conversion is computed on — never raw event counts. | `product_events` |

## Values that mean "nobody decided"

`partner_amount`, `commission_amount`, `payment_processing_cost`,
`cancellation_fee_charged`, any KPI rate, a driver's rating with zero completed
jobs, `pilot_config.min_ready_partners`, `pilot_config.hours_start` /
`hours_end`, and a funnel conversion whose previous step never happened. In
every case `NULL` is rendered as an absence, not a zero.

## Three words that all sound like "ready"

The most likely confusion in the whole model, so it is written down rather
than inferred:

| Field | Question | Read by dispatch? |
| --- | --- | --- |
| `companies.status` | Approved to operate at all — compliance | Yes |
| `companies.pilot_status` | Where they sit in our rollout — commercial | **No** |
| `driver_profiles.is_online` | Is a truck available right now | Yes |
