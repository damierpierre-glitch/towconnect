# TowConnect — Internal Knowledge Base

Versioned with the code, in the same repository, reviewed in the same pull
requests. Markdown, deliberately: a document that lives beside the thing it
describes is a document somebody notices is wrong.

## Structure

| Folder | Contains |
| --- | --- |
| `01-company` | How this platform decides things |
| `02-product` | What it does, and for whom |
| `03-operations` | Dispatch, regulated zones, the operator's playbook |
| `04-finance` | The money: lifecycle, refunds, payouts |
| `05-data` | Data dictionary and KPI definitions |
| `06-support` | How support answers a customer |
| `07-compliance` | Regulated towing, and what we refuse to assume |
| `08-security` | Admin access and export policy |
| `09-sops` | Runbooks for things that go wrong |
| `10-decisions` | Architecture Decision Records |
| `11-partners` | Onboarding a towing company, and what to hand them |
| `12-commercial` | The 30-day pilot plan and what to say on the phone |
| `13-legal` | Review records for the published legal documents |

## Documentation as code — a standing rule

Every change from here on asks, before it merges:

- does this change a **KPI definition**? → `05-data/kpi-definitions.md`
- does it add or rename a **concept**? → `05-data/data-dictionary.md`
- does it change **who may do what**? → `08-security/admin-access-policy.md`
- does it change **what can leave the system**? → `08-security/export-policy.md`
- does it change an **operational procedure**? → `09-sops/`
- is it a **structural decision**? → a new ADR in `10-decisions/`
- does it change a **public claim**? → `src/lib/content/publicPages.ts`, and
  `verify:phase10` will fail on a promise the system cannot keep
- does it change an **analytics event**? → `05-data/analytics-events.md`
- does it change **how somebody signs up or gets back in**? →
  `03-operations/account-lifecycle.md`
- does it change **who may operate, or where**? → `02-product/pilot-territory.md`

Code and documentation drifting apart is how a knowledge base becomes a liability
rather than an asset. The rule exists so the drift is caught at the moment it
would start.

## Ownership today

TowConnect has no departments yet. Documents are owned by `Founder / Product`,
or marked `Unassigned — future <role>` where a specialist function will
eventually own them. **No employee is invented in these pages.**

## Where the public and legal text lives

The published text of the marketing, trust and legal pages is **not** in this
folder. It lives in `src/lib/content/publicPages.ts`, in French and English,
and is rendered at `/a-propos`, `/comment-ca-marche`, `/securite`, `/contact`,
the four local pages, and the three legal pages.

Two copies of a legal document is how a customer reads one version while a
lawyer reviews another. `13-legal/` holds the **review record** for each
document — what it claims, how each claim was verified, and what a reviewer
still has to decide.

`verify:phase10` reads that file and fails on a promise the system cannot
keep: 24/7 availability, a guarantee, a count of operators, a rating, national
coverage, or a response time. A sentence that *denies* one of those is fine —
the check looks for claims, not for words.
