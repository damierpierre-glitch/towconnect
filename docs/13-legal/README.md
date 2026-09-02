# Legal documents — status and review record

- **Owner:** Founder / Legal
- **Status:** Active
- **Last reviewed:** 2026-09-02
- **Review cycle:** Whenever a document changes, and before the pilot opens
- **Related systems:** `src/lib/content/publicPages.ts`, `/confidentialite`, `/conditions`, `/conditions-partenaires`

## Where the text lives

The published text of every legal document lives in
`src/lib/content/publicPages.ts` and is rendered at `/confidentialite`,
`/conditions` and `/conditions-partenaires`, in French and English.

**It is not duplicated here.** Two copies of a legal document is how a customer
ends up reading one version and a lawyer reviewing another. The files in this
folder are the *review record* for each document: what it claims, what has been
verified, and what has not.

## Status of every document

| Document | Published at | Status |
| --- | --- | --- |
| Privacy policy | `/confidentialite` | **DRAFT — LEGAL REVIEW REQUIRED** |
| Terms of service | `/conditions` | **DRAFT — LEGAL REVIEW REQUIRED** |
| Partner terms | `/conditions-partenaires` | **DRAFT — LEGAL REVIEW REQUIRED** |
| Cookie / analytics disclosure | inside the privacy policy | Draft, and see below |

## What "DRAFT" means here, precisely

The drafts describe the system **as it actually behaves** — which is the half
of a legal document that is usually wrong, and the half we can verify. Every
factual claim in them was checked against the code and the database.

What has *not* happened: nobody qualified has read them. They have no legal
force, they may be missing obligations that apply in Québec, and they may
describe the arrangement in language that would not hold.

The banner saying so is rendered at the top of each published page, inside a
`role="note"` so a screen reader announces it too. Removing that banner is a
decision that requires an actual legal review, not a tidy-up.

## Cookies and analytics

TowConnect sets no advertising or third-party tracking cookie. What is stored
in the browser is: the session cookie required to stay signed in, a language
preference, a random analytics identifier, and a partner code when somebody
arrived through one.

Whether that requires a consent banner under Québec's Law 25 has **not** been
established. It is described in the privacy policy and it is one of the
questions a reviewer must answer.
