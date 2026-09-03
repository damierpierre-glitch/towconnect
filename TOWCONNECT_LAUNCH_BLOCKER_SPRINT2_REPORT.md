# TowConnect — Launch Blocker Sprint 2

## Auth and email readiness

**Date:** 2026-09-03 · **Scope:** SMTP, confirmation, password recovery, the flaky integration test

---

Three things went in. **Two are closed with proof.** The third — SMTP — turned
out to be blocked by something nobody had checked: TowConnect owns no domain,
and the four obvious ones are registered to other people. That changes which
provider is even possible, so the handover is different from the one Sprint 1
wrote.

Password recovery, which Sprint 1 discovered did not exist, is **built,
attacked and proven**. The flaky integration test is **fixed**, with a root
cause that contradicts the guess Sprint 1 made about it.

---

## 1. SMTP — provider choice, and why the obvious advice was wrong

Sprint 1's handover said: pick Resend, Brevo or Postmark, verify a sending
domain, done. The first half survives. The second does not.

### There is no TowConnect domain

Checked, not assumed:

| Domain | Registered | Resolves |
| --- | --- | --- |
| `towconnect.ca` | **yes, to somebody else** | no NS, no MX, no TXT |
| `towconnect.com` | **yes, to somebody else** | nothing |
| `towconnect.app` | **yes, to somebody else** | nothing |
| `towconnect.io` | **yes, to somebody else** | nothing |

The site runs on `towconnect-chi.vercel.app`, and `vercel.app` is not a domain
TowConnect can publish DNS records on.

**SPF, DKIM and DMARC are records on a domain you control.** With no domain
there is nowhere to put them, and every provider that requires *domain*
verification — Resend and Postmark among them — cannot be completed at all.

### So the provider has to verify a sender address, not a domain

The requirement becomes: a free tier that verifies **one mailbox** by sending
a link to it. **Brevo** does this — click the link in the mailbox, then send
from that address, 300 messages a day at no cost and no card.

Mail is then signed with the provider's own domain: SPF and DKIM pass on
*theirs*, DMARC alignment does not. For a closed pilot sending to a handful of
allow-listed people that is acceptable and should be written down rather than
discovered. At volume it is not, and the answer then is a domain.

**No account was created and nothing was purchased.** Creating an account is
not something this session may do.

### DNS status

Nothing to report, because there is nothing to configure. No SPF, no DKIM, no
DMARC exists on a TowConnect domain, and none can until one is owned. Declaring
otherwise would be exactly the kind of unverified green tick this project keeps
refusing to write.

## 2. Supabase SMTP — status, and three refusals

Unchanged: **no custom SMTP**. `smtp_host`, `smtp_user`, `smtp_pass` and
`smtp_admin_email` are all unset, and `hook_send_email_enabled` is false.

Supabase refuses, in its own words, every configuration change that would help:

| Attempted | Response |
| --- | --- |
| Brand the templates | *"Email template modification is not available for free tier projects using the default email provider."* |
| Raise `rate_limit_email_sent` | *"Custom SMTP required to configure SMTP_SENDER_NAME or RATE_LIMIT_EMAIL_SENT. Missing SMTP_ADMIN_EMAIL, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS fields."* |
| Sign three customers up in an hour | Two succeed, the third is refused: `email rate limit exceeded` |

The rate-limit probe **restored the value immediately**; nothing was left
changed by a measurement.

### Rate limits, once a provider exists

`rate_limit_email_sent` should be raised to something a closed pilot can live
with and no more — a number in the low tens, not thousands. It is an
operational parameter, and the reason to keep it small is the same reason it
exists: an auth mailer that can send unboundedly is a spam cannon pointed at
whoever a stranger names. Recorded in `03-operations/account-lifecycle.md`
rather than chosen here, because it is a decision, not a default.

## 3. Email confirmation — E2E

`npm run test:auth`, against the live project.

| Step | Result |
| --- | --- |
| Three signups in a row | **FAILS — the blocker** (below) |
| No session before confirmation | pass |
| `confirmation_sent_at` set | pass — Supabase accepted it for delivery |
| Signing in before confirming | refused, and says *"Email not confirmed"* |
| The link the email carries | project auth host, token, typed `signup`, allow-listed return |
| Following it | 303 back to TowConnect, no error, **address confirmed** |
| Following it twice | refused — single use |
| Signing in afterwards | works |
| From a client that never saw the first | works |
| The `profiles` row the trigger created | readable by its owner, with the role chosen at signup |

### The one failure, made deterministic

Sprint 1's version attempted **one** signup, which passed or failed depending
on whether the hourly quota happened to be spent — a coin toss dressed as a
test. It now attempts **three in a row**, which is the real pilot question:
*can a handful of customers create accounts in the same hour?*

With two per hour for the whole project, the third always fails. The assertion
is red today for a reason that cannot go away by luck, and it turns green the
day a provider is configured.

**44 of 45 assertions pass.**

