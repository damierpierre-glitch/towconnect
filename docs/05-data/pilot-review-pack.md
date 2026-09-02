# Pilot review pack — reviewing the pilot from data, not from memory

- **Owner:** Founder / Product
- **Status:** Active
- **Last reviewed:** 2026-09-02
- **Review cycle:** Weekly during the pilot
- **Related systems:** `/dashboard/admin/operations/exports`, `ops_kpis()`, `funnel_summary()`, `export_audit`

A weekly review built from exports that already exist. Nothing here is a new
report, a new number, or a new definition — a second definition of a KPI is how
two people end up quoting different figures for the same week.

**Everything in the pack is real or absent.** An empty pilot week produces an
empty pack, and that is the correct output.

## What to pull, and who can pull it

Every dataset is scoped to a capability. An export is always a **subset** of
what that person could already read on screen — never a way around it.

| # | Dataset | Capability | What it answers |
| --- | --- | --- | --- |
| 1 | Interventions | `operations`, `support` | Every job: when, what, where, who, what state |
| 2 | Répartition | `operations` | Every offer: who was asked, who accepted, who timed out |
| 3 | Paiements | `finance` | Authorizations, captures, failures |
| 4 | Remboursements | `finance` | What was returned, and against which job |
| 5 | Grand livre partenaire | `finance` | What each partner earned and what was paid |
| 6 | Incidents | `operations` | Every time a human had to intervene |
| 7 | Indicateurs | `operations`, `finance` | `ops_kpis()` for the period |

Somebody with only `support` gets datasets 1 and 6 and is refused the rest — by
the server, not by the menu. Every export is written to `export_audit` with the
capability that authorized it.

## The weekly review, in order

### 1. Did it work?

From **Indicateurs**:

- Requests created, matched, completed, cancelled, expired.
- Match rate, completion rate, cancellation rate.
- Median time to match, median time to arrival.

A rate over an empty denominator is **NULL, not zero**. "No requests yet" and
"nothing ever matched" are different facts and the export keeps them apart.

### 2. Where did people stop?

From the funnel on `/dashboard/admin/operations/health`. Read the conversion
column, and remember that a blank conversion means the previous step never
happened — it is not a 0%.

The step to watch during a pilot is **estimate shown → checkout started**. That
is the moment somebody sees a price and decides.

### 3. What did a human have to do?

From **Incidents**. Count them, and read the resolution notes rather than the
counts. During a pilot, one well-described incident is worth more than the
count of ten.

`requests_needing_human` in `ops_kpis()` is built from these, so an
intervention nobody recorded makes the platform look more autonomous than it is.

### 4. Did the money add up?

From **Paiements**, **Remboursements** and **Grand livre partenaire**, plus the
reconciliation exceptions on the finance screen. The week is not closed while
an exception is open.

Check specifically that no partner shows earnings while their Connect account
cannot pay out — that is a commitment we cannot honour, and it has its own
alert.

### 5. Who worked, and who did not?

From **Répartition**. Acceptance rate per company, and time-to-accept. A
partner declining everything is a conversation, not a penalty: they are telling
you something about the offer.

## Formats

- **CSV** for anything that goes into another tool. UTF-8 with a byte-order
  mark so Excel renders accented names correctly rather than as mojibake.
- **XLSX** for anything a person reads. It carries a summary sheet built from
  the very rows exported, and numbers are stored as numbers — a decimal comma
  that cannot be summed is a spreadsheet that lies quietly.

## What the pack must never contain

No secret, no token, no Stripe key, no bank detail, no KYC field, and no
customer telephone number. Not because they are filtered out — because no
dataset selects them. Columns are enumerated by hand precisely so that adding a
column to a table cannot silently start exporting it.
