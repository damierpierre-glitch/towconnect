# Pilot territory — Montréal & Rive-Sud

- **Owner:** Founder / Operations
- **Status:** Active
- **Last reviewed:** 2026-09-02
- **Review cycle:** Before the territory changes, and before the allowlist is switched off
- **Related systems:** `pilot_coverage_areas`, `pilot_point_coverage()`, `pilot_coverage_report()`, `regulated_towing_zones`

## Three different questions, three different answers

Keeping these apart is the whole point of this page.

| Question | Answered by | What it is |
| --- | --- | --- |
| Where do we **intend** to operate? | `pilot_coverage_areas` | A commercial declaration |
| Can somebody **actually** be rescued there? | `pilot_coverage_report()` | A count of partners that reach it |
| Is towing **allowed** there? | `regulated_towing_zones` | Law |

A declaration is not a capability, and neither is a permission. The report puts
the first two side by side precisely so they can be seen disagreeing — before a
customer discovers it.

## Coverage never overrides regulation

Being inside a declared coverage area grants nothing. A pickup point inside a
restricted zone is still stamped by the regulated-zone engine and still held or
redirected by its rules; coverage is evaluated separately and can only ever
remove options, never add them.

Reversing that would let a commercial decision quietly override a law. It is
the failure ADR-0001 exists to prevent, and `verify:phase10` asserts the order.

## The declared area today, and what is wrong with it

One area: **Montréal & Rive-Sud (approximation pilote)** — a 30 km circle
centred between downtown Montréal and Longueuil.

A circle is not "Montréal and the South Shore". It reaches into Laval and part
of the North Shore, which are **not** in the pilot, and it clips the eastern end
of the island, which **is**. It ships anyway because a coarse shape that is
labelled coarse is safer than no shape at all — the `note` on the row says so
in the same words, and it is the text an operator reads on the pilot screen.

The readiness item **`operations.coverage_polygon` is a launch blocker** until
it is replaced with real municipal boundaries from an official source, loaded
the way the Ontario zones were. Acceptable while the allowlist is on and every
request is watched; not acceptable once anybody can request.

## Three answers, not two

`pilot_point_coverage(lat, lng)` returns:

- **`served`** — inside a declared area.
- **`not_served`** — inside a declared exclusion, or outside every declared
  area when at least one exists.
- **`undeclared`** — no served area has been declared at all.

`undeclared` reads as "no restriction stated", exactly as an empty
`company_service_areas` list does. An empty configuration that read as a
refusal would take the platform offline the moment the table was created.

## Exclusions win

If a point falls inside both a `served` and a `not_served` area, it is not
served. Somebody deliberately carving a hole in the territory is making a
decision, and the decision is the hole.

## Changing the territory

1. Edit `pilot_coverage_areas` (operations capability). The `note` is mandatory
   and is shown to operators — write what the shape is and what it is not.
2. Re-read `pilot_coverage_report()`. A newly declared area with zero partners
   reaching it is a promise nothing can keep.
3. Update the public pages if the words change. `PILOT_STATEMENT` in
   `src/lib/content/publicPages.ts` is the single sentence every public page
   uses for coverage, and `verify:phase10` checks that no page invents another.
