# Account lifecycle — signup, confirmation, recovery

- **Owner:** Founder / Engineering
- **Status:** Active
- **Last reviewed:** 2026-09-03
- **Review cycle:** Whenever the auth configuration or an email template changes
- **Related systems:** Supabase Auth, `handle_new_user()`, `/auth/callback`, `supabase/auth-templates/templates.ts`, `npm run test:auth`

## The path a customer actually walks

1. They submit the signup form. `role` and `full_name` go in the user metadata.
2. **No session is issued.** `mailer_autoconfirm` is off, so an account is not
   usable until the address is confirmed.
3. Supabase sends a confirmation email carrying a one-time link.
4. The link hits Supabase's `/auth/v1/verify`, which marks the address
   confirmed and redirects back to TowConnect.
5. `/auth/callback` exchanges the code for a session and lands them on their
   role's home.
6. `handle_new_user()` has already created their `profiles` row; they can read
   it, and only it.

Every step above is asserted by `npm run test:auth` against the live project.
The link it follows is the very URL the email carries — `generateLink` produces
it without sending anything.

## What is NOT proven, and why

**Delivery.** This project has no SMTP provider, so mail goes through
Supabase's shared testing mailer.

| | |
| --- | --- |
| `smtp_host` | not set — built-in provider |
| `rate_limit_email_sent` | **2 per hour, for the whole project** |
| `smtp_max_frequency` | 60 s per address |
| Template customisation | **refused** by the Management API on the free tier with the default provider |

Two customers an hour is not a pilot. This is the launch blocker
`product.signup_email`, and `npm run test:auth` fails on exactly that
assertion — deliberately, so it turns green the day it is fixed and not
before.

### There is no TowConnect domain, and that shapes the answer

Checked rather than assumed: `towconnect.ca`, `.com`, `.app` and `.io` are all
**registered to somebody else**, and none of them resolves — no nameservers, no
MX, no TXT. TowConnect has no domain of its own today.

That rules out the usual advice. SPF, DKIM and DMARC are records on a domain
you control; with no domain there is nothing to publish them on, and providers
that require domain verification (Resend, Postmark) cannot be completed.

**So the provider has to be one whose free tier verifies a single SENDER
ADDRESS rather than a domain.** Brevo does this: you confirm one mailbox by
clicking a link in it, and send from that address. Mail is then signed with the
provider's own domain — DKIM and SPF pass on *their* domain, DMARC alignment
does not, which is acceptable for a closed pilot sending to a handful of
allow-listed people and is not acceptable at volume.

### The remaining human action

1. Create an account with a transactional provider that verifies a **sender
   address** rather than a domain. No card is required on the free tiers.
2. Verify the sending mailbox by clicking the link it sends.
3. Supabase → Authentication → Emails → SMTP Settings: host, port, user,
   password, sender address and name.
4. Raise `rate_limit_email_sent`. It is **locked at 2** until step 3 is done —
   the Management API refuses with *"Custom SMTP required to configure
   SMTP_SENDER_NAME or RATE_LIMIT_EMAIL_SENT"*.
5. Apply `supabase/auth-templates/templates.ts`. Also locked until step 3:
   *"Email template modification is not available for free tier projects using
   the default email provider."*
6. `npm run test:auth` should then pass every assertion.

### Later: a domain, and proper alignment

When TowConnect does own a domain, the sending setup should move to it: add
the provider's DKIM records, an SPF record naming the provider, and a DMARC
record starting at `p=none` while the reports are read. Until then, the
sender-address route is the honest option rather than a compromise nobody
wrote down.

## Running the email provider

**Who watches it.** Nobody, automatically. There is no bounce webhook and no
alert on delivery failure — the provider's own dashboard is the only place a
bounce or a spam complaint appears. During the pilot that is a daily human
check, and it belongs in the end-of-day review.

**What to check, in order, when somebody says they never got the email:**

1. Did Supabase hand it over? `confirmation_sent_at` on the user row. Null
   means it never reached the mailer at all — look at the rate limit first.
2. Did the provider accept it? Its dashboard shows accepted, bounced or
   dropped per message.
3. Did it bounce? A hard bounce means the address is wrong; tell them, and do
   not retry into the same address.
4. Is it in spam? Likely while sending from a provider-owned domain. Ask them
   to check, and record it — a pattern here is the argument for buying a
   domain.
5. Only then look at the application.

**Changing provider later.** Nothing in TowConnect knows which provider is in
use: the SMTP settings live in Supabase and the templates are applied from
this repository. Swapping means new SMTP credentials in Supabase, re-applying
`supabase/auth-templates/templates.ts`, and re-running `npm run test:auth`. No
deployment, no code change.

