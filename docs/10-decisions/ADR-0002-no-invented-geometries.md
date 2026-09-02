# ADR-0002 — No invented regulated geometries

- **Status:** Accepted · **Date:** Phase 6.1 · **Owner:** Founder / Product

## Context

Neither Québec nor Ontario publishes a ready geospatial boundary for towing
zones. Approximating them would have let every zone go live immediately.

## Decision

A zone may only be activated with a boundary derived from official sources by a
documented, reproducible method, with its confidence recorded. Where no source
supports a boundary, the zone stays **inactive** and the gap is visible.

## Consequences

- Ontario: 15 zones live, geometry derived from two official sources, method
  committed in `app/scripts/geodata/`.
- Québec: recorded, inactive, three sources cited. Dispatch treats the province
  as unregulated — the honest position.
- The product carries a known limitation instead of a plausible-looking fiction.
