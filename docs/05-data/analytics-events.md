# Analytics events

- **Owner:** Founder / Product
- **Status:** Active
- **Last reviewed:** 2026-09-02
- **Review cycle:** Whenever a step is added to the funnel
- **Related systems:** `product_events`, `record_product_event()`, `guard_product_event_props()`, `funnel_summary()`

## The two rules, both enforced by the database

1. **Event names are an enum.** Adding a step is a migration, on purpose. A
   free-text event name produces `clicked`, `error` and `page_view` within a
   month — numbers nobody can act on and everybody quotes.
2. **Properties are whitelisted by a trigger.** Anything off the list is
   refused at insert. Analytics is where personal data accumulates by accident,
   because the field that carries it was added to answer a reasonable question.

## The funnel

| # | Event | Fires when |
| --- | --- | --- |
| 1 | `landing_viewed` | The public landing page mounts |
| 2 | `signup_started` / `login_started` | The auth form is submitted, or an OAuth redirect begins |
| 3 | `auth_completed` | A session exists — password flow in the browser, OAuth in `/auth/callback` |
| 4 | `location_obtained` / `location_denied` | Geolocation resolves or fails, with how long it took |
| 5 | `situation_selected` | The request form is submitted, with the kind of problem |
| 6 | `vehicle_selected` | Same submit — whether a saved vehicle was used |
| 7 | `estimate_shown` | A price is **on screen**, not when the search started |
| 8 | `checkout_started` | Confirm is pressed |
| 9 | `payment_authorized` | The card was authorized |
| 10 | `request_created` | The request row exists |
| 11 | `request_matched` | Status reaches `matched` |
| 12 | `driver_arrived` | Status reaches `arrived` |
| 13 | `request_completed` / `request_cancelled` | The job ends |

Steps 11 to 13 are recorded from the status the customer actually watches
change, and each is recorded **once per job**: a realtime channel can redeliver
an update, and a conversion rate built on duplicates is a conversion rate that
lies upward.

## Permitted properties

`problem_type`, `vehicle_type`, `has_destination`, `step`, `reason`,
`duration_ms`, `source`, `platform`, `viewport`, `locale`, `error_code`,
`coverage`, `regulated_state`.

Any other key is refused with an error naming it. A string longer than 64
characters is refused too — anything long enough to be prose is long enough to
be a name or an address.

## What is never recorded

No address. No telephone number. No email. No name. No chat content. No amount
of money. No card detail, token or Stripe identifier. No free-text note the
customer typed.

## The two identifiers

- **`profile_id`** — set when somebody is signed in. Their own funnel is their
  own data.
- **`anon_id`** — a random string in the browser, so an anonymous landing view
  can be joined to the signup that followed it. Without it every conversion
  rate in the product is unmeasurable. It is **not an identity**: nothing
  resolves it to a person, it is never sent anywhere but our own server, and
  clearing site data ends it.

## Reading the funnel

`funnel_summary(from, to)` returns, per step: events, distinct sessions, and
conversion from the previous step.

- **Conversion is computed on sessions, not events.** A page that mounts twice
  is one session and two events.
- **A NULL conversion means the previous step never happened.** It is not 0%.
  "Nobody got here" and "everybody who got here dropped" are different facts
  and the difference matters most in a small pilot.

## Known limits, stated rather than discovered

- `record_product_event()` is reachable without a session, because a landing
  view happens before anybody signs in. It is bounded by a fixed enum, a
  property whitelist, and a cap of 300 events per browser per hour. It is not
  rate-limited per IP address; before opening the pilot beyond an allowlist,
  that is worth adding.
- Events are recorded from the browser and can therefore be missed — a tab
  closed mid-request, a blocked script. Job milestones (11 to 13) are the
  exception in practice, because the same transitions are also written to
  `request_events` by a database trigger. **When a number matters, take it from
  `ops_kpis()`, not from here.**
