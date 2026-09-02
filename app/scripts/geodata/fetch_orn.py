# -*- coding: utf-8 -*-
"""Pull the official Ontario Road Network segments needed to derive the 15
restricted tow zone geometries.

Source: Ontario GeoHub / MNRF, "Ontario Road Network (ORN) Composite - Segment"
        services1.arcgis.com/TJH5KDher0W13Kgo/.../FeatureServer/5
Everything is fetched as GeoJSON in EPSG:4326 and cached on disk so the
derivation itself is reproducible without re-hitting the service.
"""
import io, json, os, time, urllib.parse, urllib.request

# Working directory for the fetched ORN extracts and the derived output.
# Override with TOWCONNECT_GEODATA_DIR; defaults to .geodata beside this file.
SCR = os.environ.get("TOWCONNECT_GEODATA_DIR") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), ".geodata"
)
os.makedirs(SCR, exist_ok=True)
BASE = (
    "https://services1.arcgis.com/TJH5KDher0W13Kgo/arcgis/rest/services/"
    "Ontario_Road_Network_Composite_Service_GeoHub_View_EN/FeatureServer/5/query"
)
# Greater Toronto and Hamilton Area, generously.
BBOX = "-80.6,42.9,-78.7,44.6"


def fetch(where, out_name, out_fields="ROUTE_NUMBER,FULL_STREET_NAME,ROAD_CLASS,JURISDICTION,DIRECTION_OF_TRAFFIC_FLOW,L_STANDARD_MUNICIPALITY"):
    path = os.path.join(SCR, out_name)
    if os.path.exists(path):
        with io.open(path, encoding="utf-8") as fh:
            return json.load(fh)

    features = []
    offset = 0
    while True:
        params = {
            "where": where,
            "outFields": out_fields,
            "geometry": BBOX,
            "geometryType": "esriGeometryEnvelope",
            "inSR": "4326",
            "outSR": "4326",
            "spatialRel": "esriSpatialRelIntersects",
            "returnGeometry": "true",
            "f": "geojson",
            "resultOffset": str(offset),
            "resultRecordCount": "2000",
        }
        url = BASE + "?" + urllib.parse.urlencode(params)
        with urllib.request.urlopen(url, timeout=120) as r:
            payload = json.loads(r.read().decode("utf-8"))
        if "error" in payload:
            raise SystemExit("ArcGIS error: %s" % payload["error"])
        batch = payload.get("features", [])
        features.extend(batch)
        if len(batch) < 2000 or not payload.get("properties", {}).get("exceededTransferLimit", len(batch) == 2000):
            if len(batch) < 2000:
                break
        offset += len(batch)
        time.sleep(0.2)
        if offset > 60000:
            break

    fc = {"type": "FeatureCollection", "features": features}
    with io.open(path, "w", encoding="utf-8") as fh:
        json.dump(fc, fh)
    return fc


HIGHWAYS = ["400", "401", "403", "404", "409", "410", "412", "427", "QEW", "6"]

# ROUTE_NUMBER can be a combined value like '403; 410' or 'QEW; 403', so match
# the number as a whole token rather than with a bare equality.
clauses = []
for h in HIGHWAYS:
    clauses.append(
        "ROUTE_NUMBER = '{h}' OR ROUTE_NUMBER LIKE '{h}; %' OR ROUTE_NUMBER LIKE '%; {h}' "
        "OR ROUTE_NUMBER LIKE '%; {h}; %'".format(h=h)
    )
where_hw = "ROAD_CLASS = 'Freeway' AND (" + " OR ".join(clauses) + ")"

hw = fetch(where_hw, "orn_freeways.json")
print("freeway segments:", len(hw["features"]))

# The named cross-roads the official zone table uses as limits.
# ontario.ca writes "Third Line" and "Fifty Road"; the ORN records the same
# two roads as "3RD LINE" (Town of Oakville) and "50 ROAD" (City of Hamilton).
# Verified by querying the municipality alongside the name — see the report.
LIMIT_STREETS = [
    "Morningside Avenue",
    "Dixie Road",
    "James Snow Parkway",
    "Hurontario Street",
    "3RD LINE",
    "50 ROAD",
    "Major Mackenzie Drive",
    "Islington Avenue",
]
name_clauses = " OR ".join(
    "FULL_STREET_NAME LIKE '%{}%'".format(s.replace("'", "''")) for s in LIMIT_STREETS
)
streets = fetch("(" + name_clauses + ")", "orn_limit_streets.json")
print("limit-street segments:", len(streets["features"]))

names = {}
for f in streets["features"]:
    n = f["properties"].get("FULL_STREET_NAME")
    names[n] = names.get(n, 0) + 1
for n, c in sorted(names.items(), key=lambda kv: -kv[1])[:25]:
    print("   %-45s %d" % (n, c))
