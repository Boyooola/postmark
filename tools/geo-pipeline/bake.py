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
                 Land = topography, ocean = bathymetry. Global base, always loaded.
  tiles/6/X_Y.webp 256x256 Terrarium tiles (lossless WebP) of the 16384x8192 working grid
                 (~2.4 km per pixel), streamed around the plane. Only tiles that
                 touch land are written; open ocean uses the base map.
  tiles.json     tile manifest
  surface.png    8192x4096 RGBA, anti-aliased coverage masks (0..255)
                 R = land, G = lake, B = river, A = ice (glaciers + ice shelves)
  coast.png      8192x4096 L, signed distance to the sea coast:
                 value = 128 + km / 0.5 (clamped), > 128 at sea, < 128 on land.
                 Drives surf lines, shallow-water tint and beaches.
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
WORK_W, WORK_H = 16384, 8192   # detail grid = tile level 6 (64 x 32 tiles of 256 px)
TILE = 256
TILE_LEVEL = 6
SURF_W, SURF_H = 8192, 4096
AUX_W, AUX_H = 4096, 2048
SUPERSAMPLE = 2


# --------------------------------------------------------------------------- DEM
class Grid:
    """A global lat/lon grid. Row i is latitude lat_first - i*dlat, column j is
    longitude lon_first + j*dlon (columns cover 360 degrees and wrap)."""

    def __init__(self, data: np.ndarray, lat_first: float, lon_first: float, dlat: float, dlon: float, name: str, res_km: float):
        self.data, self.lat_first, self.lon_first, self.dlat, self.dlon = data, lat_first, lon_first, dlat, dlon
        self.name, self.res_km = name, res_km


def load_etopo_vtp(path: Path) -> Grid:
    """ETOPO1-derived 10 arc-minute grid (pyvista vtk-data), grid-registered."""
    import vtk  # type: ignore
    from vtk.util.numpy_support import vtk_to_numpy  # type: ignore

    reader = vtk.vtkXMLPolyDataReader()
    reader.SetFileName(str(path))
    reader.Update()
    alt = vtk_to_numpy(reader.GetOutput().GetPointData().GetArray("altitude")).astype(np.float32)
    data = alt.reshape(1081, 2161)[:, :2160]
    return Grid(data, 90.0, 0.0, 1 / 6, 1 / 6, "ETOPO1 Ice Surface, 10 arc-minute resample", 18.5)


def load_etopo2022_tif(path: Path) -> Grid:
    """ETOPO 2022 global GeoTIFF (pixel-is-area, top-left corner at -180, 90)."""
    import tifffile  # type: ignore

    with tifffile.TiffFile(str(path)) as t:
        page = t.pages[0]
        sx = float(page.tags["ModelPixelScaleTag"].value[0])
        tie = page.tags["ModelTiepointTag"].value
        data = page.asarray().astype(np.float32)
    lon_left, lat_top = float(tie[3]), float(tie[4])
    nodata = data < -20000
    if nodata.any():
        data[nodata] = 0.0
    res_km = 40075.0 * sx / 360.0
    name = f"ETOPO 2022 Ice Surface, {round(sx * 3600)} arc-second ({path.name})"
    return Grid(data, lat_top - sx / 2, lon_left + sx / 2, sx, sx, name, res_km)


def load_dem(raw: Path) -> Grid:
    """Best DEM available: an ETOPO 2022 GeoTIFF (ETOPO_2022*.tif or etopo2022*.tif,
    downloaded manually, see docs/geodata.md), else the 10' ETOPO1 grid."""
    tifs = sorted(list(raw.glob("ETOPO_2022*surface*.tif")) + list(raw.glob("etopo2022*.tif")))
    if tifs:
        return load_etopo2022_tif(tifs[0])
    vtp = raw / "ETOPO_10min_Ice.vtp"
    if not vtp.exists():
        sys.exit(f"No DEM found in {raw}. Run fetch_sources.sh first.")
    return load_etopo_vtp(vtp)


