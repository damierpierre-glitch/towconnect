# -*- coding: utf-8 -*-
"""Derive a geometry for each of Ontario's 15 restricted towing zones.

TWO OFFICIAL SOURCES, ONE DOCUMENTED METHOD
  1. The zone list, its official limits and its contracted operator:
     https://www.ontario.ca/page/tow-zone-program   (Government of Ontario)
  2. The road centrelines:
     Ontario Road Network (ORN) Composite - Segment, Ontario GeoHub / MNRF
     services1.arcgis.com/TJH5KDher0W13Kgo/.../FeatureServer/5

METHOD, per zone
  a. Take every ORN segment classed 'Freeway' whose ROUTE_NUMBER carries the
     zone's highway number. ROUTE_NUMBER can be a combined value such as
     'QEW; 403', so the number is matched as a whole token.
  b. Merge the segments of each carriageway separately into continuous
     components, and pick the component both official limits sit closest to.
     That component is the reference centreline: one ordered line along the
     corridor, so distance along it is a real linear measure.
  c. Locate each limit on it by nearest point, and cut the reference between
     the two locations.
  d. Use a 200 m corridor around that cut ONLY to select the highway's real
     segments - the opposite carriageway, collector and express lanes.
  e. Buffer those selected segments by 30 m and union.

Steps (d) and (e) are the point. Buffering one centreline wide enough to reach
the far carriageway would also swallow the service roads and arterials that run
alongside a 400-series highway, and every one of those false positives refuses
service to somebody legally entitled to it. Buffering each real carriageway
tightly keeps the footprint on the roadway and its shoulders, which is where a
breakdown actually happens.

TWO EARLIER ATTEMPTS AND WHY THEY FAILED, because the failures are the reason
this file looks the way it does:
  * "longest merged component of both carriageways" collapsed four different
    zones onto the same 0.04 km2 blob - ORN's dual carriageways do not merge
    into one line.
  * routing a graph over both carriageways sent Highway 401 from Dixie Road to
    Islington Avenue - twelve kilometres apart - along a 36 km path that ran
    west to Milton and back, because the two carriageways only join at the
    ends of the extract, so the graph is a chain that doubles back on itself.
Both were caught by comparing the derived length against the real distance
between the official limits, which is why that comparison is printed for every
zone below and repeated in the report.

All measurement is done in EPSG:32617 (UTM 17N); output is EPSG:4326.
"""
import io, json, os

import networkx as nx

from shapely.geometry import LineString, MultiPolygon, Point, shape
from shapely.ops import linemerge, nearest_points, substring, transform, unary_union
from pyproj import Transformer

# Working directory for the fetched ORN extracts and the derived output.
# Override with TOWCONNECT_GEODATA_DIR; defaults to .geodata beside this file.
SCR = os.environ.get("TOWCONNECT_GEODATA_DIR") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), ".geodata"
)
os.makedirs(SCR, exist_ok=True)

TO_M = Transformer.from_crs("EPSG:4326", "EPSG:32617", always_xy=True).transform
TO_DEG = Transformer.from_crs("EPSG:32617", "EPSG:4326", always_xy=True).transform

SELECT_CORRIDOR_M = 200.0
CARRIAGEWAY_BUFFER_M = 30.0
SIMPLIFY_M = 4.0
MIN_COMPONENT_M = 2000.0


def load(name):
    with io.open(os.path.join(SCR, name), encoding="utf-8") as fh:
        return json.load(fh)


def route_has(route_number, target):
    return bool(route_number) and target in [t.strip() for t in route_number.split(";")]


freeways = load("orn_freeways.json")["features"]
streets = load("orn_limit_streets.json")["features"]
# Highway 9 is not a freeway, so it is absent from the freeway extract; zone
# 3A's northern limit needs it, fetched separately by route number.
hwy9 = load("orn_hwy9.json")["features"]

HIGHWAYS = ("400", "401", "403", "404", "409", "410", "412", "427", "QEW", "6")
# Highway 403 and the QEW run concurrently between Burlington and Oakville, and
# ORN labels that stretch 'QEW; 403'. Against the full 403 geometry the limit
# "Highway 403 from QEW" is ambiguous: every concurrent segment is zero metres
# from the QEW. '403x' is the 403 without the concurrency, so the limit
# resolves to the actual divergence at Oakville.
EXCLUSIVE = {"403x": ("403", "QEW")}

