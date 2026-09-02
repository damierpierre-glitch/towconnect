# ADR-0008 — A local pilot before any geographic expansion

- **Status:** Accepted
- **Date:** 2026-09-02
- **Owner:** Founder / Product
- **Related:** ADR-0002 (no invented geometries), `02-product/pilot-territory.md`

## Context

The product works everywhere the code runs. The temptation at this point is to
open the country, because nothing technical prevents it.

Two things do prevent it. Towing is regulated differently in every province and
by several municipalities within them, and the regulated-zone engine only
enforces rules that have been researched, sourced and given a verified
geometry — seventeen zones exist and fifteen are active. And a marketplace with
no supply in a city is not a marketplace in that city; it is a form that
disappoints people.

## Decision

The pilot is **Montréal and the South Shore**, and the platform says so
everywhere a person can read it: the landing page, the metadata, the local
pages, and a single shared sentence (`PILOT_STATEMENT`) that every public page
uses for coverage.

Expansion is a separate decision that requires, per territory: regulated zones
researched and sourced, partners onboarded and ready, and a coverage boundary
that is a real boundary.

## Consequences

- The declared coverage area gates request creation when the pilot mode is on,
  by a trigger on `requests`.
- A customer outside the territory is refused **with a sentence**, before their
  card is authorized, rather than left waiting for a driver who will never come.
- Marketing copy that implies national coverage is a bug, and `verify:phase10`
  fails on it.

## What was rejected

*Open everywhere, and let dispatch fail where there is nobody.* It produces the
worst possible first impression at exactly the moment somebody is stranded, and
it makes every acquisition number meaningless.
