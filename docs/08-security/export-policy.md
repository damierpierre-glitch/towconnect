# Export Policy

- **Owner:** Founder / Product (future: Security)
- **Status:** Active
- **Last reviewed:** 2026-09-02
- **Review cycle:** On any new dataset
- **Related systems:** `src/lib/exports/`, `export_audit`

## The invariant

**An export can never widen a role's visibility.** A file is always a subset of
what that person could already read on screen — never a way around the screen.

Three things make that structural:

1. Every dataset names the capabilities that may export it, checked **on the
   server** against the database's own answer, on every request.
2. The browser sends **filters** — never rows, never ids. A list of ids from a
   client is a request to trust the client about what it may read.
3. Columns are enumerated by hand. `select *` would silently start exporting
   whatever column somebody adds next.

## Who may export what

| Capability | Datasets |
| --- | --- |
| `operations` | requests, dispatch, drivers, companies, incidents, regulated zones, driver documents, reconciliation, KPIs |
| `finance` | payments, refunds, supplements, ledger, payouts, reconciliation, KPIs |
| `support` | a narrow requests view only |
| `super_admin` | all of the above |

## Never exported

Tokens, Stripe identifiers, webhook secrets, bank details, KYC data, document
storage paths, safety-link hashes, internal notes, risk flags. Not filtered
out — **never selected**.

## Nobody else exports anything

No customer, driver, dispatcher, or company owner/admin has an export function.

## Audit

Every export writes to `export_audit`: who, which capability authorized it,
dataset, format, filters, row count, timestamp. The capability recorded is the
one that **granted** the export, not the strongest one the person holds.

**The file itself is never stored.** A log holding copies of exports would be a
second, unguarded copy of the data it exists to police.

## Format

CSV is UTF-8 **with a byte-order mark** — without it Excel on Windows renders
every French accent as mojibake. Money is a plain number with a dot so it can
be summed; dates are ISO-shaped so they sort. XLSX files are real workbooks,
with a `Résumé` sheet derived from the very rows in `Données`.