hw_parts = {}       # every carriageway - the footprint is built from these
hw_by_dir = {}      # split by carriageway - reference lines are built from these
for f in freeways:
    props = f["properties"]
    geom = transform(TO_M, shape(f["geometry"]))
    lines = list(geom.geoms) if geom.geom_type == "MultiLineString" else [geom]
    direction = props.get("DIRECTION_OF_TRAFFIC_FLOW") or "Positive"
    rn = props.get("ROUTE_NUMBER")
    for target in HIGHWAYS:
        if route_has(rn, target):
            hw_parts.setdefault(target, []).extend(lines)
            hw_by_dir.setdefault((target, direction), []).extend(lines)
    for alias, (keep, drop) in EXCLUSIVE.items():
        if route_has(rn, keep) and not route_has(rn, drop):
            hw_parts.setdefault(alias, []).extend(lines)
            hw_by_dir.setdefault((alias, direction), []).extend(lines)

# Keyed by (name, municipality): several official limit names exist in more
# than one place in Ontario - "DIXIE ROAD" is in Mississauga AND in Pickering,
# at opposite ends of Highway 401 - so matching on the name alone would
# silently anchor a zone to the wrong end of the province.
street_parts = {}
for f in streets:
    props = f["properties"]
    key = ((props.get("FULL_STREET_NAME") or "").upper(), props.get("L_STANDARD_MUNICIPALITY") or "")
    street_parts.setdefault(key, []).append(transform(TO_M, shape(f["geometry"])))


HWY9 = unary_union([transform(TO_M, shape(f["geometry"]))
                    for f in hwy9
                    if (f["properties"].get("L_STANDARD_MUNICIPALITY") or "") == "Township of King"])


def street_geom(*keys):
    parts = []
    for name, muni in keys:
        parts.extend(street_parts.get((name.upper(), muni), []))
    if not parts:
        raise SystemExit("no ORN geometry for %s" % (keys,))
    return unary_union(parts)


def highway_geom(target):
    return unary_union(hw_parts[target])


GRAPHS = {}
PATHS = []

NODE_TOLERANCE_M = 12.0
# Express and collector carriageways meet at degree-3 nodes, which linemerge
# cannot pass through, so merged components come out short and truncated -
# Highway 401's reference line stopped 8 km before the Highway 412 limit. A
# graph does pass through them. Short bridges join the gaps ORN leaves at
# interchanges; at 90 m Highway 427 still came out in pieces and its southern
# end sat 7 km from the QEW limit. Every bridged pair carries the same route
# number, and - this is what makes a long bridge safe - the bridge is only ever
# used to route; the polygon is built by buffering the REAL segments the route
# passes near. A bridge across a gap with no road in it therefore contributes
# no area at all. Highway 427 needs one: ORN's 427 jumps 1.2 km sideways at the
# 409/401 interchange, which left the zone 4 km short.
BRIDGE_M = 1300.0


