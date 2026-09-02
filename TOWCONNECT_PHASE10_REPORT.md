# TowConnect — Phase 10

## Prelaunch, pilot readiness and local launch

**Date:** 2026-09-02 · **Territory:** Montréal & Rive-Sud · **Stripe:** test mode

---

Phase 10 did not try to make TowConnect perfect. It tried to make the risks
visible, measurable and manageable for a small closed pilot — and the honest
result is that **fourteen blocking items are still open**, four of them
decisions nobody has made and three of them found during this phase by
actually using the product rather than reading the code that implements it.

The single most useful thing this phase produced is not a feature. It is a
checklist that **cannot be ticked without evidence**, because the refusal is a
CHECK constraint rather than a habit.

---

## 1. Launch readiness checklist

`launch_readiness_items` — 59 items across all fourteen domains, each with a
status, an owner, evidence, a blocker flag and a review date.

| Status | Items |
| --- | --- |
| ready | 41 |
| in progress | 4 |
| not started | 11 |
| blocked | 3 |

**41 of 59 ready — a readiness score of 69 %.** 42 items are blockers; 14 of
those are outstanding.

| Domain | Items | Ready | Open blockers |
| --- | --- | --- | --- |
| product | 5 | 4 | 1 |
| customer | 4 | 4 | 0 |
| driver | 3 | 3 | 0 |
| business | 3 | 3 | 0 |
| operations | 6 | 3 | 3 |
| finance | 6 | 3 | 3 |
| regulatory | 3 | 2 | 1 |
| security | 7 | 6 | 0 |
| privacy | 4 | 2 | 1 |
| monitoring | 4 | 2 | 0 |
| support | 3 | 2 | 1 |
| data | 4 | 4 | 0 |
| legal | 3 | 0 | 3 |
| commercial | 4 | 3 | 1 |

Three constraints make the list resistant to optimism. **`ready` requires
evidence.** **`blocked` requires a reason.** **`not_applicable` requires a
reason.** Ticking a box on a busy day is exactly what a launch checklist exists
to resist, so the resistance is in the database — `verify:phase10` proves it by
trying to insert a green row with no evidence and asserting the failure.

No owner is invented. Every row says `Founder / <function>`; where a specialist
will eventually own something, it says so.

---

## 2. Pilot territory

Montréal & Rive-Sud, said in one place and quoted everywhere:
`PILOT_STATEMENT` in `src/lib/content/publicPages.ts`. Every public page uses
it, and `verify:phase10` fails if a page writes its own coverage sentence.

**Three questions kept apart, because conflating them is how a marketplace
lies without meaning to:**

| Question | Answered by |
| --- | --- |
| Where do we *intend* to operate? | `pilot_coverage_areas` — a commercial declaration |
| Can somebody *actually* be rescued there? | `pilot_coverage_report()` — a count of partners that reach it |
| Is towing *allowed* there? | `regulated_towing_zones` — law |

Today those answers are: one declared area, **zero partners reaching it**, and
fifteen active regulated zones untouched by any of this. The coverage report
puts the first two side by side precisely so the disagreement is visible before
a customer discovers it.

**Coverage never overrides regulation.** Being inside a declared area grants
nothing; a restricted zone still refuses. `verify:phase10` asserts the order,
and the claim is written into the migration where somebody changing the table
will read it.

**The declared area is deliberately imperfect, and says so.** A 30 km circle is
not "Montréal and the South Shore": it reaches Laval and clips the east end of
the island. The row's own `note` says that in the words an operator reads, and
`operations.coverage_polygon` is a **launch blocker** until real municipal
boundaries replace it. Acceptable while the allowlist is on; not acceptable
once anybody can request.

---

## 3. Customer end-to-end, on a phone

Walked at 375 × 812 against the running application, not read.

