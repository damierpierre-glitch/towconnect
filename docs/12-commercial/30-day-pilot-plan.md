# 30-day plan — first partners, first requests, first jobs

- **Owner:** Founder / Commercial
- **Status:** Active
- **Last reviewed:** 2026-09-02
- **Review cycle:** Weekly during the pilot
- **Related systems:** `partner_links`, `pilot_partner_readiness()`, `funnel_summary()`

**Supply first.** Nothing here spends money on demand until there is somebody
to send it to. A customer who asks for help and is told nobody is available
does not come back, and tells other people — which is a far more expensive
outcome than a slow start.

**The numbers below are validation targets, not forecasts.** They exist to tell
us whether the thing works, not what it will earn. None of them is a revenue
projection and none should ever be presented as one.

---

## Who to approach, in this order

Ordered by how likely they are to say yes and how quickly they can start.

1. **Independent towing companies** — 1 to 5 trucks. They own the supply, they
   feel the empty hours, and the owner is the decision maker. Start here.
2. **Garages and mechanical repair shops** — they call a tow several times a
   week for their own customers, and they know every operator in the area.
   Useful as a source of requests *and* as an introduction to operators.
3. **Body shops** — same again, with a higher share of accident work.
4. **Tyre shops** — winter and spring are their season, and a flat tyre is the
   simplest possible first job.
5. **Dealerships** — slower to decide, larger volume, worth starting the
   conversation early precisely because it will take weeks.
6. **Small fleets** — courier, trades, rental. They break down and they have
   nobody in-house.
7. **Local partners** — parking operators, condo and building managers,
   municipal parking. Later; they usually have contracts.

## Week 1 — supply only

**Goal: 5 towing companies in a real conversation, 1 onboarded.**

- Build a list of towing companies operating on the island and the South Shore.
  Public directories, maps, the ones already known.
- Call 20. Use the phone script. Expect 5 conversations from 20 calls.
- Visit 5 in person. An owner-operator decides at their own counter, not by
  email.
- Take the **first** company all the way to `ready` — not three companies
  halfway. The onboarding will show you where it is confusing, and it is worth
  finding that out once rather than three times.

**Measure:** partners contacted, conversations, onboardings started, and the
first `pilot_partner_readiness()` with an empty `blocking_reasons`.

## Week 2 — supply, and the first request channels

**Goal: 10 companies contacted, 3 onboarded, 5 garages with a QR code.**

- Keep calling. Supply is still the constraint.
- Give each garage, body shop and tyre shop a **partner code** — a QR sticker
  or a short link. It measures where a request came from and nothing else: no
  commission, no discount, no payment attached to it.
- Ask the same question at each counter: *"When a customer needs a tow, what do
  you do right now?"* The answer is the product research.

**Measure:** ready partners, codes issued, `landing_viewed` events carrying a
partner source.

## Week 3 — first requests, closed

**Goal: first real request, first completed job.**

- Open the pilot with the **allowlist on**. Yourself, the partners, a few
  people who know it is a pilot.
- Every request is watched from the operations screen. Every intervention gets
  an incident.
- Ask the customer afterwards. Not a survey — a phone call.

**Measure:** requests created, match rate, time to match, time to arrival,
completion rate. `ops_kpis()` is the source; nothing is counted twice.

## Week 4 — open the territory

**Goal: 20 partners contacted, 5 active, 25 completed jobs.**

- Only if week 3 produced completed jobs with no unresolved incident.
- Allowlist off, territory still Montréal & Rive-Sud.
- Local search pages and a Google Business listing if the details are real. No
  paid advertising: budget is a separate decision and there is nothing yet to
  justify it.

**Measure:** everything above, plus phone-call-required rate — how often a
human had to intervene. That number, not job count, says whether this works.

---

## Validation sequence

Each step is a question, not a milestone. Do not move on until the answer is
yes.

| Step | The question it answers |
| --- | --- |
| 5 partners in conversation | Is there any interest at all? |
| 1 partner ready | Can onboarding actually be completed by somebody who is not us? |
| 5 partners ready | Is onboarding repeatable? |
| First request | Does the funnel produce a real request? |
| First completed job | Does the whole chain work with real people and real money? |
| 10 completed jobs | Does it work when we are not watching? |
| 25 completed jobs | Does the same partner come back? |
| 50 completed jobs | Do customers come back, or tell somebody? |
| 100 completed jobs | Is there a business here? |
| 20 partners active | Is supply repeatable at a scale that supports open demand? |

## Demand, at zero or near-zero cost

In priority order, and none of it before there is supply:

1. **Partner counters** — a garage or tyre shop with a QR code is the cheapest,
   highest-intent channel available. Somebody standing at that counter has the
   problem right now.
2. **Local search pages** — `/remorquage-montreal`, `/remorquage-rive-sud`,
   `/assistance-routiere-montreal`, `/assistance-routiere-rive-sud`. They say
   plainly that this is a pilot, because they will be read by people who then
   try it.
3. **Google Business** — only with a real address and real hours. An
   unmonitored listing is worse than none.
4. **Small fleets** — one conversation can produce recurring requests.
5. **Word of mouth from completed jobs** — the only channel that compounds, and
   the reason job number one matters more than request number one.

**No paid advertising during these 30 days.** Not on principle — because until
the match rate and the completion rate are known, buying traffic buys
disappointment at a price per click.

## What would make this plan stop

Written down in advance, because these are much harder to admit in week 3:

- No towing company will onboard → the product is not the problem; the offer
  is. Stop and change the offer.
- Partners onboard but decline every offer → the price to them is wrong, and
  the commission has not even been set yet.
- Requests arrive and nobody can be matched → close intake. A pilot that
  refuses is recoverable; one that disappoints is not.
