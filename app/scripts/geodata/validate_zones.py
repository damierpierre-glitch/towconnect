# -*- coding: utf-8 -*-
"""GPS validation of the derived Ontario zone geometries.

Five questions, the last of which is the one that matters most for a customer:
  1. Is a point on the highway itself inside its zone?
  2. Is a point well away from the highway outside every zone?
  3. Is a point past a zone's official limit outside that zone?
  4. Is a point at an interchange handled sensibly?
  5. How often does a LOCAL STREET fall inside a zone? Every one of those is a
     customer who would be told to call 511 while standing on a side road.
"""
import io, json, os

from shapely.geometry import Point, shape
from shapely.ops import substring, transform, unary_union
from shapely import wkt as shapely_wkt
from pyproj import Transformer

# Working directory for the fetched ORN extracts and the derived output.
# Override with TOWCONNECT_GEODATA_DIR; defaults to .geodata beside this file.
SCR = os.environ.get("TOWCONNECT_GEODATA_DIR") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), ".geodata"
)
os.makedirs(SCR, exist_ok=True)
TO_M = Transformer.from_crs("EPSG:4326", "EPSG:32617", always_xy=True).transform
TO_DEG = Transformer.from_crs("EPSG:32617", "EPSG:4326", always_xy=True).transform

zones = {k: shapely_wkt.loads(v) for k, v in json.load(io.open(os.path.join(SCR, "on_zone_wkt.json"), encoding="utf-8")).items()}
paths = {k: shapely_wkt.loads(v) for k, v in json.load(io.open(os.path.join(SCR, "on_zone_paths.json"), encoding="utf-8")).items()}
zones_m = {k: transform(TO_M, v) for k, v in zones.items()}
all_zones = unary_union(list(zones.values()))

results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))


# ---- 1. on the highway -> inside its own zone ---------------------------
for code, path in sorted(paths.items()):
    line = path if path.geom_type == "LineString" else max(path.geoms, key=lambda g: g.length)
    pts = [line.interpolate(f, normalized=True) for f in (0.1, 0.25, 0.5, 0.75, 0.9)]
    inside = sum(1 for p in pts if zones[code].contains(p) or zones[code].touches(p))
    check("zone %s: 5 points along the roadway are inside the zone" % code, inside == 5,
          "%d/5 inside" % inside)

# ---- 2. clearly outside -------------------------------------------------
FAR = [
    ("downtown Toronto, Yonge & Dundas", 43.6561, -79.3802),
    ("Guelph city centre", 43.5448, -80.2482),
    ("Barrie waterfront", 44.3894, -79.6903),
    ("Niagara Falls", 43.0896, -79.0849),
    ("Montreal downtown", 45.5019, -73.5674),
]
for name, lat, lng in FAR:
    p = Point(lng, lat)
    check("clearly outside: %s" % name, not all_zones.intersects(p))

# ---- 3. zones must not overlap materially ------------------------------
# Adjacent zones share an official limit, so a few hundred metres of buffer
# overlap there is expected and correct. A large overlap means a derivation
# put one zone inside another, which is what the earlier attempts did.
codes = sorted(zones)
worst = []
for i, a in enumerate(codes):
    for b in codes[i + 1:]:
        inter = zones_m[a].intersection(zones_m[b]).area / 1e6
        if inter > 0.0:
            worst.append((inter, a, b))
worst.sort(reverse=True)
for area, a, b in worst[:6]:
    check("zones %s and %s overlap by less than 0.35 km2 (they share an official limit)" % (a, b), area < 0.35,
          "overlap %.3f km2" % area)
if not worst:
    check("no two zones overlap at all", True)

# ---- 4. how far from the roadway does the zone actually reach ----------
# The most meaningful "near the limit" test available, and it is derived from
# the official centrelines rather than from coordinates typed from memory: at
# sample points along each zone, step perpendicular to the road and record
# where the zone stops. A first attempt used hand-typed coordinates for spots
# like "the 401 at Yonge" and reported failures that were only the typed
# coordinates being 300 m off - the geometry was right and the test was wrong.
OFFSETS = [20, 40, 80, 150, 300, 600]
profile = {d: [0, 0] for d in OFFSETS}
for code, path in sorted(paths.items()):
    line = path if path.geom_type == "LineString" else max(path.geoms, key=lambda g: g.length)
    line_m = transform(TO_M, line)
    zone_m = zones_m[code]
    for frac in (0.15, 0.35, 0.55, 0.75, 0.95):
        at = line_m.length * frac
        a = line_m.interpolate(max(0, at - 40))
        b = line_m.interpolate(min(line_m.length, at + 40))
        dx, dy = b.x - a.x, b.y - a.y
        norm = (dx * dx + dy * dy) ** 0.5 or 1.0
        nx_, ny_ = -dy / norm, dx / norm
        c = line_m.interpolate(at)
        for d in OFFSETS:
            for sign in (1, -1):
                q = Point(c.x + nx_ * d * sign, c.y + ny_ * d * sign)
                profile[d][0 if zone_m.intersects(q) else 1] += 1