| Step | Result |
| --- | --- |
| Landing | Renders; funnel event recorded with `platform` and nothing else |
| Login | Labels now associated with fields |
| **Wrong password** | **Was "Something went wrong". Now "Courriel ou mot de passe incorrect", in a `role="alert"`** |
| Location | **Denied in this browser — the flow fell back to a typed address, exactly as intended** |
| Situation, vehicle | Eight large touch targets, now with `aria-pressed` |
| Address | Geocoding suggestions work |
| Estimate | Honest: *"Aucun remorqueur disponible"* — no invented driver, no invented ETA |
| **Pilot refused (outside territory)** | **Sentence shown, confirm button gone, before any card was authorized** |
| **Pilot refused (paused)** | **Operator's own reason shown to the customer** |
| Refresh / reopened tab | Active job resumes from the server |

### Where a stressed user hesitates — and one fix that came out of it

**Pressing Back erased the whole form.** `StepForm` unmounts when the estimate
appears, so somebody who tapped Back to correct one character of an address
had to re-choose the problem, re-type the location and re-pick the destination
— at the roadside, one-handed. Fixed: the form is seeded from what was already
filled in, and mount-time GPS detection is skipped so it cannot overwrite a
correction the rider came back to make. Verified in the browser afterwards.

The other hesitation points, recorded rather than changed: the estimate screen
shows a price with no explanation of what happens if the job turns out to need
more; and "no driver available" offers a retry but no alternative.

---

## 4. Driver end-to-end

Compliance gating, offer handling, status progression and earnings are
exercised by `test:operations` (40 assertions) and `verify:phase6` (37 checks)
as real signed-in drivers. Failure states — stale heartbeat, expired offer,
another driver accepting first — are covered there, and `verify:scheduler`
proves the timeout sweep runs unattended.

Accessibility work reached the driver path too: the chat input had no
accessible name at all, and a failed send was a bare paragraph a screen reader
never announced.

---

## 5. Partner onboarding

Nine steps, documented in `docs/11-partners/partner-onboarding.md` and walked
against the real screens.

**Three words that all sound like "ready"**, now separated in the schema, the
docs and the data dictionary:

| Field | Question | Read by dispatch? |
| --- | --- | --- |
| `companies.status` | Approved to operate at all — compliance | Yes |
| `companies.pilot_status` | Where they sit in our rollout — commercial | **No** |
| `driver_profiles.is_online` | Is a truck available right now | Yes |

`pilot_status` is write-guarded to `operations`: a company cannot promote
itself into the pilot, the same reasoning that stops a driver approving their
own documents. `test:pilot` proves the refusal.

`pilot_partner_readiness()` returns the blocking reasons **read out of the same
functions dispatch uses** — so a company shown as ready here and refused by
dispatch would be one bug in one place rather than two opinions.

---

## 6. Analytics

`product_events`, twelve funnel steps, `funnel_summary()`.

Two rules, both enforced by the database rather than by review:

1. **Event names are an enum.** Adding a step is a migration. Free text
   produces `clicked` and `error` within a month.
2. **Properties are whitelisted by a trigger** — thirteen keys, values capped
   at 64 characters. An address, a phone number or a chat message is refused at
   insert, naming the offending key.

Conversion is computed on **distinct sessions**, not events, and a NULL
conversion means the previous step never happened — not 0 %.

Attribution: `partner_links` plus `requests.attribution_code`, set once and
immutable afterwards. It measures where work came from and carries no money.

**Known limit, stated rather than discovered:** the endpoint is reachable
without a session because a landing view precedes sign-in. Bounded by the enum,
the whitelist and 300 events per browser per hour; not limited per IP address.
Recorded as `security.analytics_rate_limit`.

---

## 7. Monitoring

`ops_system_health()` — seven components, **three** states.

`unknown` is the important one: a health board that renders green because it
failed to read a signal converts an outage into a reassurance. All seven read
`ok` at the time of writing, each with the measurement behind it (last cron run
18:33 UTC, 204 Stripe events processed, 8 tables published to realtime).

`ops_alerts()` — six conditions, each carrying the action it requires. The test
for inclusion is deliberately hard: if the honest response to an alert is "yes,
I know", it is a number and belongs on the KPI screen. **Zero alerts open.**

Two alerts do not come from health: a pilot left paused (a pause nobody lifts
is an outage nobody reported) and a `ready` partner whose Connect account
cannot pay out (a commitment we cannot honour).

