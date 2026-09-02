# Pre-launch security review

- **Owner:** Founder / Engineering
- **Status:** Active
- **Last reviewed:** 2026-09-02
- **Review cycle:** Before the pilot opens beyond the allowlist, and after any change to a policy or a capability
- **Related systems:** every RLS policy, `has_admin_capability()`, `safety_link_view()`, `runExport()`, `/api/stripe/webhook`

Performed at the end of Phase 10. **One real finding, fixed. One accepted
risk, recorded.** The rest is what was checked and what makes each answer
true.

---

## Finding 1 — driver identity documents were readable by finance *(fixed, 0048)*

**What was wrong.** 0043 scoped the money and regulatory policies from
`is_admin()` to named capabilities, and 0044 removed the grandfather rule so
an administrator holds only what they were granted. Driver documents were
missed by both. Until 0048, an administrator granted **only `finance`** could
read every driver's licence, insurance certificate and vehicle registration —
the metadata row *and* the image itself, because the signed URL is created
from the caller's own session and the storage policy was also `is_admin()`.

**Why it mattered.** Those are identity documents belonging to people who
agreed to show them for compliance review, not to the finance function. A
capability model where a capability is a label rather than a boundary is
worse than no capability model, because it is quoted as though it were one.

**Exploited?** No. One person holds `super_admin` today and nobody else holds
any grant, so no session existed that the gap would have widened. It was fixed
now because the pilot is when a second administrator first becomes plausible.

**Fix.** `driver_documents` and the `driver-documents` storage bucket are both
scoped to `operations`. `getDriverDocumentSignedUrl()` refuses earlier, so the
caller is told which capability they lack rather than receiving a URL that
404s. Support is deliberately excluded: `driver_compliance_issues()` answers
"is this driver allowed to work" without exposing a document, and that is the
only version of the question support has.

## Finding 2 — the analytics endpoint is reachable without a session *(accepted, recorded)*

`record_product_event()` can be called by an unauthenticated visitor, because
a landing view happens before anybody signs in. It is bounded by a fixed enum
of event names, a 13-key property whitelist enforced by a trigger, a 64-character
value limit, and a cap of 300 events per browser per hour.

It is **not** rate-limited per IP address. Somebody determined could inflate
the funnel. They could not read anything, write anywhere else, or store a
single byte of prose.

**Accepted for a closed pilot**, recorded in `05-data/analytics-events.md`, and
worth adding before the allowlist comes off.

---

## What was reviewed, and what makes each answer true

### Authentication and sessions

Supabase Auth. Sessions are cookie-based and refreshed in `proxy.ts` on every
matched request, so a token is never held in `localStorage` where a script
could read it. The auth callback exchanges a code for a session server-side.

A wrong password now says *"Courriel ou mot de passe incorrect"* — which names
the two things to check while still refusing to confirm whether the address
exists.

### Row-level security

213 assertions run against the live database (`npm run test:integration`), not
a local copy. They test the refusals, not the permissions: a driver reading
another driver's job, a company reading another company's ledger, a customer
reading somebody else's request.

### SECURITY DEFINER functions

Every one carries `set search_path = public` and a null-safe authorization
guard: `coalesce(auth.role(), '') <> 'service_role' and not coalesce(has_admin_capability(...), false)`.

The `coalesce` is not decoration. `auth.role()` returns NULL for an anonymous
caller, `NULL <> 'x'` is NULL, and `if NULL then` never fires — so the obvious
form of this guard **fails open**. That was a real hole found in Phase 7.1 and
fixed in 0039; the four Phase 10 functions were written with it in mind.

### The service role

`src/lib/supabase/admin.ts` imports `server-only`, so any client-side use is a
build error rather than a leak. `verify:phase10` asserts that no file marked
`'use client'` reaches it. The key exists in `.env.local` and in the
deployment environment, and nowhere else.

### Exports

Each dataset names the capabilities that may export it, re-checked on the
server against the database's own answer. The browser sends **filters, never
rows and never ids** — a list of ids from a client is a request to trust the
client about what it may read. Columns are enumerated by hand, so adding a
column to a table cannot silently start exporting it. Every export is written
to `export_audit` with the capability that authorized it, and the file itself
is never stored.

### The safety link

A bearer credential, so only its SHA-256 is stored: TowConnect cannot
reproduce a link it has already issued. `requests.id` is deliberately not the
secret — it appears in admin URLs, support tickets and logs. The public
surface is a hand-written projection of 18 fields, asserted field-by-field by
`verify:phase9`; adding a column to that function fails the check, because
adding a column publishes it.

### The Stripe webhook

HMAC signature verified with `stripe.webhooks.constructEvent` against the raw
body before anything is parsed. Replays are absorbed by an idempotency ledger
(`stripe_webhook_events`). Status writes are monotonic — a late
`amount_capturable_updated` cannot un-capture a captured payment, which it did
once and now cannot.

### Stripe mode

Test mode, and the application refuses a live secret key at startup with a
unit test asserting the refusal. No bank number, identity document or KYC
field is stored anywhere in TowConnect; Connect onboarding happens on Stripe's
hosted flow.

### Admin capabilities

Four: `super_admin`, `operations`, `finance`, `support`. No grandfather rule
since 0044 — no grant means no privileged access at all. UI checks exist so
somebody is not offered a door that will not open; the database is what
refuses.

### Documents and signed URLs

Private bucket, one folder per driver, path-keyed policies. Signed URLs expire
in **120 seconds** and are created from the caller's own session, never from
the service role. Since 0048, only `operations` can create one.

### Logs

No `console.log` of a payload anywhere in `src/`. Errors are logged with
`console.error` and classified through `src/lib/errors.ts`, which is also what
decides the sentence the user sees — so the detail reaches the log and never
the screen. The Stripe webhook logs event ids, never card data.

### Secrets

`verify:phase10` scans the working tree and the last 50 commits for Stripe
secret and restricted keys, webhook signing secrets, Supabase service-role
JWTs, Mapbox secret tokens and Postgres URIs carrying a password. **A match is
reported by file name; the value is never printed.** `.env` files are excluded
because holding a secret is what they are for and they are gitignored — the
check is that nothing *else* holds one. Clean at the time of this review.

---

## Accepted risks, listed rather than resolved

| Risk | Why it is accepted for a closed pilot | What removes it |
| --- | --- | --- |
| Analytics endpoint has no per-IP rate limit | Bounded enum, whitelist, per-browser cap; nothing readable | A rate limit before the allowlist comes off |
| Alerts appear on one screen and nowhere else | The founder is watching during the pilot | Email or SMS delivery |
| No durable error tracking | Platform logs only, small volume | An error tracker |
| Broad `is_admin()` read policies remain on operational tables (requests, profiles, payments, vehicles) | These are the tables support and operations both legitimately read; narrowing further would break the support console without a privacy gain | A `support` / `operations` split if a third administrative role appears |
| Email confirmation is rate-limited by Supabase's built-in SMTP | Found during Phase 10: signup returns *email rate limit exceeded* after a handful of attempts per hour | Custom SMTP before real customers sign up — recorded as a launch blocker |

The last one is a **launch blocker**, not merely an accepted risk: a first
customer who cannot confirm their email cannot request a tow.
