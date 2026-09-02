# Privacy policy — review record

- **Owner:** Founder / Legal
- **Status:** DRAFT — LEGAL REVIEW REQUIRED
- **Last reviewed:** 2026-09-02
- **Review cycle:** Before the pilot opens to anybody outside the allowlist
- **Related systems:** `src/lib/content/publicPages.ts` (`privacy`), `/confidentialite`

The published text is at `/confidentialite`. This page records what it claims
and how each claim was checked.

## Claims, and how each was verified

| Claim | Verified against |
| --- | --- |
| No card data is stored by TowConnect | `payments` stores a Stripe identifier and an amount; no PAN column exists |
| Analytics carries no personal data | `guard_product_event_props()` refuses any key off a 13-item whitelist |
| A driver sees only their assigned job | RLS policies on `requests`, `profiles`, `messages`; 213 assertions in `test:integration` |
| A company sees only its own drivers and jobs | `is_company_member()` / `driver_company_id()` policies |
| Staff access is scoped by capability | `has_admin_capability()`, no grandfather rule since 0044 |
| Every export is logged | `export_audit`, written with the capability that authorized it |
| The safety link shows 18 fields and nothing else | `safety_link_view()`, asserted field-by-field by `verify:phase9` |
| A safety link expires and can be revoked | `safety_links.expires_at`, `revoked_at`, unique live-link index |

## What the document deliberately does not claim

- **No retention period.** None has been agreed. The draft says so rather than
  copying a standard number that reflects no decision. `safety_link_lifetime`
  and `safety_link_grace` are labelled engineering defaults for the same reason.
- **No contact channel for privacy requests.** None exists yet. The draft says
  a channel will be published rather than printing an inbox nobody reads.

## What a reviewer must decide

1. Does Québec's Law 25 require a privacy officer to be named, and a consent
   mechanism for the analytics identifier?
2. Is a retention period legally required, and what is it per category?
3. Is the description of the intermediary relationship adequate for the
   purposes of consent — the customer's data reaches an independent towing
   company, which is a transfer to a third party.
4. Are the access, correction and deletion rights adequately described, and can
   they actually be exercised through the product as built?
