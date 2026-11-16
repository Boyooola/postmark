"""Bake the "where am I" lookup: which country or sea is under each point.

Inputs (from fetch_sources.sh, in --raw)
  ne_10m_admin_0_countries.geojson, ne_10m_geography_marine_polys.geojson

Outputs (apps/web/public/geo/)
  places.png   4096x2048 RGB, nearest-neighbour IDs (equirectangular, v = 0 at the top):
               v = R*65536 + G*256 + B; country = v >> 9, sea = v & 511 (index + 1, 0 = none).
               RGB only: browsers premultiply alpha when reading canvas pixels.
  places.json  {"countries": [names...], "seas": [names...]}

Larger shapes are drawn first, so enclaves (Lesotho, San Marino) and small seas
inside oceans win. Run: python3 tools/geo-pipeline/bake_places.py --raw <dir>
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from bake import OUT

W, H = 4096, 2048

# Shorter everyday names for the HUD.
COUNTRY_NAMES = {
    "United States of America": "United States",
    "Dem. Rep. Congo": "DR Congo",
    "Central African Rep.": "Central African Republic",
    "Bosnia and Herz.": "Bosnia and Herzegovina",
    "Dominican Rep.": "Dominican Republic",
    "Eq. Guinea": "Equatorial Guinea",
    "S. Sudan": "South Sudan",
    "Solomon Is.": "Solomon Islands",
    "Falkland Is.": "Falkland Islands",
    "Fr. S. Antarctic Lands": "French Southern Lands",
    "N. Cyprus": "Northern Cyprus",
    "W. Sahara": "Western Sahara",
    "eSwatini": "Eswatini",
    "Côte d'Ivoire": "Côte d'Ivoire",
}


def rings(geom):
    t, c = geom["type"], geom["coordinates"]
    polys = [c] if t == "Polygon" else c if t == "MultiPolygon" else []
    for poly in polys:
        yield poly[0], poly[1:]


def ring_area(r) -> float:
    a = np.asarray(r, np.float64)
    x, y = a[:, 0], a[:, 1]
    return 0.5 * abs(float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))))


def to_px(r):
    return [((lon + 180.0) / 360.0 * W, (90.0 - lat) / 180.0 * H) for lon, lat, *_ in r]


def rasterize(features, name_of) -> tuple[np.ndarray, list[str]]:
    """features -> (uint16 id image, names). Draw big shapes first."""
    items = []
    for f in features:
        name = name_of(f["properties"])
        if not name or not f.get("geometry"):
            continue
        area = sum(ring_area(outer) for outer, _ in rings(f["geometry"]))
        items.append((area, name, f["geometry"]))
    items.sort(key=lambda t: -t[0])
    names: list[str] = []
    index: dict[str, int] = {}
    hi = Image.new("L", (W, H))
    lo = Image.new("L", (W, H))
    dh, dl = ImageDraw.Draw(hi), ImageDraw.Draw(lo)
    for _, name, geom in items:
        if name not in index:
            index[name] = len(names)
            names.append(name)
        v = index[name] + 1
        for outer, holes in rings(geom):
            pts = to_px(outer)
            if len(pts) < 3:
                continue
            dh.polygon(pts, fill=v >> 8)
            dl.polygon(pts, fill=v & 255)
            # Holes are left to smaller shapes drawn later (enclaves, inland seas).
    ids = (np.asarray(hi, np.uint16) << 8) | np.asarray(lo, np.uint16)
    return ids, names


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", type=Path, required=True)
    args = ap.parse_args()
    countries = json.loads((args.raw / "ne_10m_admin_0_countries.geojson").read_text())["features"]
    seas = json.loads((args.raw / "ne_10m_geography_marine_polys.geojson").read_text())["features"]

    def country_name(p):
        n = p.get("NAME") or p.get("ADMIN")
        return COUNTRY_NAMES.get(n, n)

    def sea_name(p):
        if p.get("featurecla") in ("river", "reef"):
            return None
        n = p.get("name_en") or p.get("name")
        return n.strip() if n else None

    cid, cnames = rasterize(countries, country_name)
    sid, snames = rasterize(seas, sea_name)
    assert len(cnames) < 512 and len(snames) < 512
    v = (cid.astype(np.uint32) << 9) | sid.astype(np.uint32)
    rgb = np.stack([v >> 16, (v >> 8) & 255, v & 255], axis=-1).astype(np.uint8)
    Image.fromarray(rgb, "RGB").save(OUT / "places.png", optimize=True)
    (OUT / "places.json").write_text(json.dumps({"countries": cnames, "seas": snames}, ensure_ascii=False))
    print(f"places.png: {len(cnames)} countries, {len(snames)} seas, {(OUT / 'places.png').stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
