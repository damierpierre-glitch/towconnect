# Regulated Zones

- **Owner:** Founder / Product (future: Compliance)
- **Status:** Active
- **Last reviewed:** 2026-09-02
- **Review cycle:** Quarterly, and whenever a source publishes an update
- **Related systems:** `regulated_towing_zones`, `regulated_zone_providers`

## The rule

On certain highways, only providers contracted by a public authority may tow. A
commercial preference cannot override this, and TowConnect will not dispatch
into a zone where it has no authorized provider.

## What is live

| Province | Zones | State |
| --- | --- | --- |
| Ontario | 15 | **Active**, geometry derived from two official sources |
| Québec | recorded | **Inactive** — no official geospatial boundary was found |

Québec appearing as inactive is a **known limitation, stated deliberately**. The
sources are recorded in the database so the gap is visible rather than
forgotten. Inventing an approximate boundary and treating it as law was
explicitly refused — see `10-decisions/ADR-0002-no-invented-geometries.md`.

## Dispatch states

- `not_applicable` — no active zone covers the pickup point
- `awaiting_external_authority` — the motorist is directed to the public
  authority; TowConnect does not dispatch
- `authorized_provider_search` — searching, restricted to authorized providers
- `restricted_capacity_wait` — authorized providers exist but none is free

## Freshness

Each zone carries `last_verified_at` and its source URL. **No staleness
threshold exists.** None has been agreed, and inventing one would create a
compliance rule by accident. The admin screen shows the date as a fact.
