# Admin Access Policy

- **Owner:** Founder / Product (future: Security)
- **Status:** Active
- **Last reviewed:** 2026-09-02
- **Review cycle:** Quarterly, and on any capability change
- **Related systems:** `admin_grants`, `has_admin_capability()`

## The model

Capabilities are **data**, not a role enum: adding `operations` to `user_role`
would have touched `handle_new_user()`, `roleHome()` and every policy keyed on
role, for roles nobody held.

| Capability | May | May not |
| --- | --- | --- |
| `super_admin` | everything, including granting capabilities | — |
| `operations` | dispatch, drivers, documents, regulated zones, incidents, risk flags | activate a commission, refund, pay out |
| `finance` | refunds, payouts, economic configuration, reconciliation | modify a regulated zone, open an incident, read the operational queue |
| `support` | lookup, timeline, read incidents, live map | refund, pay out, resolve an incident, read risk flags |

## No capability means no capability

An administrator holds **only** what is granted. Revoking their last capability
revokes their access.

This was not always true. Phase 8 shipped the roles with a grandfather rule —
an admin holding no grant held everything — so that introducing them could not
lock out the people running the platform. Phase 8.1 removed it, after granting
`super_admin` explicitly to every administrator that existed. See
`10-decisions/ADR-0005-capability-based-admin-access.md`.

## Keep one super admin

`ops_super_admin_count()` answers "can anybody still grant capabilities?".
Zero is recoverable only with the service role. `verify:operations` checks it.

## Enforcement

Every refusal is in the database: RLS policies on `pricing_configs`, `refunds`,
`provider_payouts`, `regulated_towing_zones` and `regulated_zone_providers`
name their capability, and the `SECURITY DEFINER` operational functions check
theirs null-safely. The UI hides what somebody cannot do; hiding is not a
control.