**There is no alert delivery.** Alerts appear on one screen and nowhere else.
Acceptable only while somebody is watching it; recorded as
`monitoring.delivery`.

---

## 8. Error handling

`src/lib/errors.ts` classifies a failure into one of thirteen codes and returns
an i18n key — typed as `DictKey`, so a code with no written sentence fails to
compile rather than at the roadside. Nineteen call sites that rendered
`e.message` verbatim now render a sentence.

That was worse than it looked. In production Next.js **redacts** a server-action
error before it reaches the browser, so `e.message` was not the useful detail
anyway — it was "An error occurred in the Server Components render". The old
code was showing a placeholder and calling it an error message.

Expected refusals are now **returned as data, not thrown**: a thrown error is
right for a bug and wrong for "we do not serve that address".

---

## 9. Security review

Full record: `docs/08-security/prelaunch-security-review.md`.

### Finding 1 — driver identity documents were readable by finance *(fixed, 0048)*

0043 scoped the money and regulatory policies to capabilities; 0044 removed the
grandfather rule. **Driver documents were missed by both.** An administrator
granted only `finance` could read every driver's licence, insurance certificate
and vehicle registration — the row *and* the image, because the signed URL is
created from the caller's own session and the storage policy was also
`is_admin()`.

Not exploited: one person holds `super_admin` and nobody else holds a grant, so
no session existed that the gap would have widened. Fixed now because the pilot
is when a second administrator first becomes plausible. Both policies are
scoped to `operations`, and **`test:integration` now asserts that a
finance-only admin is refused**, so it cannot come back quietly.

### Also reviewed

Auth and sessions, RLS (213 assertions), SECURITY DEFINER null-safe guards,
service-role isolation, exports, the Safety Link projection, webhook signature
verification and idempotency, Stripe mode, capabilities, signed URLs (120 s,
never service-role), and logs.

### Secret scan

`verify:phase10` scans the working tree and the last 50 commits for six secret
patterns. **A match is reported by file name; the value is never printed.**
Clean. `.env` files are excluded because holding a secret is what they are for
— the check is that nothing else does.

---

## 10. Performance

Measured from the production build (`npm run measure:bundles`), gzipped.

| | |
| --- | --- |
| Loaded by every route | **166.7 kB** |
| All client chunks | 936 kB across 57 files |
| Largest single chunk | **489 kB — mapbox-gl** |

**The finding, and the fix.** `MapView` was imported statically by
`StepEstimate`, which put mapbox-gl in the first-load bundle of `/request`.
Somebody stranded at the roadside downloaded half a megabyte of mapping engine
while filling in "flat battery", on whatever signal they had, before any map
existed on screen.

`LazyMapView` splits it out. Verified in the browser: **no mapbox resource is
requested on the situation form**, six are requested when the estimate renders,
and the map still draws.

Images: the 228 kB brand PNG is a source asset served through `next/image`,
which resizes and re-encodes it. Left alone.

---

## 11. Accessibility

Critical customer and driver paths. Every item below was a real defect found by
reading the rendered page, not a checklist.

| Fix | Why it mattered |
| --- | --- |
| `Label` now passes `htmlFor` | **No label in the product was associated with its field.** Tapping the word did not focus the box, and screen readers announced every input as unlabelled |
| `aria-pressed` on the problem-type and role grids | Selection was conveyed by colour alone |
| `aria-label` on the location button | It was an emoji, announced as "round pushpin" or as nothing |
| Chat input labelled | A placeholder is not a name, and it disappears when you type |
| Toast is a live region | A toast is often the only feedback for an action; a screen reader heard nothing |
| Auth and chat errors are `role="alert"` | A failed sign-in was announced to nobody |
| Skip link | The whole navigation had to be tabbed through to reach the request form |
| `autocomplete` on auth fields | A password manager can fill the form one-handed |

### Contrast, measured

White on the brand orange `#ff5c1a` is **3.09:1** — below WCAG AA's 4.5:1 for
this text size. It applied to every filled button, including the one somebody
presses at night, at the roadside, on a screen turned down.