**Credentials never live here.** Not in the repository, not in a report, not
in `.env.local` — Supabase holds them, and the only thing written down
anywhere is which fields are set.

## Redirects

`site_url` and the redirect allow list are **the Vercel production origin
only**. `localhost` is deliberately absent.

That means a confirmation link opened during local development returns to
production rather than to the developer's machine. It is the right trade for
a project whose database is the real one: every entry in that allow list is a
place an authentication code can be delivered to, and `http://localhost:3000`
on a victim's machine is a place an attacker can listen. Confirmation flows
are therefore tested against the deployment, which is where they run anyway.

`npm run test:auth` asks for a link pointing at `attacker.example.net` and
asserts it does not come back — the allow list is verified rather than
assumed.

## Password recovery

Built in Launch Blocker Sprint 2. Two screens, one server action each way.

1. **`/mot-de-passe-oublie`** — the address is submitted to
   `requestPasswordReset`, which returns **nothing at all**: not a boolean,
   not an error, not a different screen. A form that distinguishes "no such
   account" from "link sent" answers *does this person have a TowConnect
   account?* for anybody who asks, at whatever rate they like. Failures,
   including the mail quota being spent, are logged and swallowed for the same
   reason — a rate-limit message reaching the browser would tell an enumerator
   that their previous guess did something.
2. The email carries a one-time link.
3. **`/nouveau-mot-de-passe`** — the link lands here and the browser client
   turns it into a session. Setting the password is then an ordinary
   authenticated call to `updatePassword`.

### Why the link does not go through `/auth/callback`

Supabase returns a recovery session in one of two shapes: `?code=` for the
PKCE flow, or **tokens in the URL fragment**. A fragment is never sent to a
server, so a route handler in the middle sees an empty request and bounces
somebody holding a perfectly valid link to the login screen.

The link therefore points straight at the page, which is a client component,
and the browser client consumes either shape on load. One fewer hop, and no
failure mode that depends on which flow Supabase chose.

### What happens to other sessions — measured, not assumed

**They stop working.** Changing a password revokes sessions elsewhere;
`npm run test:auth` establishes a second session, changes the password from
the first, and observes the second stop working.

That is Supabase's behaviour, recorded because it was checked. If it ever
changes, the suite will say so rather than this page quietly becoming wrong.

### Still gated on delivery

A recovery email nobody receives is not recovery. The flow is complete and
proven; it waits on the same SMTP provider as signup confirmation.

## The emails themselves

Three templates, versioned in `supabase/auth-templates/templates.ts` and
checked by `verify:phase10`: confirmation, recovery, magic link.

- **French first, English in the same message.** Supabase sends one template
  per event, and a bilingual city deserves both in the envelope it receives.
- **No image, no external stylesheet, no tracking pixel.** A transactional
  email that renders as an empty box because a mail client blocked a CDN is a
  customer who cannot create an account.
- **The button is `#cc4400`, not the brand orange.** White on `#ff5c1a`
  measures 3.09:1 and fails WCAG AA — the same finding the product's buttons
  acted on in Phase 10, applied here so an email and a screen do not disagree.

## Security properties, and where each is checked

| Property | Checked by |
| --- | --- |
| No session before confirmation | `test:auth` §1 |
| Signing in before confirming is refused, and says why | `test:auth` §3 |
| A redirect cannot be pointed off-site | `test:auth` §4 |
| The confirmation link is single use | `test:auth` §6 |
| The recovery link returns only to an allow-listed origin | `test:auth` §8 |
| A reset request answers identically for a known and an unknown address | `test:auth` §9 |
| The reset link is single use | `test:auth` §12 |
| A password change revokes other sessions | `test:auth` §13 |
| `?next=` cannot become an open redirect | `safeRedirect.test.ts`, 6 hostile inputs |
| An email change requires confirmation from both addresses | `mailer_secure_email_change_enabled` |
| A wrong password does not reveal whether the address exists | `err_bad_credentials` |

## Where the mail quota bites, and how the suite proves it

`test:auth` §1 does **not** attempt one signup. One attempt passes or fails
depending on whether the hourly quota happens to be spent — a coin toss
dressed as a test.

It attempts **three in a row**, which is the real pilot question: can a
handful of customers create accounts in the same hour? With the built-in
mailer's two per hour for the whole project, the third always fails. The
assertion is therefore deterministic, and it turns green the day a provider is
configured rather than the next time the quota happens to be free.
