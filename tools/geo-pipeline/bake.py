#!/usr/bin/env python3
"""
Postmark geo bake.

Turns raw public-domain geographic data into the compact textures and JSON the
game loads at runtime. Every output is equirectangular (plate carree):
  x: longitude -180 -> +180 (left to right), pixel centres
  y: latitude   +90 ->  -90 (top to bottom), pixel centres

Outputs (written to apps/web/public/geo/):
  height.png     4096x2048 RGB, Terrarium encoding, metres relative to sea level
                 elevation_m = (R*256 + G + B/256) - 32768
                 Land = ETOPO1-derived topography, ocean = bathymetry.
  surface.png    8192x4096 RGBA, anti-aliased coverage masks (0..255)
                 R = land, G = lake, B = river, A = ice (glaciers + ice shelves)
  aux.png        4096x2048 RGB
                 R = city lights (night side), G = desert, B = reserved (0)
  cities.json    ~2,000 populated places with real elevation sampled from the DEM
  landmarks.json curated landmarks with real coordinates and elevations
  meta.json      sizes, encodings, sources, licences, bake stats

Run:  python3 tools/geo-pipeline/bake.py --raw <dir with raw files>
See tools/geo-pipeline/README.md and docs/geodata.md.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy import ndimage

Image.MAX_IMAGE_PIXELS = None

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "apps" / "web" / "public" / "geo"
HERE = Path(__file__).resolve().parent

HEIGHT_W, HEIGHT_H = 4096, 2048
SURF_W, SURF_H = 8192, 4096
AUX_W, AUX_H = 4096, 2048
SUPERSAMPLE = 2


# --------------------------------------------------------------------------- DEM
def load_etopo_vtp(path: Path) -> np.ndarray:
    """ETOPO1-derived 10 arc-minute grid (pyvista vtk-data). Returns (1081, 2160)
    array, rows lat +90 -> -90, cols lon 0 -> 360 (exclusive)."""
    import vtk  # type: ignore
    from vtk.util.numpy_support import vtk_to_numpy  # type: ignore

    reader = vtk.vtkXMLPolyDataReader()
    reader.SetFileName(str(path))
    reader.Update()
    data = reader.GetOutput()
    alt = vtk_to_numpy(data.GetPointData().GetArray("altitude")).astype(np.float32)
    grid = alt.reshape(1081, 2161)[:, :2160]
    return grid


def load_dem(raw: Path) -> tuple[np.ndarray, str]:
    """Pick the best DEM available in the raw folder.

    Preferred (drop in manually, see docs/geodata.md): ETOPO 2022 GeoTIFF named
    etopo2022*.tif (global, equirectangular, lon -180..180, lat 90..-90).
    Fallback: ETOPO_10min_Ice.vtp (fetched automatically).
    """
    tifs = sorted(raw.glob("etopo2022*.tif"))
    if tifs:
        import tifffile  # type: ignore

        arr = tifffile.imread(str(tifs[0])).astype(np.float32)
        # Convert to the 0..360 column layout used below.
        h, w = arr.shape
        arr = np.roll(arr, w // 2, axis=1)
        return arr, f"ETOPO 2022 ({tifs[0].name})"
    vtp = raw / "ETOPO_10min_Ice.vtp"
    if not vtp.exists():
        sys.exit(f"No DEM found in {raw}. Run fetch_sources.sh first.")
    return load_etopo_vtp(vtp), "ETOPO1 Ice Surface, 10 arc-minute resample"


def resample_dem(src: np.ndarray, w: int, h: int) -> np.ndarray:
    """Bicubic resample of a (rows: lat 90..-90 inclusive, cols: lon 0..360)
    grid onto our pixel-centred equirectangular target."""
    rows, cols = src.shape
    pad = 4
    padded = np.concatenate([src[:, -pad:], src, src[:, :pad]], axis=1)
    padded = np.concatenate([np.repeat(padded[:1], pad, 0), padded, np.repeat(padded[-1:], pad, 0)], axis=0)

    lon = -180.0 + (np.arange(w) + 0.5) * 360.0 / w
    lat = 90.0 - (np.arange(h) + 0.5) * 180.0 / h
    lat_step = 180.0 / (rows - 1) if rows % 2 == 1 else 180.0 / rows
    lon_step = 360.0 / cols
    r = (90.0 - lat) / lat_step + pad
    c = (np.mod(lon, 360.0)) / lon_step + pad
    rr, cc = np.meshgrid(r, c, indexing="ij")
    out = ndimage.map_coordinates(padded, [rr, cc], order=3, mode="nearest")
    return out.astype(np.float32)


# ------------------------------------------------------------------- rasterising
def project(lon: np.ndarray, lat: np.ndarray, w: int, h: int):
    return (lon + 180.0) / 360.0 * w, (90.0 - lat) / 180.0 * h


def ring_variants(ring: list) -> list[list[tuple[float, float]]]:
    """Return the ring as drawable copies.

    - No jump across the antimeridian: draw as-is.
    - Encircles a pole (e.g. Antarctica, net 360 deg of longitude): draw as-is,
      Natural Earth already closes it along the map edge.
    - Crosses the antimeridian: unwrap, then draw at -360/0/+360 so both halves land.
    """
    pts = np.asarray(ring, dtype=np.float64)[:, :2]
    lon, lat = pts[:, 0], pts[:, 1]
    if len(lon) < 2:
        return []
    d = np.diff(lon)
    if not np.any(np.abs(d) > 180.0):
        return [list(zip(lon, lat))]
    unwrapped = lon[0] + np.concatenate([[0.0], np.cumsum(d - 360.0 * np.round(d / 360.0))])
    if abs(unwrapped[-1] - unwrapped[0]) > 180.0:
        return [list(zip(lon, lat))]
    return [list(zip(unwrapped + s, lat)) for s in (-360.0, 0.0, 360.0)]


def iter_polygons(geojson: dict):
    for f in geojson["features"]:
        g = f.get("geometry")
        if not g:
            continue
        if g["type"] == "Polygon":
            yield f, g["coordinates"]
        elif g["type"] == "MultiPolygon":
            for poly in g["coordinates"]:
                yield f, poly


def iter_lines(geojson: dict):
    for f in geojson["features"]:
        g = f.get("geometry")
        if not g:
            continue
        if g["type"] == "LineString":
            yield f, g["coordinates"]
        elif g["type"] == "MultiLineString":
            for line in g["coordinates"]:
                yield f, line


def to_xy(ring_ll, w, h):
    arr = np.asarray(ring_ll, dtype=np.float64)
    x, y = project(arr[:, 0], arr[:, 1], w, h)
    return list(zip(x.tolist(), y.tolist()))


def raster_polygons(files: list[Path], w: int, h: int, feature_filter=None) -> np.ndarray:
    """Anti-aliased polygon coverage, 0..1 float32 at (h, w)."""
    W, H = w * SUPERSAMPLE, h * SUPERSAMPLE
    img = Image.new("L", (W, H), 0)
    draw = ImageDraw.Draw(img)
    for path in files:
        gj = json.loads(path.read_text())
        for feat, poly in iter_polygons(gj):
            if feature_filter and not feature_filter(feat):
                continue
            for i, ring in enumerate(poly):
                for variant in ring_variants(ring):
                    if len(variant) < 3:
                        continue
                    draw.polygon(to_xy(variant, W, H), fill=255 if i == 0 else 0)
    img = img.resize((w, h), Image.BOX)
    return np.asarray(img, dtype=np.float32) / 255.0


def raster_lines(path: Path, w: int, h: int, width_fn) -> np.ndarray:
    W, H = w * SUPERSAMPLE, h * SUPERSAMPLE
    img = Image.new("L", (W, H), 0)
    draw = ImageDraw.Draw(img)
    gj = json.loads(path.read_text())
    for feat, line in iter_lines(gj):
        width = width_fn(feat) * SUPERSAMPLE
        if width <= 0:
            continue
        for variant in ring_variants(line):
            if len(variant) < 2:
                continue
            draw.line(to_xy(variant, W, H), fill=255, width=max(1, int(round(width))), joint="curve")
    img = img.resize((w, h), Image.BOX)
    return np.asarray(img, dtype=np.float32) / 255.0


def downsample(a: np.ndarray, w: int, h: int) -> np.ndarray:
    return np.asarray(Image.fromarray((a * 255).astype(np.uint8)).resize((w, h), Image.BOX), np.float32) / 255.0


# ------------------------------------------------------------------- height fix-up
def bilinear(E: np.ndarray, lat: float, lon: float) -> float:
    h, w = E.shape
    x = (lon + 180.0) / 360.0 * w - 0.5
    y = (90.0 - lat) / 180.0 * h - 0.5
    x0, y0 = math.floor(x), math.floor(y)
    fx, fy = x - x0, y - y0
    def at(xx, yy):
        return float(E[min(max(yy, 0), h - 1), xx % w])
    return (at(x0, y0) * (1 - fx) * (1 - fy) + at(x0 + 1, y0) * fx * (1 - fy)
            + at(x0, y0 + 1) * (1 - fx) * fy + at(x0 + 1, y0 + 1) * fx * fy)


def flatten_lakes(E: np.ndarray, lake: np.ndarray) -> int:
    """Give each lake a single flat water level: the median elevation of its shore."""
    mask = lake >= 0.5
    labels, n = ndimage.label(mask)
    slices = ndimage.find_objects(labels)
    for i, sl in enumerate(slices, start=1):
        if sl is None:
            continue
        y0, y1 = max(sl[0].start - 2, 0), min(sl[0].stop + 2, E.shape[0])
        x0, x1 = max(sl[1].start - 2, 0), min(sl[1].stop + 2, E.shape[1])
        comp = labels[y0:y1, x0:x1] == i
        ring = ndimage.binary_dilation(comp, iterations=2) & ~comp
        if not ring.any():
            continue
        level = float(np.median(E[y0:y1, x0:x1][ring]))
        sub = E[y0:y1, x0:x1]
        sub[comp] = level
    return n


def sharpen_peaks(E: np.ndarray, peaks: list[dict]) -> list[dict]:
    """The 10' DEM averages summits away. Restore real summit heights with a
    narrow Gaussian bump centred on each known peak."""
    h, w = E.shape
    report = []
    sigma = 1.3  # pixels (~13 km at the equator)
    rad = 6
    for p in peaks:
        x = (p["lon"] + 180.0) / 360.0 * w - 0.5
        y = (90.0 - p["lat"]) / 180.0 * h - 0.5
        cx, cy = int(round(x)), int(round(y))
        before = bilinear(E, p["lat"], p["lon"])
        if p["summitM"] - before <= 0:
            report.append({"id": p["id"], "before": round(before), "after": round(before)})
            continue
        # A few passes so the bilinear-sampled summit converges on the real height.
        for _ in range(4):
            delta = p["summitM"] - bilinear(E, p["lat"], p["lon"])
            if abs(delta) < 5:
                break
            for yy in range(cy - rad, cy + rad + 1):
                if not 0 <= yy < h:
                    continue
                for xx in range(cx - rad, cx + rad + 1):
                    d2 = (xx - x) ** 2 + (yy - y) ** 2
                    E[yy, xx % w] += delta * math.exp(-d2 / (2 * sigma * sigma))
        report.append({"id": p["id"], "before": round(before), "after": round(bilinear(E, p["lat"], p["lon"]))})
    return report


def encode_terrarium(E: np.ndarray) -> np.ndarray:
    v = np.clip(E, -32768.0, 32767.0) + 32768.0
    r = np.floor(v / 256.0)
    g = np.floor(v - r * 256.0)
    b = np.floor((v - np.floor(v)) * 256.0)
    return np.stack([r, g, b], axis=-1).astype(np.uint8)


def decode_terrarium(rgb: np.ndarray) -> np.ndarray:
    rgb = rgb.astype(np.float32)
    return rgb[..., 0] * 256.0 + rgb[..., 1] + rgb[..., 2] / 256.0 - 32768.0


# ------------------------------------------------------------------------- main
def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", type=Path, default=ROOT / "tools" / "geo-pipeline" / "raw")
    args = ap.parse_args()
    raw: Path = args.raw
    OUT.mkdir(parents=True, exist_ok=True)

    def ne(name: str) -> Path:
        p = raw / f"{name}.geojson"
        if not p.exists():
            sys.exit(f"Missing {p}. Run fetch_sources.sh first.")
        return p

    print("1/7 DEM")
    dem, dem_source = load_dem(raw)
    E = resample_dem(dem, HEIGHT_W, HEIGHT_H)

    print("2/7 land / lakes / ice at", SURF_W, "x", SURF_H)
    land = raster_polygons([ne("ne_10m_land"), ne("ne_10m_minor_islands")], SURF_W, SURF_H)
    lakes = raster_polygons([ne("ne_10m_lakes"), ne("ne_10m_lakes_europe"), ne("ne_10m_lakes_north_america")], SURF_W, SURF_H)
    ice = raster_polygons([ne("ne_10m_glaciated_areas"), ne("ne_10m_antarctic_ice_shelves_polys")], SURF_W, SURF_H)
    # Ice shelves float on the sea: they count as surface for the player.
    land = np.maximum(land, ice)

    print("3/7 rivers")
    def river_width(feat):
        props = feat.get("properties", {})
        if props.get("featurecla", "").lower().startswith("lake centerline"):
            return 0
        sr = props.get("scalerank", 6) or 6
        return max(0.6, 2.4 - 0.25 * float(sr))
    rivers = raster_lines(ne("ne_10m_rivers_lake_centerlines"), SURF_W, SURF_H, river_width)
    rivers = np.minimum(rivers, land)

    surface = np.stack([land, lakes, rivers, ice], axis=-1)
    Image.fromarray((surface * 255).round().astype(np.uint8), "RGBA").save(OUT / "surface.png", optimize=True)

    print("4/7 height consistency (coastlines, lakes, peaks)")
    land4 = downsample(land, HEIGHT_W, HEIGHT_H)
    lake4 = downsample(lakes, HEIGHT_W, HEIGHT_H)
    is_land = land4 >= 0.5
    E = np.where(is_land & (lake4 < 0.5), np.maximum(E, 1.0), E)
    E = np.where(~is_land, np.minimum(E, -2.0), E)
    n_lakes = flatten_lakes(E, lake4)

    src = json.loads((HERE / "landmarks.source.json").read_text())["landmarks"]
    peaks = [l for l in src if l.get("summitM")]
    peak_report = sharpen_peaks(E, peaks)

    # Whole metres: the source is accurate to ~10 m at best, and dropping the
    # sub-metre fraction (B channel = 0) roughly halves the PNG size.
    E = np.round(E)
    rgb = encode_terrarium(E)
    err = float(np.abs(decode_terrarium(rgb) - E).max())
    assert err < 0.01, f"terrarium round-trip error {err}"
    Image.fromarray(rgb, "RGB").save(OUT / "height.png", optimize=True)

    print("5/7 lights + desert")
    lights = raster_polygons([ne("ne_10m_urban_areas")], AUX_W, AUX_H)
    pts = Image.new("L", (AUX_W, AUX_H), 0)
    d = ImageDraw.Draw(pts)
    places = json.loads(ne("ne_10m_populated_places_simple").read_text())["features"]
    for f in places:
        p = f["properties"]
        pop = float(p.get("pop_max") or 0)
        if pop < 20000:
            continue
        x, y = project(np.array([p["longitude"]]), np.array([p["latitude"]]), AUX_W, AUX_H)
        r = 0.45 + 0.6 * math.log10(max(pop, 1) / 20000 + 1)
        v = int(min(255, 70 + 45 * math.log10(pop / 20000 + 1)))
        d.ellipse([x[0] - r, y[0] - r, x[0] + r, y[0] + r], fill=v)
    pts_a = np.asarray(pts, np.float32) / 255.0
    core = np.maximum(lights, pts_a)
    # Keep it sparse: a tight halo plus a faint wide one, so whole countries do not glow.
    glow = ndimage.gaussian_filter(core, 1.0) * 0.9 + ndimage.gaussian_filter(core, 4.0) * 0.25
    lights_f = np.clip(np.maximum(core * 0.85, glow), 0, 1)
    lights_f *= downsample(land, AUX_W, AUX_H) > 0.2
    desert = raster_polygons(
        [ne("ne_10m_geography_regions_polys")], AUX_W // 2, AUX_H // 2,
        feature_filter=lambda f: str(f["properties"].get("FEATURECLA", f["properties"].get("featurecla", ""))).lower() in ("desert", "erg"),
    )
    desert = ndimage.gaussian_filter(desert, 3.0)
    desert = np.asarray(Image.fromarray((desert * 255).astype(np.uint8)).resize((AUX_W, AUX_H), Image.BILINEAR), np.float32) / 255.0
    aux = np.stack([lights_f, desert, np.zeros_like(desert)], axis=-1)
    Image.fromarray((aux * 255).round().astype(np.uint8), "RGB").save(OUT / "aux.png", optimize=True)

    print("6/7 cities + landmarks")
    cities = []
    for f in places:
        p = f["properties"]
        pop = int(p.get("pop_max") or 0)
        fc = str(p.get("featurecla", ""))
        cities.append({
            "name": p.get("name"),
            "country": p.get("adm0name"),
            "lat": round(float(p["latitude"]), 4),
            "lon": round(float(p["longitude"]), 4),
            "pop": pop,
            "capital": "capital" in fc.lower() and "admin-0" in fc.lower(),
            "elevationM": round(bilinear(E, float(p["latitude"]), float(p["longitude"]))),
        })
    cities.sort(key=lambda c: (not c["capital"], -c["pop"]))
    cities = cities[:2000]
    (OUT / "cities.json").write_text(json.dumps({"cities": cities}, ensure_ascii=False, separators=(",", ":")))

    landmarks = []
    for l in src:
        base = bilinear(E, l["lat"], l["lon"])
        out = dict(l)
        out["groundElevationM"] = round(l["summitM"] if l.get("summitM") else max(base, 0.0))
        landmarks.append(out)
    (OUT / "landmarks.json").write_text(json.dumps({"landmarks": landmarks}, ensure_ascii=False, indent=1))

    print("7/7 meta")
    meta = {
        "bakedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "projection": "equirectangular; x: lon -180..180, y: lat 90..-90, pixel centres",
        "height": {"file": "height.png", "width": HEIGHT_W, "height": HEIGHT_H, "encoding": "terrarium",
                    "decode": "elevation_m = R*256 + G + B/256 - 32768", "verticalDatum": "mean sea level",
                    "minM": round(float(E.min())), "maxM": round(float(E.max())), "source": dem_source},
        "surface": {"file": "surface.png", "width": SURF_W, "height": SURF_H, "channels": {"r": "land", "g": "lake", "b": "river", "a": "ice"}},
        "aux": {"file": "aux.png", "width": AUX_W, "height": AUX_H, "channels": {"r": "cityLights", "g": "desert", "b": "reserved"}},
        "stats": {"lakes": n_lakes, "cities": len(cities), "landmarks": len(landmarks), "peaks": peak_report},
        "sources": [
            {"name": dem_source, "by": "NOAA NCEI (via pyvista/vtk-data)", "licence": "Public domain (US Government)"},
            {"name": "Natural Earth 1:10m vectors", "by": "naturalearthdata.com", "licence": "Public domain"},
        ],
    }
    (OUT / "meta.json").write_text(json.dumps(meta, indent=1))
    for f in sorted(OUT.iterdir()):
        print(f"   {f.name:16s} {f.stat().st_size / 1e6:6.2f} MB")
    print("done")


if __name__ == "__main__":
    main()