Filled controls now use `#cc4400` (**4.78:1**) and darken to `#b33c00`
(**5.90:1**) on hover — so contrast improves under the cursor instead of
degrading. The brand orange is unchanged everywhere it carries no white text:
badges, borders and accents on the dark ground measure 6.2:1 as they are.

---

## 12. Local SEO and public pages

Eleven pages, bilingual, all content in one reviewable file.

Trust: `/a-propos`, `/comment-ca-marche`, `/contact`, `/securite`.
Local: `/remorquage-montreal`, `/remorquage-rive-sud`,
`/assistance-routiere-montreal`, `/assistance-routiere-rive-sud`.
Legal: `/confidentialite`, `/conditions`, `/conditions-partenaires`.

Plus `sitemap.ts` and `robots.ts`. The disallow list is not about secrecy —
every path is already protected — it is about not putting a tracking link, a
receipt or an operations console into a search index.

**Structured data carries only what is true**: Organization and Service with
`areaServed`. No `aggregateRating`, no review, no `openingHours`, no
`priceRange`. Each of those is a claim a search engine renders as fact, and
TowConnect can support none of them.

**`verify:phase10` reads the public copy and fails on a promise the system
cannot keep**: 24/7 availability, a guarantee, a count of operators, a rating,
national coverage, a response time. The first version of that check failed on
*"nous ne promettons ni couverture 24/7 ni délai garanti"* — the product being
honest, flagged as the product lying. It now works sentence by sentence and
skips negations, so nobody is ever taught to delete a disclaimer to make a test
pass.

The Contact page says plainly that **no support channel exists yet**. Publishing
a number nobody watches is worse than publishing none.

---

## 13. Legal readiness

Three documents published, **all three marked `DRAFT — LEGAL REVIEW REQUIRED`**
in a banner rendered inside a `role="note"` so a screen reader announces it too.

The published text lives in one place; `docs/13-legal/` holds the **review
record** for each — what it claims, how each claim was verified against the
code, and what a reviewer must still decide. Two copies of a legal document is
how a customer reads one version while a lawyer reviews another.

**All three are launch blockers.** So is `legal.insurance`: who is liable for
damage during a tow has not been established with an insurer or a lawyer. The
partner terms describe the intended arrangement and say, in the document, that
it is intended rather than verified.

---

## 14. Stripe live readiness

**Not live, and not going live for the pilot.** ADR-0011; the eleven-item
checklist is `docs/04-finance/stripe-live-readiness.md`.

| | |
| --- | --- |
| Platform Connect identity | **One requirement outstanding** — `individual.verification.proof_of_liveness` |
| `charges_enabled` | **true** |
| `payouts_enabled` | **false** |
| Sandbox transfer executed | **Never** |
| Commission configured | **No** — `pricing_configured()` returns `false` |
| Dispute process | Not written |

The last three make the rest academic. With no configured rate, no job can be
priced in production at all.

---

## 15. Connect debt

Re-read from Stripe this phase. `charges_enabled` is **true**;
`payouts_enabled` is **false**; the account remains `pending` with the identity
check outstanding. Our database is in sync with Stripe.

**The remaining action is human and cannot be delegated:** complete the
proof-of-liveness step in Stripe's hosted flow. Nothing here attempts to work
around it, and no identity document is ever entered into TowConnect.

Until a sandbox transfer completes, *internal payout prepared* has never become
*Stripe transfer executed*, and the finance screen keeps saying so.

---

## 16. Support operations

`docs/06-support/pilot-support-runbook.md`: eight situations, with an
escalation table saying for each one who looks, what they may read, what they
may do, and when it stops being theirs.

Two standing rules. **Capabilities are not advisory** — support cannot refund,
pay out or change a zone, and the database refuses, so "just this once" is not
available. **Every intervention gets an incident**, because
`requests_needing_human` is built from incidents and an unrecorded intervention
makes the platform look more autonomous than it is.

---

## 17. Launch runbook

`docs/09-sops/pilot-launch-runbook.md`: prelaunch, T-24h, launch, the first
real request, incidents, pause/rollback, reopening, end of day.

