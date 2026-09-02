# ADR-0010 — The pilot is a database switch, not a deploy

- **Status:** Accepted
- **Date:** 2026-09-02
- **Owner:** Founder / Operations
- **Related:** `09-sops/pilot-launch-runbook.md`, `pilot_config`, `guard_pilot_gate()`

## Context

A pilot needs to be closable in seconds — by whoever is watching, at 2am, from
a phone, without an engineer and without a deployment. It also needs to be
closable *safely*: closing intake must not abandon somebody already waiting at
the roadside.

## Decision

One row in `pilot_config` with three modes — `off`, `pilot`, `paused` — plus an
optional allowlist, optional hours, and the declared territory. Enforcement is
a `BEFORE INSERT` trigger on `requests`, so a code path that forgets to check
cannot walk around it. A server action asks the same function first, so the
customer gets a sentence rather than a database error.

`off` is the default. A migration that silently starts refusing requests is a
migration that takes a platform down at three in the morning.

## Consequences

- Pausing affects **intake only**. Jobs already running are untouched: the
  driver keeps driving, the chat keeps working, the payment still captures.
- A pause requires a written reason, enforced by a CHECK constraint, and that
  reason is what the customer reads. It has to be written for them.
- A forgotten pause is itself an alert, because a pause nobody lifts is an
  outage nobody reported.
- Hours and minimum partners are null by default, meaning "no restriction
  stated" — never "closed".

## What was rejected

*A full feature-flag platform.* One product, one flag that matters, one
audience. A flag service would be more machinery than the thing it controls.

*An environment variable.* Changing it requires a deploy, which is the one
thing this decision exists to avoid.
