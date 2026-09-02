# How Ontario's fifteen zone boundaries were produced

Ontario publishes the fifteen restricted towing zones as **written limits**
("Highway 401 from Highway 400 to Highway 404") and no geospatial layer. Phase 6
therefore carried Ontario as one row with no boundary. Phase 6.1 derived a
boundary for each zone from two official sources, and these scripts are that
derivation — kept in the repository because "documented method" should mean
runnable, not described.

## Sources

| | |
|---|---|
| Zone list, limits, contracted operator | [Tow Zone Program, Government of Ontario](https://www.ontario.ca/page/tow-zone-program) |
| Road centrelines | Ontario Road Network (ORN) Composite – Segment, [Ontario GeoHub](https://geohub.lio.gov.on.ca/) / MNRF, `services1.arcgis.com/TJH5KDher0W13Kgo/.../FeatureServer/5` |

## Running it

```bash
pip install shapely pyproj networkx
python scripts/geodata/fetch_orn.py        # caches the ORN extracts
python scripts/geodata/derive_on_zones.py  # writes on_zone_wkt.json + limits
python scripts/geodata/validate_zones.py   # 80 GPS checks
```

Output lands in `scripts/geodata/.geodata/` (override with
`TOWCONNECT_GEODATA_DIR`). Nothing writes to the database; loading the result is
a separate, deliberate step.

## The method, and why each part is there

1. Take ORN segments classed `Freeway` carrying the zone's route number.
   `ROUTE_NUMBER` can be a combined value like `QEW; 403`, so the number is
   matched as a whole token, not as a substring.
2. Merge **one carriageway** into continuous components and pick the component
   both official limits sit closest to. That component is the reference
   centreline, so distance along it is a real linear measure.
3. Locate each limit on it by nearest point and cut between the two.
4. Use a **200 m corridor around that cut only to select** the highway's real
   segments — the opposite carriageway, collector and express lanes.
5. Buffer those selected segments by **30 m** and union.

Steps 4 and 5 are the whole point. Buffering one centreline wide enough to
reach the far carriageway would also swallow the service roads and arterials
that run alongside a 400-series highway, and every one of those false positives
tells somebody standing on a side street that TowConnect cannot help them.

## Two earlier attempts that were wrong

Recorded because they are the reason the code looks like this, and because both
were caught by the same check — comparing the derived length against the real
distance between the official limits:

* **Longest merged component of both carriageways.** Four different zones
  collapsed onto the same 0.04 km² blob: ORN's dual carriageways do not
  `linemerge` into one line.
* **Routing a graph over both carriageways.** Highway 401 from Dixie Road to
  Islington Avenue — twelve kilometres apart — came out as a 36 km path that ran
  west to Milton and back, because the two carriageways only join at the ends of
  the extract, so the graph is a chain that doubles back on itself.

Three limits also needed care rather than a name match:

* `DIXIE ROAD` exists in Mississauga **and** Pickering, at opposite ends of the
  401, so limits are matched on (name, municipality).
* `Third Line` and `Fifty Road` on ontario.ca are `3RD LINE` (Town of Oakville)
  and `50 ROAD` (City of Hamilton) in ORN.
* Hurontario Street parallels Highway 410 for its whole length about 2 km away,
  so "nearest point on the 410 to Hurontario" is meaningless; the official limit
  is the freeway's northern terminus, which is the Caledon stretch.

## What the result claims

`geometry_confidence` is `derived_from_official_text`, never
`official_geospatial`. Ontario has not published these boundaries. This is a
reading of its written limits against its own centrelines, and the admin screen
shows that distinction on every row alongside a map of the polygon.

## Measured behaviour

| | |
|---|---|
| Points on the roadway, inside their zone | 15/15 zones, 100% of samples end to end |
| 20 m from a centreline | 99% inside |
| 80 m | 6% inside |
| 150 m and beyond | 0% inside |
| Non-freeway ORN segments sampled through the densest corridor | 19 of 2000 midpoints inside a zone (0.95%), most of them the highway's own collector lanes and ramps |