The pilot is a **database switch, not a deploy** (ADR-0010). Three modes,
enforced by a `BEFORE INSERT` trigger on `requests` so a forgotten code path
cannot walk around it. `off` is the default, because a migration that silently
starts refusing requests takes a platform down at three in the morning.

**Pausing affects intake only.** Jobs already running are untouched — the
driver keeps driving, the chat keeps working, the payment still captures.
`test:pilot` asserts it.

A pause requires a written reason, enforced by a CHECK constraint, and that
reason is what the customer reads.

---

## 18. Data and the review pack

`docs/05-data/pilot-review-pack.md` builds the weekly review out of the Phase 9
exports — interventions, dispatch, finance, incidents, KPIs — each scoped to
the capability that could already read it. No new report and no second
definition of a KPI. An empty pilot week produces an empty pack, and that is
the correct output.

---

## 19. 30-day commercial attack plan

`docs/12-commercial/30-day-pilot-plan.md` and `sales-scripts.md`.

**Supply first** (ADR-0009). A customer arrives at their worst moment of the
month; a failure to match is not a lost conversion, it is somebody beside a
highway who tells people. Weeks 1–2 are towing companies only. Demand channels
are free and high-intent: partner counters with a QR code, local pages, word of
mouth. **No paid advertising in the 30 days** — until the match rate is known,
buying traffic buys disappointment at a price per click.

The targets are validation questions, not forecasts: 5 partners in
conversation → 1 ready → 5 ready → first request → first completed job → 10 →
25 → 50 → 100 → 20 active partners. None is a revenue projection.

Scripts for the phone, the visit, the email, the follow-up and eight
objections. Three rules hold throughout: never invent volume, **never quote a
commission** (it does not exist), never promise an arrival window.

The plan also records, in advance, what would make it stop — those are much
harder to admit in week three.

---

## 20. Go / no-go

`pilot_go_no_go()` — 46 criteria, computed and recorded together.

| | |
| --- | --- |
| pass | 30 |
| **fail** | **4** |
| undecided | 12 |

**Undecided is never a pass.** An unmade decision must not be able to look like
a made one.

### The four failures

1. **A first customer cannot confirm their email.** Signing up through the real
   form returns *email rate limit exceeded* (HTTP 429). Supabase's built-in
   SMTP is throttled to a handful of messages per hour and no custom provider
   is configured. **Found by trying it, not by reading it.**
2. **A partner cannot actually be paid.** Internal payout prepared; no Stripe
   transfer has ever executed.
3. **The webhook signing secret has drifted** between `.env.local` and the
   deployment. Real Stripe events are still being processed — 70 in the last
   six hours — so production is fine; but the two assertions proving a replayed
   event is deduplicated *in production* can no longer run.
4. **Fourteen blocking readiness items outstanding.**

### The twelve undecided

Every one is a decision, not a bug: the commission, pilot hours, the minimum
partner count, the operating authority question, the three legal reviews,
insurance, the support channel, the coverage polygon, and the first real
partner.

---

## 21. Tests

| Suite | Result |
| --- | --- |
| `npx tsc --noEmit` | clean |
| `npm run lint` | clean |
| `npm run build` | 53 routes |
| `npm run test` | **69** unit |
| `npm run test:integration` | **213** RLS assertions (+4) |
| `npm run verify:phase6` | 37 |
| `npm run verify:phase6_1` | 32 |
| `npm run verify:phase7` | 24 |
| `npm run verify:finance` | 16 |
| `npm run verify:operations` | 27 |
| `npm run verify:phase9` | 24 |
| **`npm run verify:phase10`** | **49** |
| `npm run test:operations` | 40 |
| `npm run test:safety` | 39 |
| `npm run test:exports` | 42 |
| **`npm run test:pilot`** | **58** |
| `npm run test:finance` | **123 passed, 2 failed, 1 requires a human** |

The two finance failures are the webhook secret drift described above — an
environment problem, not a defect in the webhook. The failure message now says
so, because "Invalid signature" otherwise reads as a security failure.

### Manual pilot tests

Executed against the running application: customer path at 375 px; wrong
password; GPS refused; back-navigation; refresh mid-request; pilot refusal
outside the territory; pilot refusal while paused; pause and resume from the
operations console; health board; go/no-go board; funnel with real events;
public and legal pages.

