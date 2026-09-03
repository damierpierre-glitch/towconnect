# TowConnect — Launch Blocker Sprint 1

## Technical closeout: email confirmation and the webhook secret

**Date:** 2026-09-03 · **Scope:** two technical blockers only · **Stripe:** test mode

---

Two blockers went in. **One is closed with proof. One cannot be closed by
anybody without an account at a mail provider** — and this sprint replaced the
guess about why with Supabase refusing it three times, in writing.

The audit also found a third thing nobody had noticed: **TowConnect has no
password-reset flow at all.**

---

## 1. Email — the state before

Read from the project's own auth configuration, not from documentation.

| Setting | Value | What it means |
| --- | --- | --- |
| `disable_signup` | `false` | Signups are open |
| `mailer_autoconfirm` | `false` | **Confirmation is required** — an account is unusable until the address is confirmed |
| `smtp_host` / `smtp_user` / `smtp_pass` | not set | **No provider.** Mail goes through Supabase's shared testing mailer |
| `rate_limit_email_sent` | **2** | Two messages per hour, for the entire project |
| `smtp_max_frequency` | `60` | One message per address per minute |
| `hook_send_email_enabled` | `false` | No custom send hook either |
| `site_url` | `https://towconnect-chi.vercel.app` | |
| `uri_allow_list` | `https://towconnect-chi.vercel.app/**` | Production origin only — `localhost` absent |
| Templates | Supabase defaults | English, unbranded, sent to a French-first market |

## 2. Email — what was tried, and what Supabase said

Three separate attempts to fix this from configuration alone. All three were
refused, and the refusals are the finding:

**Branding the templates** →
> `400 Email template modification is not available for free tier projects using the default email provider. Please upgrade your plan or configure a custom SMTP provider.`

**Raising the rate limit** →
> `401 Custom SMTP required to configure SMTP_SENDER_NAME or RATE_LIMIT_EMAIL_SENT. Missing SMTP_ADMIN_EMAIL, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS fields.`

**Signing up as a real customer** → `email rate limit exceeded`, reproduced
repeatedly, and still refused fifty minutes after the previous message.

Nothing about this blocker is reachable without a custom SMTP provider.
Creating an account with one is not something this session may do, and the
mission forbids subscribing to anything without a decision. The probe that
raised the rate limit **restored it to 2 immediately**; nothing was left
changed.

## 3. Email — the state after

| | |
| --- | --- |
| Provider | Still none. **This is the blocker.** |
| Templates | Written, reviewed and **versioned** at `app/supabase/auth-templates/templates.ts` — French first with English in the same message, no image, no external stylesheet, `#cc4400` buttons because white on the brand orange measures 3.09:1. Ready to apply the moment SMTP exists; Supabase refuses to accept them before that. |
| Regression test | **`npm run test:auth`** — 25 assertions covering the whole lifecycle. It fails on exactly one: *a new customer can sign up*. It turns green the day this is fixed, and not before. |
| Redirects | Verified, deliberately unchanged (below). |
| Documentation | `docs/03-operations/account-lifecycle.md` |

### The remaining human action, in full

1. Create an account with a transactional email provider. Resend, Brevo and
   Postmark all have free tiers adequate for a pilot; none requires a card.
2. Verify a sending domain.
3. Supabase → Authentication → Emails → SMTP Settings: host, port, user,
   password, sender address and name.
4. Raise `rate_limit_email_sent`. It is locked at 2 until step 3 is done.
5. Apply `app/supabase/auth-templates/templates.ts`. Also locked until step 3.
6. `npm run test:auth` should then pass 25/25.

## 4. Email — the confirmation flow, proven end to end

Everything *after* delivery already works, and is now asserted against the
live project rather than assumed. The link the suite follows is the very URL
the confirmation email carries — `generateLink` produces it and sends nothing.

| Step | Result |
| --- | --- |
| Signup through the public API | Accepted (when quota allows); **no session issued** |
| `confirmation_sent_at` | Set — Supabase accepted the message for delivery |
| Signing in before confirming | Refused, and the message says *"Email not confirmed"* rather than blaming the password |
| The confirmation link | Points at the project auth host, carries a token, typed `signup`, returns to the allow-listed origin |
| Following it | 303 back to TowConnect, no error, **address confirmed** |
| Following it twice | Refused — single use |
| Signing in afterwards | Works |
| From a client that never saw the first | Works — "coming back tomorrow" |
| The `profiles` row the trigger created | Readable by its owner, with the role chosen at signup |
| Recovery link | Produced, correctly scoped, returns only to an allow-listed origin |

**24 of 25 assertions pass. The one failure is the blocker.**

## 5. Redirects — verified, and deliberately left alone

`localhost` is **not** in the redirect allow list, so a confirmation link
opened during local development returns to production.

