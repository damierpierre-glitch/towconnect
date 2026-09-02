# Regulated Operations

- **Owner:** Founder / Product (future: Compliance)
- **Status:** Active
- **Last reviewed:** 2026-09-02
- **Review cycle:** Quarterly
- **Related systems:** `regulated_towing_zones`, `driver_document_requirements`

## The position

TowConnect does not dispatch into a regulated zone unless it has a provider the
official source names as authorized. Where the source is unclear, **no provider
is invented**.

## Evidence requirements

Every zone carries a `source_url`, a `source_title` and an
`effective_from` date. A rule with no source is not a rule we are willing to
refuse somebody service over.

A zone cannot be activated without a verified geospatial boundary — enforced in
the admin screen and visible as `geometry_confidence`.

## Ontario

15 zones, active. The geometry was **derived** from two official sources with a
documented, committed, reproducible method (`app/scripts/geodata/`). Derivation
is stated as derivation, with its confidence recorded per zone.

## Québec

Recorded and **inactive**. No official geospatial boundary was found; three
sources are cited in the database. The province is treated as unregulated by
dispatch, which is the honest position — not an assumption that no rule exists.

## Driver documents

Ontario document requirements are seeded from an official source. **No
Québec requirement is invented**, and no province-agnostic "Canada" rule
exists. An Ontario driver without a certificate on file is blocked from
dispatch in the relevant zones.