Documented rather than executed, because they are covered headlessly by suites
that run as real users: the full driver mobile path, refunds, supplements,
export downloads per role, dispatch with no candidate, and a stale driver.

---

## 22. Cleanup, verified in the database

| | |
| --- | --- |
| Phase 10 fixture accounts | 0 |
| Phase 10 requests | 0 |
| Partner codes | 0 |
| Allowlist entries | 0 |
| Product events | **0** — including the ones this walkthrough produced |
| Safety links, notifications, export audit rows | 0 |
| Pilot mode | `off` |
| `pricing_configured()` | **false** |
| Companies | 1 (the deliberately kept Phase 8.1 Connect fixture) |
| Open alerts | 0 |
| System health | 7/7 `ok` |

The analytics events from this phase's own browser walkthrough were deleted on
purpose: leaving them would make the first pilot funnel report claim visitors
that were a test.

---

## 23. Blockers

**Critical — the pilot cannot open to a real customer:**

1. `product.signup_email` — no custom SMTP; a first customer cannot confirm
   their address.
2. `finance.commission` — no rate configured; no job can be priced.
3. `commercial.first_partners` — no real towing company is onboarded.
4. `support.channel` — no reachable human.
5. `regulatory.operating_authority` — whether an intermediary needs a permit
   in Québec is unverified. **The largest unknown in the pilot.**

**Blocking, but resolvable by a decision or an afternoon:**

6. `finance.payout_execution` — no Stripe transfer has ever executed.
7. `finance.webhook_secret_parity` — local secret drift.
8. `legal.terms`, `legal.partner_terms`, `privacy.policy_published` — three
   drafts awaiting a qualified reader.
9. `legal.insurance` — liability not established.
10. `operations.hours`, `operations.min_partners` — two numbers nobody has
    chosen, deliberately not chosen by engineering.
11. `operations.coverage_polygon` — a circle standing in for a boundary.

**Not blocking, carried into the pilot:** alert delivery, error tracking,
analytics rate limiting, data retention.

---

# PHASE 10 COMPLETE

**Readiness score:** 41 of 59 items ready — **69 %**. Go/no-go: 30 pass, 4 fail,
12 undecided.

**Critical blockers:** 5 — email confirmation, commission, first partner,
support channel, operating authority.

**Pilot blockers:** 14 outstanding of 42 blocking items.

**Tests:** tsc, lint and build clean; 69 unit; 213 RLS; 49 + 24 + 27 + 16 + 24 +
32 + 37 verification checks; 58 pilot, 42 exports, 40 operational, 39 safety
assertions; 123 of 125 financial (2 blocked by webhook secret drift, 1 awaiting
a human).

**Stripe live status:** test mode, and the application refuses a live key. Not
going live for the pilot (ADR-0011).

**Connect status:** `charges_enabled` **true**, `payouts_enabled` **false**, one
identity requirement outstanding (`proof_of_liveness`). No transfer has ever
executed.

**Regulatory status:** the zone engine is enforced and verified (32 checks); 15
zones active, each with an official source and a geometry. **Whether TowConnect
may operate as an intermediary in Québec is unverified.**

**Commercial readiness:** the plan, the scripts, the partner kit and the
attribution mechanism exist. **Zero partners.** Supply is the constraint, and
nothing in the plan spends a dollar on demand before it is solved.

**Path to report:** `TOWCONNECT_PHASE10_REPORT.md`

---

## Verdict

# NOT READY FOR PILOT

Not because the software is unfinished — the platform gates, refuses, measures,
reconciles and explains itself, and 41 of 59 readiness items are green with
evidence behind each one.

**It is not ready because five things a pilot cannot run without do not exist
yet:** a customer cannot confirm their email address, no price can be
calculated, there is no towing company to send, there is no human to call, and
nobody has established whether TowConnect is permitted to do this in Québec.

Four of those five are decisions and conversations, not engineering. The
fifth — email delivery — is an afternoon.

**The pilot must not be started without human validation**, and on today's
evidence it should not be started at all until at least the five critical
blockers are closed.