class NodeIndex:
    def __init__(self, tol):
        self.tol = tol
        self.cells = {}
        self.points = []

    def get(self, x, y):
        cx, cy = int(x // self.tol), int(y // self.tol)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for idx in self.cells.get((cx + dx, cy + dy), ()):
                    px, py = self.points[idx]
                    if (px - x) ** 2 + (py - y) ** 2 <= self.tol ** 2:
                        return idx
        idx = len(self.points)
        self.points.append((x, y))
        self.cells.setdefault((cx, cy), []).append(idx)
        return idx


def graph_for(target):
    """One carriageway of one highway as a routable graph.

    ONE carriageway, not both: with both, the two centrelines only join at the
    far ends of the extract, so the graph is a chain that doubles back and
    routing Dixie Road to Islington Avenue - twelve kilometres apart - came out
    as a 36 km path that ran west to Milton first.
    """
    if target in GRAPHS:
        return GRAPHS[target]

    parts = hw_by_dir.get((target, "Positive")) or hw_parts[target]
    index = NodeIndex(NODE_TOLERANCE_M)
    g = nx.Graph()
    for line in parts:
        if line.is_empty or line.length == 0:
            continue
        a = index.get(*line.coords[0])
        b = index.get(*line.coords[-1])
        if a == b:
            continue
        if g.has_edge(a, b) and g[a][b]["weight"] <= line.length:
            continue
        g.add_edge(a, b, weight=line.length, geom=line)

    # Bridge the short gaps ORN leaves between otherwise adjacent pieces.
    pts = index.points
    nodes = list(g.nodes)
    for i, u in enumerate(nodes):
        ux, uy = pts[u]
        for v in nodes[i + 1:]:
            if g.has_edge(u, v):
                continue
            vx, vy = pts[v]
            d2 = (ux - vx) ** 2 + (uy - vy) ** 2
            if d2 <= BRIDGE_M ** 2:
                d = d2 ** 0.5
                g.add_edge(u, v, weight=d, geom=LineString([(ux, uy), (vx, vy)]))

    g.graph["points"] = index.points
    GRAPHS[target] = g
    return g


def terminal_in(g, nodes, limit):
    """The node to route from/to for an official limit, within one component.

    Chosen from the closest EDGE, not the closest node: ORN nodes sit up to a
    couple of kilometres apart on a freeway, and picking the closest node put
    zone limits as much as 7 km off the official one.
    """
    best = None
    for u, v, data in g.edges(nodes, data=True):
        if u not in nodes or v not in nodes:
            continue
        d = data["geom"].distance(limit)
        if best is None or d < best[0]:
            best = (d, u, v, data["geom"])
    if best is None:
        return None
    d, u, v, geom = best
    pts = g.graph["points"]
    p = nearest_points(geom, limit)[0]
    end = u if Point(pts[u]).distance(p) <= Point(pts[v]).distance(p) else v
    return end, d, p


def derive(target, limit_a, limit_b):
    g = graph_for(target)
    # The component that fits BOTH limits, not the largest one. Highway 403's
    # largest exclusive component is the Hamilton-Brantford stretch, so the
    # largest-component rule put zone 2D's Highway 401 limit 20 km away; the
    # 427's southern end sits in a separate component from its middle, which
    # put zone 3C's QEW limit 7 km off.
    chosen = None
    for comp in nx.connected_components(g):
        if len(comp) < 2:
            continue
        ta = terminal_in(g, comp, limit_a)
        tb = terminal_in(g, comp, limit_b)
        if not ta or not tb or ta[0] is None or ta[0] == tb[0]:
            continue
        score = max(ta[1], tb[1])
        if chosen is None or score < chosen[0]:
            chosen = (score, comp, ta, tb)
    if chosen is None:
        raise SystemExit("%s: no component carries both limits" % target)
    _score, comp, (na, da, pa), (nb, db, pb) = chosen
    g = g.subgraph(comp)
    if na == nb:
        raise SystemExit("%s: both limits resolved to the same node" % target)
    nodes = nx.shortest_path(g, na, nb, weight="weight")
    path = unary_union([g[u][v]["geom"] for u, v in zip(nodes, nodes[1:])])

    corridor = path.buffer(SELECT_CORRIDOR_M)
    selected = []
    for seg in hw_parts[target]:
        if seg.intersects(corridor):
            clipped = seg.intersection(corridor)
            if not clipped.is_empty and clipped.geom_type in ("LineString", "MultiLineString"):
                selected.append(clipped)
    poly = unary_union([seg.buffer(CARRIAGEWAY_BUFFER_M) for seg in selected]).simplify(SIMPLIFY_M)

    PATHS.append(transform(TO_DEG, path))
    # Report the limits on the REAL road, not on a synthetic bridge edge: the
    # James Snow Parkway limit came out 48 m off the 401 because the closest
    # edge there was one of the bridges. The polygon was never affected - it is
    # built only from real segments - but a limit coordinate that is not on the
    # road is a misleading thing to publish.
    real = unary_union(hw_parts[target])
    pa_real = nearest_points(real, pa)[0]
    pb_real = nearest_points(real, pb)[0]
    return poly, {
        "cut_km": path.length / 1000.0,
        "snap_a_m": da,
        "snap_b_m": db,
        "a": transform(TO_DEG, pa_real),
        "b": transform(TO_DEG, pb_real),
    }


MM_404 = lambda: street_geom(("MAJOR MACKENZIE DRIVE EAST", "City of Richmond Hill"),
                             ("MAJOR MACKENZIE DRIVE EAST", "City of Markham"))
MM_427 = lambda: street_geom(("MAJOR MACKENZIE DRIVE WEST", "City of Vaughan"))
MORNINGSIDE = lambda: street_geom(("MORNINGSIDE AVENUE", "City of Toronto"))
DIXIE = lambda: street_geom(("DIXIE ROAD", "City of Mississauga"))
JAMES_SNOW = lambda: street_geom(("JAMES SNOW PARKWAY NORTH", "Town of Milton"),
                                 ("JAMES SNOW PARKWAY SOUTH", "Town of Milton"))
# Hurontario Street parallels Highway 410 for its whole length, roughly 2 km
# to the west, so the nearest point on the 410 to "Hurontario Street" is
# meaningless - it came out 2 km up a 20 km zone. The official limit is the
# 410's northern terminus, where the freeway ends and becomes Hurontario: the
# Caledon stretch, north of Brampton.
HURONTARIO = lambda: street_geom(("HURONTARIO STREET", "Town of Caledon"))
ISLINGTON = lambda: street_geom(("ISLINGTON AVENUE", "City of Toronto"))
THIRD_LINE = lambda: street_geom(("3RD LINE", "Town of Oakville"))
FIFTY_ROAD = lambda: street_geom(("50 ROAD", "City of Hamilton"))


def HW(n):
    return lambda: highway_geom(n)


# (code, highway, limit A, limit B, expected road distance in km between the
# official limits). The expectation is a sanity check on the derivation, never
# data: it is printed next to the derived length and flagged when they diverge.
ZONES = [
    ("1A", "401", HW("400"), HW("404"), 16),
    ("1B", "401", HW("404"), MORNINGSIDE, 12),
    ("1C", "404", HW("401"), MM_404, 13),
    ("1D", "401", MORNINGSIDE, HW("412"), 21),
    ("2A", "401", DIXIE, JAMES_SNOW, 22),
    ("2B", "401", JAMES_SNOW, HW("6"), 25),
    ("2C", "410", HW("401"), HURONTARIO, 20),
    ("2D", "403x", HW("QEW"), HW("401"), 20),
    ("3B", "401", DIXIE, ISLINGTON, 12),
    ("3D", "427", HW("409"), MM_427, 14),
    ("3A", "400", HW("401"), (lambda: HWY9), 40),
    ("4A", "QEW", HW("427"), THIRD_LINE, 26),
    ("4B", "QEW", THIRD_LINE, HW("6"), 14),
    ("4C", "QEW", HW("403"), FIFTY_ROAD, 30),
]

results, diag, LIMITS_OUT = {}, [], {}

PATH_BY_ZONE = {}
for code, hw, la, lb, expect in ZONES:
    poly, info = derive(hw, la(), lb())
    PATH_BY_ZONE[code] = PATHS[-1]
    results[code] = poly
    LIMITS_OUT[code] = {"A": [info["a"].x, info["a"].y], "B": [info["b"].x, info["b"].y]}
    diag.append((code, hw, info["cut_km"], expect, poly.area / 1e6,
                 info["snap_a_m"], info["snap_b_m"],
                 "A=%.4f,%.4f B=%.4f,%.4f" % (info["a"].x, info["a"].y, info["b"].x, info["b"].y)))

parts_3c = []
for hw, la, lb, expect in (("401", ISLINGTON, HW("400"), 3),
                           ("409", HW("427"), HW("401"), 4),
                           ("427", HW("409"), HW("QEW"), 11)):
    p, info = derive(hw, la(), lb())
    PATH_BY_ZONE.setdefault("3C", []).append(PATHS[-1]) if isinstance(PATH_BY_ZONE.get("3C"), list) else PATH_BY_ZONE.update({"3C": [PATHS[-1]]}) if "3C" not in PATH_BY_ZONE else PATH_BY_ZONE["3C"].append(PATHS[-1])
    parts_3c.append(p)
    diag.append(("3C:" + hw, hw, info["cut_km"], expect, p.area / 1e6,
                 info["snap_a_m"], info["snap_b_m"],
                 "A=%.4f,%.4f B=%.4f,%.4f" % (info["a"].x, info["a"].y, info["b"].x, info["b"].y)))
results["3C"] = unary_union(parts_3c).simplify(SIMPLIFY_M)

print("%-8s %-4s %8s %7s %9s %8s %8s  snapped limits" %
      ("zone", "hwy", "cut_km", "exp_km", "area_km2", "snapA_m", "snapB_m"))
for d in sorted(diag):
    flag = "" if abs(d[2] - d[3]) <= max(4.0, 0.35 * d[3]) else "   <-- CHECK"
    print("%-8s %-4s %8.2f %7d %9.2f %8.1f %8.1f  %s%s" % (d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[7], flag))

out = {}
for code, poly in results.items():
    ll = transform(TO_DEG, poly)
    if ll.geom_type == "Polygon":
        ll = MultiPolygon([ll])
    out[code] = ll.wkt
with io.open(os.path.join(SCR, "on_zone_wkt.json"), "w", encoding="utf-8") as fh:
    json.dump(out, fh)

limits = {}
for code, hw, la, lb, expect in ZONES:
    pass
with io.open(os.path.join(SCR, "on_zone_limits.json"), "w", encoding="utf-8") as fh:
    json.dump(LIMITS_OUT, fh)

paths = {}
for code, val in PATH_BY_ZONE.items():
    geoms = val if isinstance(val, list) else [val]
    paths[code] = unary_union(geoms).wkt
with io.open(os.path.join(SCR, "on_zone_paths.json"), "w", encoding="utf-8") as fh:
    json.dump(paths, fh)
print("\nzones derived: %d | largest WKT: %d chars" % (len(out), max(len(w) for w in out.values())))