## 4. Password recovery — built, and E2E

Sprint 1 found there was no password-reset flow at all. There is now.

`/mot-de-passe-oublie` → `requestPasswordReset` → email → link →
`/nouveau-mot-de-passe` → `updatePassword` → signed in.

| Step | Result |
| --- | --- |
| A reset link is produced and correctly scoped | pass |
| It lands on the new-password page, not a route handler | pass |
| The landing carries a recovery session | pass — as **fragment tokens** |
| The tokens establish a session | pass |
| A short password | refused by the server action, not only the form |
| The password is changed | pass, through the real action |
| The old password | **stops working** |
| The new password | works |
| The link used twice | refused |
| Other sessions | **stop working** — measured, not assumed |

Walked in the browser as well, at 375px: the request screen renders, an
address nobody owns produces the identical confirmation, an invalid fragment
is refused cleanly instead of crashing, mismatched passwords are caught, and a
completed change signs the customer straight into their own home. Verified
afterwards from outside that the old password no longer authenticates and the
new one does.

### Why the link does not go through `/auth/callback`

Supabase returns a recovery session in one of two shapes: `?code=` for PKCE,
or **tokens in the URL fragment**. A fragment is never sent to a server.

Routing the link through a route handler would therefore have bounced anybody
whose link arrived in the fragment form straight to the login screen, holding
a perfectly valid link — a denial of recovery we would have inflicted on
ourselves. The link points at the page, which is a client component, and the
browser client consumes either shape.

The test observed the fragment form and would have caught this had it been
built the other way.

## 5. Anti-enumeration

`requestPasswordReset` returns **`void`**. Not a boolean, not an error, not a
different screen — there is no channel through which the two cases could
differ.

- A registered address and an unregistered one both complete without error.
- An empty or malformed address is refused locally, before anybody is
  contacted.
- Provider failures, **including the mail quota being spent**, are logged and
  swallowed. A rate-limit message reaching the browser would tell an
  enumerator that their previous guess did something.
- The screen shows one sentence either way, verified in the browser with an
  address nobody owns.

Timing is recorded rather than asserted — 31 ms against 25 ms on the last run.
Claiming constant time from two samples would be the kind of unearned assurance
this report is supposed to avoid.

## 6. Redirect security

`/auth/callback` concatenated an attacker-controllable `?next=` onto the
origin. It now goes through `safeNext`, in its own module, with six hostile
inputs unit-tested:

| Refused | Why it matters |
| --- | --- |
| `//evil.example` | **The one that catches people out.** Concatenated onto an origin it still looks like a path, and enough clients resolve it as a host |
| `https://evil.example` | the obvious case |
| `javascript:alert(1)` | not a path |
| `/\evil.example` | several browsers normalise the backslash to `/`, turning it into the first case |
| whitespace, control characters | how a second value gets smuggled past a naive parser |
| `relative/path` | not rooted |

Hyphens are deliberately allowed — `/nouveau-mot-de-passe` contains one, and a
guard that breaks a real route gets removed rather than fixed.

Supabase's own allow list is verified separately: `test:auth` asks for a link
pointing at `attacker.example.net` and asserts it does not come back.

## 7. The pg_cron race — root cause, and the correction

**Sprint 1's guess was wrong, and this is what it actually was.**

Sprint 1 reported that `test:integration`'s *"a driver coming online later is
picked up on the next nudge"* failed about one run in three, and guessed at a
race with the `cleanup_stale` sweepers. Reproducing it in isolation
(`scripts/diagnose-dispatch-race.ts`) showed 6 runs out of 6 passing — so the
cause was not in the scenario.

Forcing the every-minute scheduler to move first reproduced it **2 times out
of 2**, and the dump named it:

```
offers:  driver A  declined
         driver B  timeout      ← offered at 03:13:00.5, a round minute
explain: both drivers excluded, reason "already_offered_this_request"
```

The **dispatch-tick scheduler** was picking the request up in the few hundred
milliseconds between the late driver coming online and the test's nudge, and
offering the work to them **itself**. Its 18-second window then lapsed, the
offer became `timeout`, and by the time `nudge_dispatch` ran there was no
candidate left at all — so it correctly returned null.

Nothing was broken. The old assertion tested **who** delivered the offer,
which the test does not control and does not care about.

### The fix

The assertion now checks the invariant it exists to protect: **a driver who
comes online after the pool was exhausted is considered and offered the work**
— by the nudge or by the scheduler, whichever got there first. Once the offer
row exists it stays, so the check is deterministic.

Proven both ways: **6/6** with the nudge winning, **2/2** with the scheduler
forced to win, and **three consecutive full-suite runs at 213/213**.

Deliberately *not* fixed by disabling the scheduler, sleeping, or retrying. All
three would have hidden a real failure just as effectively as this race hid
nothing.

## 8. Tests