That was tempting to "fix" and it should not be. Every entry in that list is a
place an authentication code can be delivered to, and `http://localhost:3000`
on a victim's machine is a place an attacker can listen. This is a production
project with a real database; confirmation flows are tested against the
deployment, which is where they run anyway.

The allow list is verified rather than trusted: `test:auth` asks for a link
pointing at `attacker.example.net` and asserts it does not come back.

---

## 6. Webhook — root cause

Phase 10 reported `123/125` with two failures reading *"Invalid signature"*.

**That was never a security problem, and it was never fixable.**

- Exactly **one** Stripe endpoint exists: `we_1UAc4k2Qby3mUWv8eqsrTL3W` →
  `https://towconnect-chi.vercel.app/api/stripe/webhook`, enabled, six events.
- **Zero events pending delivery** over the last 24 hours out of 100. Stripe
  signs with the endpoint's own secret, so that is Stripe's own evidence that
  the deployment holds the right one.
- The finance suite signed its own payload with the **local**
  `STRIPE_WEBHOOK_SECRET` and posted it at that deployment, which verified it
  against a different value and correctly rejected it.

**Stripe never returns an endpoint's signing secret after creation.** Local and
deployment therefore cannot be reconciled by any script, in either direction.
The only mechanism that would have kept them equal was somebody remembering,
and the failure mode when they forgot was a message that reads like a breach.

## 7. Webhook — source of truth, and the correction

**The source of truth is the endpoint's own secret, held by the deployment.**
It was correct throughout and was not touched.

**No rotation was performed.** Rotating would have required a human to update
Vercel afterwards, and production webhooks would have failed in the gap —
trading a working production credential for a more convenient test is the
wrong direction.

Instead the suite stopped depending on parity that cannot be maintained:

| Question | How it is answered now | Needs a secret? |
| --- | --- | --- |
| Does the handler verify, accept and deduplicate? | The signed replay runs **in-process** against the route handler; signing and verification share one secret by construction | no drift possible |
| Does it refuse an unsigned request? | Posted at the deployment | **no** |
| Does it refuse a forged signature? | Posted at the deployment | **no** |
| Does it refuse to run with no secret configured? | The secret is removed for one call and restored | no |
| Does the deployment hold the endpoint's secret? | **Stripe's delivery record** — zero pending over 24h | **no** |
| Is there exactly one endpoint, pointing where we think? | `webhookEndpoints.list()` | **no** |

The local `STRIPE_WEBHOOK_SECRET` now participates in **no** assertion. The
risk that actually mattered — a deployment that cannot verify Stripe — is
checked on every run, which is strictly stronger than the parity it replaced.

## 8. Webhook — secret handling

Nothing in this sprint printed, logged, committed or copied a secret. The
Stripe endpoint secret was never read at all: it could not be, and did not
need to be.

`npm run secret:fingerprint STRIPE_WEBHOOK_SECRET` was added for the question
that started this — *are these two the same?* — which is normally answered by
printing both and looking. It reports `missing`, or `configured` with the
prefix, the length and a salted SHA-256 truncated to twelve characters. Same
value, same fingerprint; the fingerprint reverses to nothing.

---

## 9. Finance regression

| | Before | After |
| --- | --- | --- |
| `npm run test:finance` | 123 passed, **2 failed**, 1 human | **134 passed, 0 failed**, 1 human |

**Nine assertions were added, none removed and none skipped.** The two that
failed now pass because they test the same property in a place where it can be
tested; seven more were added around them, six of which exercise the live
deployment.

The one item still requiring a human is unchanged and unrelated: the Stripe
Connect identity check (`proof_of_liveness`).

## 10. Full battery

| Suite | Result |
| --- | --- |
| `npx tsc --noEmit` | clean |
| `npm run lint` | clean |
| `npm run build` | 53 routes |
| `npm run test` | 69 |
| `npm run test:integration` | **213** — see the note below |
| `npm run verify:phase6` | 37 |
| `npm run verify:phase6_1` | 32 |
| `npm run verify:phase7` | 24 |
| `npm run verify:finance` | 16 |
| `npm run verify:operations` | 27 |
| `npm run verify:phase9` | 24 |
| `npm run verify:phase10` | **56** (+7) |
| `npm run test:finance` | **134 / 134** |
| `npm run test:operations` | 40 |
| `npm run test:safety` | 39 |
| `npm run test:exports` | 42 |
| `npm run test:pilot` | 58 |
| **`npm run test:auth`** | **24 / 25** — the failure is the email blocker |

### A flaky assertion, recorded rather than ignored

`test:integration` failed once and passed on the immediate re-run, with no
change between them: *"a driver coming online later is picked up on the next
nudge"*. The suite runs for minutes against the live project while two pg_cron
sweepers run every minute — `cleanup_stale` expires a pending request after 10
minutes and takes a driver offline after 3 minutes without a heartbeat. A long
section racing those sweepers is the likely cause.