def resample(g: Grid, w: int, h: int) -> np.ndarray:
    """Resample a Grid onto our pixel-centred equirectangular target, in strips
    to bound memory. Cubic when upsampling, linear (after a light prefilter)
    when downsampling."""
    src = g.data
    target_step = 360.0 / w
    order = 3 if target_step < g.dlon else 1
    if target_step > g.dlon * 1.2:
        src = ndimage.gaussian_filter(src, sigma=0.5 * target_step / g.dlon)
    pad = 4
    padded = np.concatenate([src[:, -pad:], src, src[:, :pad]], axis=1)
    padded = np.concatenate([np.repeat(padded[:1], pad, 0), padded, np.repeat(padded[-1:], pad, 0)], axis=0)
    del src
    lon = -180.0 + (np.arange(w) + 0.5) * 360.0 / w
    c = np.mod(lon - g.lon_first, 360.0) / g.dlon + pad
    out = np.empty((h, w), np.float32)
    strip = max(1, 2_000_000 // w)
    for y0 in range(0, h, strip):
        y1 = min(h, y0 + strip)
        lat = 90.0 - (np.arange(y0, y1) + 0.5) * 180.0 / h
        r = (g.lat_first - lat) / g.dlat + pad
        rr, cc = np.meshgrid(r, c, indexing="ij")
        out[y0:y1] = ndimage.map_coordinates(padded, [rr, cc], order=order, mode="nearest")
    return out


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


def raster_polygons(files: list[Path], w: int, h: int, feature_filter=None, ss: int = SUPERSAMPLE) -> np.ndarray:
    """Polygon coverage, 0..1 float32 at (h, w), anti-aliased when ss > 1."""
    W, H = w * ss, h * ss
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
    if ss > 1:
        img = img.resize((w, h), Image.BOX)
    return np.asarray(img, dtype=np.float32) / 255.0


def raster_lines(path: Path, w: int, h: int, width_fn, ss: int = SUPERSAMPLE) -> np.ndarray:
    W, H = w * ss, h * ss
    img = Image.new("L", (W, H), 0)
    draw = ImageDraw.Draw(img)
    gj = json.loads(path.read_text())
    for feat, line in iter_lines(gj):
        width = width_fn(feat) * ss
        if width <= 0:
            continue
        for variant in ring_variants(line):
            if len(variant) < 2:
                continue
            draw.line(to_xy(variant, W, H), fill=255, width=max(1, int(round(width))), joint="curve")
    if ss > 1:
        img = img.resize((w, h), Image.BOX)
    return np.asarray(img, dtype=np.float32) / 255.0


def downsample(a: np.ndarray, w: int, h: int) -> np.ndarray:
    """Box-downsample a 0..1 coverage mask."""
    return np.asarray(Image.fromarray((a * 255).astype(np.uint8)).resize((w, h), Image.BOX), np.float32) / 255.0


def downsample_f(a: np.ndarray, w: int, h: int) -> np.ndarray:
    """Box-downsample a float field (metres)."""
    return np.array(Image.fromarray(a.astype(np.float32), "F").resize((w, h), Image.BOX), np.float32)


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


def sharpen_peaks(E: np.ndarray, peaks: list[dict], sigma_km: float) -> list[dict]:
    """Gridded DEMs average summits away. Restore real summit heights with a
    narrow Gaussian bump centred on each known peak."""
    h, w = E.shape
    report = []
    sigma = sigma_km / (40075.0 / w)  # in pixels
    rad = int(math.ceil(sigma * 4.5))
    for p in peaks:
        x = (p["lon"] + 180.0) / 360.0 * w - 0.5
        y = (90.0 - p["lat"]) / 180.0 * h - 0.5
        cx, cy = int(round(x)), int(round(y))
        before = bilinear(E, p["lat"], p["lon"])
        if p["summitM"] - before <= 0:
            report.append({"id": p["id"], "before": round(before), "after": round(before)})
            continue
        # Blend each pixel towards a target height with a Gaussian weight (no
        # overshoot far from the peak), then nudge the target until the
        # bilinear-sampled summit matches the real one.
        ys = np.arange(cy - rad, cy + rad + 1)
        xs = np.arange(cx - rad, cx + rad + 1)
        ys = ys[(ys >= 0) & (ys < h)]
        xw = xs % w
        orig = E[np.ix_(ys, xw)].copy()
        g = np.exp(-(((xs[None, :] - x) ** 2) + ((ys[:, None] - y) ** 2)) / (2 * sigma * sigma))
        target = float(p["summitM"])
        for _ in range(6):
            E[np.ix_(ys, xw)] = np.where(orig < target, orig + (target - orig) * g, orig)
            err = p["summitM"] - bilinear(E, p["lat"], p["lon"])
            if abs(err) < 3:
                break
            target += err
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

    print("1/8 DEM")
    dem = load_dem(raw)
    print(f"    {dem.name}: {dem.data.shape[1]}x{dem.data.shape[0]}, ~{dem.res_km:.1f} km")
    E = resample(dem, WORK_W, WORK_H)
    dem_name, dem_res_km = dem.name, dem.res_km
    del dem

    print("2/8 land / lakes / ice / rivers at", WORK_W, "x", WORK_H)
    land_w = raster_polygons([ne("ne_10m_land"), ne("ne_10m_minor_islands")], WORK_W, WORK_H, ss=1)
    lakes_w = raster_polygons([ne("ne_10m_lakes"), ne("ne_10m_lakes_europe"), ne("ne_10m_lakes_north_america")], WORK_W, WORK_H, ss=1)
    ice_w = raster_polygons([ne("ne_10m_glaciated_areas"), ne("ne_10m_antarctic_ice_shelves_polys")], WORK_W, WORK_H, ss=1)
    # Ice shelves float on the sea: they count as surface for the player.
    land_w = np.maximum(land_w, ice_w)

    def river_width(feat):
        props = feat.get("properties", {})
        if props.get("featurecla", "").lower().startswith("lake centerline"):
            return 0
        sr = props.get("scalerank", 6) or 6
        return 2 * max(0.6, 2.4 - 0.25 * float(sr))  # pixels at the 16384 working grid
    rivers_w = np.minimum(raster_lines(ne("ne_10m_rivers_lake_centerlines"), WORK_W, WORK_H, river_width, ss=1), land_w)

    # Display masks: box-downsample 2x for anti-aliasing.
    surface = np.stack([downsample(m, SURF_W, SURF_H) for m in (land_w, lakes_w, rivers_w, ice_w)], axis=-1)
    Image.fromarray((surface * 255).round().astype(np.uint8), "RGBA").save(OUT / "surface.png", optimize=True)
    del rivers_w, ice_w, surface

    print("2b   coast distance field")
    # At the display resolution (8192 wide) to keep memory sane; the anti-aliased
    # land coverage gives a sub-pixel correction so contours stay smooth.
    land8 = downsample(land_w, SURF_W, SURF_H)
    sea = land8 < 0.5
    km_per_px = 40075.0 / SURF_W
    signed = ndimage.distance_transform_edt(sea).astype(np.float32)
    signed -= ndimage.distance_transform_edt(~sea).astype(np.float32)
    signed = (signed + (0.5 - land8)) * km_per_px
    coast = np.clip(128.0 + signed / 0.5, 0, 255).round().astype(np.uint8)
    Image.fromarray(coast, "L").save(OUT / "coast.png", optimize=True)
    del signed, coast, sea, land8

    print("3/8 height consistency at the working grid (coastlines, lakes, peaks)")
    is_land = land_w >= 0.5
    is_lake = lakes_w >= 0.5
    np.maximum(E, 1.0, out=E, where=is_land & ~is_lake)
    np.minimum(E, -2.0, out=E, where=~is_land)
    n_lakes = flatten_lakes(E, lakes_w)
    src = json.loads((HERE / "landmarks.source.json").read_text())["landmarks"]
    peaks = [l for l in src if l.get("summitM")]
    sigma_km = max(6.0, dem_res_km * 0.7)
    peak_report = sharpen_peaks(E, peaks, sigma_km)
    np.round(E, out=E)

    print("4/8 detail tiles")
    tiles_dir = OUT / "tiles" / str(TILE_LEVEL)
    if tiles_dir.exists():
        for f in tiles_dir.iterdir():
            f.unlink()
    tiles_dir.mkdir(parents=True, exist_ok=True)
    cols, rows = WORK_W // TILE, WORK_H // TILE
    written = []
    tile_bytes = 0
    for ty in range(rows):
        for tx in range(cols):
            ys, xs = slice(ty * TILE, (ty + 1) * TILE), slice(tx * TILE, (tx + 1) * TILE)
            if not is_land[ys, xs].any():
                continue  # open ocean: the base map is enough
            fn = tiles_dir / f"{tx}_{ty}.webp"
            Image.fromarray(encode_terrarium(E[ys, xs]), "RGB").save(fn, "WEBP", lossless=True, quality=80, method=4)
            tile_bytes += fn.stat().st_size
            written.append(f"{tx}_{ty}")
    (OUT / "tiles.json").write_text(json.dumps({
        "level": TILE_LEVEL, "tileSize": TILE, "cols": cols, "rows": rows,
        "degreesPerTile": 360.0 / cols, "encoding": "terrarium", "format": "webp", "tiles": written,
    }, separators=(",", ":")))
    print(f"    {len(written)} tiles, {tile_bytes / 1e6:.1f} MB")
    del is_land, is_lake

    print("5/8 global base height")
    Eb = downsample_f(E, HEIGHT_W, HEIGHT_H)
    land4 = downsample(land_w, HEIGHT_W, HEIGHT_H)
    lake4 = downsample(lakes_w, HEIGHT_W, HEIGHT_H)
    del lakes_w
    np.maximum(Eb, 1.0, out=Eb, where=(land4 >= 0.5) & (lake4 < 0.5))
    np.minimum(Eb, -2.0, out=Eb, where=land4 < 0.5)
    flatten_lakes(Eb, lake4)
    Eb = np.round(Eb)
    rgb = encode_terrarium(Eb)
    err = float(np.abs(decode_terrarium(rgb) - Eb).max())
    assert err < 0.01, f"terrarium round-trip error {err}"
    Image.fromarray(rgb, "RGB").save(OUT / "height.png", optimize=True)
    land = land_w  # used below for lights

    print("6/8 lights + desert")
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

    print("7/8 cities + landmarks")
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

    print("8/8 meta")
    meta = {
        "bakedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "projection": "equirectangular; x: lon -180..180, y: lat 90..-90, pixel centres",
        "height": {"file": "height.png", "width": HEIGHT_W, "height": HEIGHT_H, "encoding": "terrarium",
                    "decode": "elevation_m = R*256 + G + B/256 - 32768", "verticalDatum": "mean sea level",
                    "minM": round(float(Eb.min())), "maxM": round(float(Eb.max())), "source": dem_name},
        "detail": {"manifest": "tiles.json", "width": WORK_W, "height": WORK_H, "tileSize": TILE, "level": TILE_LEVEL,
                    "minM": round(float(E.min())), "maxM": round(float(E.max())), "sourceResolutionKm": round(dem_res_km, 2),
                    "tiles": len(written)},
        "surface": {"file": "surface.png", "width": SURF_W, "height": SURF_H, "channels": {"r": "land", "g": "lake", "b": "river", "a": "ice"}},
        "coast": {"file": "coast.png", "width": SURF_W, "height": SURF_H, "decode": "km = (v - 128) * 0.5; > 0 at sea"},
        "aux": {"file": "aux.png", "width": AUX_W, "height": AUX_H, "channels": {"r": "cityLights", "g": "desert", "b": "reserved"}},
        "stats": {"lakes": n_lakes, "peakSigmaKm": round(sigma_km, 1), "cities": len(cities), "landmarks": len(landmarks), "peaks": peak_report},
        "sources": [
            {"name": dem_name, "by": "NOAA NCEI", "licence": "Public domain (US Government)"},
            {"name": "Natural Earth 1:10m vectors", "by": "naturalearthdata.com", "licence": "Public domain"},
        ],
    }
    (OUT / "meta.json").write_text(json.dumps(meta, indent=1))
    for f in sorted(OUT.iterdir()):
        print(f"   {f.name:16s} {f.stat().st_size / 1e6:6.2f} MB")
    print("done")


if __name__ == "__main__":
    main()