| Suite | Result |
| --- | --- |
| `npx tsc --noEmit` | clean |
| `npm run lint` | clean |
| `npm run build` | 55 routes (+2) |
| `npm run test` | **75** (+6 redirect-guard tests) |
| `npm run test:integration` | **213 × 3 consecutive runs** |
| `npm run verify:phase6` | 37 |
| `npm run verify:phase6_1` | 32 |
| `npm run verify:phase7` | 24 |
| `npm run verify:finance` | 16 |
| `npm run verify:operations` | 27 |
| `npm run verify:phase9` | 24 |
| `npm run verify:phase10` | **62** (+6) |
| `npm run test:finance` | **134 / 134** |
| `npm run test:operations` | 40 |
| `npm run test:safety` | 39 |
| `npm run test:exports` | 42 |
| `npm run test:pilot` | 58 |
| **`npm run test:auth`** | **44 / 45** — the failure is the SMTP blocker |

No test was disabled, skipped or weakened. The one assertion that changed
shape now tests something truer and passes deterministically in both timings.

## 9. Security checks

| Check | Result |
| --- | --- |
| Email enumeration | No channel — the action returns `void`, verified in the browser too |
| Reset token reuse | Refused |
| Confirmation token reuse | Refused |
| External redirects | Refused by `safeNext` (6 unit tests) and by Supabase's allow list |
| Session before confirmation | None issued; sign-in refused with the reason |
| Password change | Revokes other sessions — **measured** |
| Password floor | 8 characters, enforced server-side |
| SMTP secrets in the client | None exist; when they do they live in Supabase, not here |
| Secrets in logs | None — provider errors are logged without payloads |
| Secrets in the repo | Clean, scanned over the tree and the last 50 commits |

## 10. Readiness

| | Sprint 1 | Sprint 2 |
| --- | --- | --- |
| Items | 61 | 61 |
| Ready | 42 | **44** |
| Open blockers | 14 | **13** |

**Closed with proof**

- `customer.password_recovery` → **ready**. Built, attacked, proven headlessly
  and in the browser.
- `data.test_suite_stability` → **ready**. Root cause named, fix deterministic
  in both timings, three clean consecutive runs.

**Still blocked, with a better answer**

- `product.signup_email` → **blocked**. Now reproduced deterministically, with
  three Supabase refusals quoted and the domain finding that changes which
  provider is possible.

Untouched, as instructed: the Québec operating authority, the towing partners,
the human support channel, and the commission.

## 11. Cleanup, verified in the database

| | |
| --- | --- |
| Sprint fixture accounts (`p10-%`) | **0** |
| Accounts total | 3 — the pre-existing admin, driver and E2E rider |
| Pending confirmation tokens | **0** |
| Pending recovery tokens | **0** — one left over from Sprint 1's sign-in attempt was cleared |
| Fixture requests | **0** |
| Product events | 0 |
| Partner codes | 0 |
| Active pricing configurations | **0** — `pricing_configured()` still `false` |
| Payments still holding money | **0** |
| Duplicate webhook event ids | **0** |
| Pilot mode | `off` |
| Temporary scripts | none — every probe left in the repo is documented and reusable |
| Secrets in the repository | none |
| Auth configuration changed by a probe | none — `rate_limit_email_sent` restored |

---

# LAUNCH BLOCKER SPRINT 2 COMPLETE

- **Custom SMTP: BLOCKED** — no provider, and the handover changed: TowConnect
  owns no domain and the four obvious ones are registered elsewhere, so the
  provider must be one that verifies a sender **address**. Three Supabase
  refusals, quoted, explain why nothing smaller works.
- **Email confirmation E2E: BLOCKED on delivery, PASS on everything else** —
  44 of 45 assertions, the failure being the mail quota, now reproduced
  deterministically instead of by luck.
- **Password recovery E2E: PASS** — built this sprint, proven headlessly and
  in the browser, including that a password change revokes other sessions.
- **Integration race: FIXED** — root cause named (the dispatch scheduler, not
  the cleanup sweepers), fix deterministic in both timings, 213/213 three times
  in a row.
- **Tests:** 75 unit · 213 RLS × 3 · 134 finance · 62 + 24 + 27 + 16 + 24 + 32
  + 37 verification · 58 pilot · 42 exports · 40 operational · 39 safety ·
  **44/45 auth**.
- **Remaining critical blockers: 5** — email delivery, the commission, the
  first towing partner, the support channel, the Québec operating authority.
- **Updated readiness: 44 of 61 ready (72 %)**, 13 open blockers.

## Verdict

# AUTH TECHNICAL BLOCKERS REMAIN

Two of the three closed, and the account lifecycle is now complete and
defensible end to end: nothing is issued before confirmation, a forgotten
password has a way back, neither form will tell a stranger who has an account,
and no link in the chain can be pointed somewhere it should not go.

What remains is not engineering. Somebody has to create an account with a mail
provider — free, no card, one mailbox to confirm — and paste five values into
Supabase. Until then the platform can accept two customers an hour, and
`npm run test:auth` will keep saying so.