It matters because the launch runbook tells somebody to run this battery at
T-24h, and a red line that is really a race will either be ignored or will
stop a launch for nothing. Recorded as `data.test_suite_stability`
(non-blocking). Not fixed here: this sprint was scoped to two other things.

---

## 11. Security review

### Email

- No session is issued before confirmation.
- Signing in before confirming is refused, and names the reason rather than
  blaming the password — while still refusing to confirm whether the address
  exists.
- The confirmation link is single use.
- **An off-site redirect is refused**: asked with `attacker.example.net`,
  falls back to the allow-listed origin.
- `localhost` is deliberately absent from the allow list.
- An email change requires confirmation from both addresses
  (`mailer_secure_email_change_enabled`).
- Password recovery produces a correctly-scoped link — and is **unreachable
  from the product**, which is a gap rather than an exposure.

### Webhook

- A signature is required: missing → 400, forged → 400, both asserted against
  the live deployment.
- The raw body is verified before anything is parsed.
- A missing secret refuses the request entirely (503) rather than falling
  through — now asserted by removing the secret for one call.
- Idempotency is persisted in the database, and the event id is inserted
  **before** any handling. 230 events recorded, **zero duplicate ids**.

### Secrets

`verify:phase10` scans the working tree and the last 50 commits for six secret
patterns and reports matches by file name only. Clean.

---

## 12. Readiness checklist

| | Before | After |
| --- | --- | --- |
| Items | 59 | **61** |
| Ready | 41 | **42** |
| Open blockers | 14 | **14** |

**Closed with proof:**

- `finance.webhook_secret_parity` → **ready**, and retitled to what is
  actually true: *"The webhook endpoint's signing secret is correct wherever it
  is used."* Reframed rather than redefined — the risk it named is now tested
  on every run instead of maintained by memory.

**Left blocked, with a better answer:**

- `product.signup_email` → still **blocked**, now carrying the exact root
  cause, Supabase's own refusals, and the six-step human action.

**Newly recorded:**

- `customer.password_recovery` — **blocker**. There is no password-reset flow
  in the product at all: no link on the login screen, no call to
  `resetPasswordForEmail`, no page to set a new one. The platform side works;
  nothing reaches it. Deliberately not built in a sprint scoped to two other
  blockers, and it needs the same SMTP provider regardless.
- `data.test_suite_stability` — non-blocking, the flaky assertion above.

The three non-technical blockers — the Québec operating authority, the
commission, the first partner and the support channel — were not touched.

---

## 13. Cleanup, verified in the database

| | |
| --- | --- |
| Sprint fixture accounts (`p10-%`) | **0** |
| Accounts total | 3 — the pre-existing admin, driver and E2E rider |
| Orphan auth tokens | none possible: sessions cascade with the user, and no fixture user remains |
| Requests created by this sprint | **0** |
| Product events | 0 |
| Partner codes, allowlist entries | 0 |
| Active pricing configurations | **0** — `pricing_configured()` is still `false` |
| Payments still holding money | **0** |
| Duplicate webhook event ids | **0** of 230 |
| Provider ledger entries | 0 |
| Pilot mode | `off` |
| Secrets in the repository | none |
| Auth configuration left changed by a probe | none — `rate_limit_email_sent` restored to 2 |

---

# LAUNCH BLOCKER SPRINT 1 COMPLETE

- **Email confirmation: BLOCKED** — no SMTP provider. Supabase refuses the
  rate limit, the templates and the sender name without one, in writing. The
  remaining action is a six-step human task with a free-tier provider;
  everything after delivery is proven by `npm run test:auth`.
- **Webhook secret consistency: PASS** — one endpoint, zero events pending
  delivery, unsigned and forged requests refused by the live deployment, the
  handler refusing to run without a secret, and the suite no longer depending
  on a parity that cannot be maintained.
- **Finance tests: 134 / 134** (was 123/125), plus one item awaiting a human.
- **Remaining critical blockers: 6** — email confirmation, password recovery,
  the commission, the first towing partner, the support channel, and the
  Québec operating authority.
- **Readiness score updated: 42 of 61 ready (69 %)**, 14 open blockers.
- **Path to report:** `TOWCONNECT_LAUNCH_BLOCKER_SPRINT1_REPORT.md`

## Verdict

# TECHNICAL BLOCKERS REMAIN

One of the two closed properly, and closed *better* than asked: the webhook
question is now answered by Stripe's own delivery record on every run, rather
than by somebody keeping two environments in step by hand.

The other cannot be closed from a keyboard that is not allowed to create an
account. It is no longer an unknown — it is a six-step task with free options,
a regression test that fails today and will pass when it is done, and three
refusals from Supabase explaining exactly why nothing smaller works.

And the audit found a third: a customer who forgets their password currently
has no way back into their account.
