# ADR-0005 — Capability-based admin access

- **Status:** Accepted · **Date:** Phase 8, revised Phase 8.1 · **Owner:** Founder / Product

## Context

One `admin` role could do everything: set the commission, refund, pay out,
change regulated zones. Adding roles to the `user_role` enum would have touched
`handle_new_user()`, `roleHome()` and every policy keyed on role.

## Decision

Capabilities are rows in `admin_grants`, checked by `has_admin_capability()`,
named directly in the RLS policies that guard money and the regulatory layer.

Phase 8 shipped with a **grandfather rule** — an admin with no grant held
everything — so the change could not lock out existing operators. Phase 8.1
removed it, after granting `super_admin` explicitly to every administrator that
existed.

## Consequences

- An admin holds only what is granted; revoking the last capability revokes
  access.
- Narrowing somebody is a deliberate act, and the migration order (grant, then
  tighten) is load-bearing: reversed, it would lock everybody out.
- A platform with no `super_admin` cannot be administered — `ops_super_admin_count()`
  makes that checkable, and `verify:operations` checks it.
