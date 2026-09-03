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

### The remaining human action

1. Create an account with a transactional email provider. Resend, Brevo and
   Postmark all have free tiers adequate for a pilot.
2. Verify a sending domain.
3. Supabase → Authentication → Emails → SMTP Settings: host, port, user,
   password, sender address and name.
4. Raise `rate_limit_email_sent` to something a pilot can live with.
5. Apply `supabase/auth-templates/templates.ts` — template changes are
   rejected until step 3 is done.
6. `npm run test:auth` should then pass every assertion.

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

Supabase can produce a recovery link and returns it only to an allow-listed
origin, both asserted.

**Nothing in the product reaches it.** There is no "mot de passe oublié" link,
no call to `resetPasswordForEmail`, and no page to set a new password. A
customer who forgets theirs currently has no route back into their account.

Recorded as the launch blocker `customer.password_recovery`. It was found by
this audit and deliberately not built in the same sprint — and it needs the
same SMTP provider regardless, because a recovery email nobody receives is not
recovery.

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
| An email change requires confirmation from both addresses | `mailer_secure_email_change_enabled` |
| A wrong password does not reveal whether the address exists | `err_bad_credentials` |