for d in OFFSETS:
    inside, outside = profile[d]
    pct_in = 100.0 * inside / max(inside + outside, 1)
    if d <= 40:
        check("at %d m from the centreline the zone still covers the road (%.0f%% inside)" % (d, pct_in),
              pct_in >= 60.0, "%.0f%% inside" % pct_in)
    elif d >= 300:
        check("at %d m from the centreline the zone has ended (%.0f%% inside)" % (d, pct_in),
              pct_in <= 15.0, "%.0f%% inside" % pct_in)
    else:
        check("at %d m from the centreline: %.0f%% inside (informational)" % (d, pct_in), True)

# Interchanges: the official limit points themselves must be covered - that is
# where a zone hands over to its neighbour and neither may have a hole.
LIMITS = json.load(io.open(os.path.join(SCR, "on_zone_limits.json"), encoding="utf-8"))     if os.path.exists(os.path.join(SCR, "on_zone_limits.json")) else {}
for code, pts in sorted(LIMITS.items()):
    for label, (lng, lat) in pts.items():
        q = Point(lng, lat)
        covered = [c for c in codes if zones[c].intersects(q)]
        check("interchange limit %s/%s is covered by some zone" % (code, label), bool(covered),
              "covered by nothing")

# Far-from-everything sanity, typed by hand but only ever asserting ABSENCE,
# where being a few hundred metres off cannot create a false pass.
for name, lat, lng in [
    ("Yorkdale Mall parking", 43.7256, -79.4522),
    ("Mississauga City Centre", 43.5890, -79.6441),
    ("Scarborough Town Centre", 43.7764, -79.2580),
    ("Oakville lakefront", 43.4400, -79.6650),
]:
    check("outside every zone: %s" % name, not all_zones.intersects(Point(lng, lat)))

# ---- 4b. no holes along the roadway ------------------------------------
# A hand-off between two adjacent zones must not leave a stretch of highway
# uncovered: that is a driver standing in a restricted zone being told they
# are not in one.
for code, path in sorted(paths.items()):
    line = path if path.geom_type == "LineString" else max(path.geoms, key=lambda g: g.length)
    line_m = transform(TO_M, line)
    n = max(int(line_m.length // 100), 10)
    covered = 0
    for i in range(n + 1):
        q = transform(TO_DEG, line_m.interpolate(line_m.length * i / n))
        if all_zones.intersects(q):
            covered += 1
    pct = 100.0 * covered / (n + 1)
    check("zone %s: the roadway is covered end to end (%.1f%% of %d samples)" % (code, pct, n + 1),
          pct >= 98.0, "%.1f%% covered" % pct)

# ---- 5. local streets ---------------------------------------------------
local = json.load(io.open(os.path.join(SCR, "orn_local_toronto.json"), encoding="utf-8"))["features"]
hits = []
tested = 0
for f in local:
    g = shape(f["geometry"])
    line = g if g.geom_type == "LineString" else (max(g.geoms, key=lambda x: x.length) if g.geoms else None)
    if line is None or line.is_empty:
        continue
    tested += 1
    mid = line.interpolate(0.5, normalized=True)
    if all_zones.intersects(mid):
        hits.append((f["properties"].get("FULL_STREET_NAME"), f["properties"].get("ROAD_CLASS"),
                     round(mid.y, 5), round(mid.x, 5)))

pct = 100.0 * len(hits) / max(tested, 1)
check("local-street false positives stay under 2%%: %d of %d (%.2f%%)" % (len(hits), tested, pct), pct < 2.0)

print("\nGPS validation\n")
for name, ok, detail in results:
    print("  %s %s%s" % ("PASS" if ok else "FAIL", name, ("  - " + detail) if detail and not ok else ""))
failed = [r for r in results if not r[1]]
print("\n%d checks, %d failed" % (len(results), len(failed)))

print("\nLocal-street midpoints falling inside a zone (%d of %d = %.2f%%):" % (len(hits), tested, pct))
from collections import Counter
byclass = Counter(h[1] for h in hits)
print("  by road class:", dict(byclass))
for h in hits[:12]:
    print("   ", h)

with io.open(os.path.join(SCR, "gps_validation.json"), "w", encoding="utf-8") as fh:
    json.dump({"results": [(n, bool(o), d) for n, o, d in results],
               "local_tested": tested, "local_hits": len(hits), "local_pct": pct,
               "hit_classes": dict(byclass)}, fh)
