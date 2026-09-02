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

## Documentation as code — a standing rule

Every change from here on asks, before it merges:

- does this change a **KPI definition**? → `05-data/kpi-definitions.md`
- does it add or rename a **concept**? → `05-data/data-dictionary.md`
- does it change **who may do what**? → `08-security/admin-access-policy.md`
- does it change **what can leave the system**? → `08-security/export-policy.md`
- does it change an **operational procedure**? → `09-sops/`
- is it a **structural decision**? → a new ADR in `10-decisions/`

Code and documentation drifting apart is how a knowledge base becomes a liability
rather than an asset. The rule exists so the drift is caught at the moment it
would start.

## Ownership today

TowConnect has no departments yet. Documents are owned by `Founder / Product`,
or marked `Unassigned — future <role>` where a specialist function will
eventually own them. **No employee is invented in these pages.**
