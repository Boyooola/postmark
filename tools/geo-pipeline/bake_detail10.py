#!/usr/bin/env python3
"""
Postmark sharp-mountain bake: Copernicus GLO-90 (90 m) -> level-10 terrain tiles.

Level 10 = a 262144 x 131072 global grid (~153 m per pixel at the equator), cut
into 256 x 256 tiles: tiles/10/X_Y.webp (Terrarium, lossless WebP) + tiles-10.json.
Only tiles inside the regions below AND with real relief are written (flat land
and open sea gain nothing at this resolution); the game falls back to level 8 / 6.

Land heights come from Copernicus GLO-90; sea pixels (no Copernicus tile, or at
sea level where the coast mask says sea) take GEBCO depths so fjords and coasts
keep their bathymetry.

Inputs
  --copdem <dir>  Copernicus_DSM_COG_30_*_DEM.tif (1 x 1 degree, from fetch_copdem90.ps1),
                  or the same tiles as .npy (int16 metres)
  --gebco <dir>   the 8 GEBCO_2026 GeoTIFFs (as for bake_detail.py)

Run (after bake.py and bake_detail.py):
  python3 tools/geo-pipeline/bake_detail10.py --copdem ~/Downloads/copdem90 --gebco <dir>
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
from collections import OrderedDict
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bake import OUT, encode_terrarium  # noqa: E402
from bake_detail import Gebco, SRC_PER_DEG as GEBCO_PER_DEG  # noqa: E402

LEVEL = 10
TILE = 256
COLS, ROWS = 2 ** LEVEL, 2 ** (LEVEL - 1)          # 1024 x 512 tiles
DEG = 360.0 / COLS                                  # 0.3515625 degrees per tile
PX_DEG = DEG / TILE                                 # ~0.00137 degrees (~153 m)
COP = 1200                                          # Copernicus pixels per degree (3 arc-seconds)
RELIEF_MIN_M = 500.0                                # write a tile only if it spans at least this much

# (name, north, south, west, east): the big ranges plus a few dramatic coasts.
REGIONS = [
    ("Himalaya & Karakoram", 40.0, 26.0, 66.0, 98.0),
    ("Alps", 48.5, 43.0, 4.0, 17.0),
    ("Rockies, Grand Canyon & Sierra", 50.0, 32.0, -125.0, -104.0),
    ("Andes (central)", -10.0, -35.0, -78.0, -63.0),
    ("Norway", 71.0, 57.5, 4.0, 20.0),
    ("Japan", 46.0, 30.0, 128.0, 146.0),
    ("New Zealand", -34.0, -47.5, 166.0, 179.0),
    ("Philippines", 19.0, 5.0, 117.0, 127.0),
    ("Kilimanjaro", -1.5, -5.0, 35.5, 39.0),
    ("Iceland", 67.0, 63.0, -25.0, -13.0),
    ("Alaska Range & St Elias", 64.0, 58.0, -156.0, -136.0),
    ("Caucasus", 45.0, 40.0, 38.0, 50.0),
    ("Pyrenees", 44.0, 42.0, -2.0, 4.0),
]


class CopDem:
    """1-degree Copernicus tiles, resampled to a square 1200 x 1200 grid, pre-filtered, cached."""

    def __init__(self, folder: Path, cache: int = 48):
        import tifffile  # type: ignore

        self.tifffile = tifffile
        self.files: dict[tuple[int, int], Path] = {}
        # GeoTIFFs as downloaded, or .npy (int16 metres) unpacked from transfer bundles.
        for p in sorted(folder.glob("Copernicus_DSM_COG_30_*_DEM.*")):
            m = re.match(r"Copernicus_DSM_COG_30_([NS])(\d+)_00_([EW])(\d+)_00_DEM\.(tif|npy)$", p.name)
            if m:
                lat = int(m.group(2)) * (1 if m.group(1) == "N" else -1)
                lon = int(m.group(4)) * (1 if m.group(3) == "E" else -1)
                self.files[(lat, lon)] = p
        self.cache: OrderedDict[tuple[int, int], np.ndarray | None] = OrderedDict()
        self.limit = cache

    def tile(self, lat: int, lon: int) -> np.ndarray | None:
        """Tile whose south-west corner is (lat, lon); rows top->bottom, 1200 x 1200, or None (sea)."""
        k = (lat, lon)
        if k in self.cache:
            self.cache.move_to_end(k)
            return self.cache[k]
        p = self.files.get(k)
        a = None
        if p is not None:
            a = (np.load(p) if p.suffix == ".npy" else self.tifffile.imread(str(p))).astype(np.float32)
            if a.shape[1] != COP:  # narrower tiles at high latitude: stretch east-west
                a = ndimage.zoom(a, (COP / a.shape[0], COP / a.shape[1]), order=1)
            a[~np.isfinite(a)] = 0.0
            # Light low-pass: we resample 90 m -> ~150 m.
            a = ndimage.gaussian_filter(a, sigma=0.7)
        self.cache[k] = a
        if len(self.cache) > self.limit:
            self.cache.popitem(last=False)
        return a

    def sample(self, lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
        """Bilinear heights at (lat, lon) grids (same shape); NaN where there is no tile."""
        out = np.full(lat.shape, np.nan, np.float32)
        tl = np.floor(lat).astype(int)
        tn = np.floor(lon).astype(int)
        for la, lo in set(zip(tl.ravel().tolist(), tn.ravel().tolist())):
            sel = (tl == la) & (tn == lo)
            t = self.tile(la, lo)
            if t is None:
                continue
            r = (la + 1 - lat[sel]) * COP - 0.5
            c = (lon[sel] - lo) * COP - 0.5
            out[sel] = ndimage.map_coordinates(t, [r, c], order=1, mode="nearest")
        return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--copdem", type=Path, required=True)
    ap.add_argument("--gebco", type=Path, required=True)
    ap.add_argument("--only", help="bake just the regions whose name contains this text")
    args = ap.parse_args()
    cop = CopDem(args.copdem)
    geb = Gebco(args.gebco)
    print(f"{len(cop.files)} Copernicus tiles")

    surf = np.asarray(Image.open(OUT / "surface.png"))[..., 0].astype(np.float32) / 255.0
    sh, sw = surf.shape

    tiles_dir = OUT / "tiles" / str(LEVEL)
    regions = [r for r in REGIONS if not args.only or args.only.lower() in r[0].lower()]
    if not args.only and tiles_dir.exists():
        for f in tiles_dir.iterdir():
            f.unlink()
    tiles_dir.mkdir(parents=True, exist_ok=True)
    manifest_p = OUT / f"tiles-{LEVEL}.json"

    written: set[str] = set()
    total = 0
    off = (np.arange(TILE) + 0.5) * PX_DEG
    for name, north, south, west, east in regions:
        tx0 = math.floor((west + 180) / DEG); tx1 = math.ceil((east + 180) / DEG)
        ty0 = math.floor((90 - north) / DEG); ty1 = math.ceil((90 - south) / DEG)
        n_written = n_flat = 0
        for ty in range(ty0, ty1):
            lat_n = 90 - ty * DEG
            for txr in range(tx0, tx1):
                tx = txr % COLS
                key = f"{tx}_{ty}"
                if key in written:
                    continue
                lon_w = -180 + txr * DEG
                lat = lat_n - off[:, None] + 0 * off[None, :]
                lon = lon_w + off[None, :] + 0 * off[:, None]
                lon = ((lon + 180) % 360) - 180
                E = cop.sample(lat, lon)
                land_frac = float(np.mean(np.isfinite(E) & (E > 0.5)))
                if land_frac < 0.02:
                    continue  # open sea
                # Coast mask (what the shader sees), bilinear from surface.png.
                sy = (90 - lat) / 180 * sh - 0.5
                sx = np.mod((lon + 180) / 360 * sw - 0.5, sw)
                m = ndimage.map_coordinates(surf, [sy, sx], order=1, mode="nearest")
                sea = ~np.isfinite(E) | ((E <= 0.5) & (m < 0.85))
                if sea.any():
                    gr = (90 - lat[sea]) * GEBCO_PER_DEG - 0.5
                    gc = (lon[sea] + 180) * GEBCO_PER_DEG - 0.5
                    r0, r1 = int(gr.min()) - 2, int(gr.max()) + 3
                    c0, c1 = int(gc.min()) - 2, int(gc.max()) + 3
                    blk = geb.block(r0, r1, c0, c1)
                    g = ndimage.map_coordinates(blk, [gr - r0, gc - c0], order=1, mode="nearest")
                    E[sea] = np.minimum(g, -1.0)
                if float(E.max() - E.min()) < RELIEF_MIN_M:
                    n_flat += 1
                    continue
                fn = tiles_dir / f"{key}.webp"
                Image.fromarray(encode_terrarium(np.round(E)), "RGB").save(fn, "WEBP", lossless=True, quality=80, method=4)
                total += fn.stat().st_size
                written.add(key)
                n_written += 1
        print(f"{name:34s} {n_written:5d} tiles written, {n_flat:5d} too flat to need it")

    prev = json.loads(manifest_p.read_text()) if (args.only and manifest_p.exists()) else {"tiles": []}
    keys = sorted(set(prev.get("tiles", [])) | written | {f.stem for f in tiles_dir.glob("*.webp")})
    manifest_p.write_text(json.dumps({
        "level": LEVEL, "tileSize": TILE, "cols": COLS, "rows": ROWS, "degreesPerTile": DEG,
        "encoding": "terrarium", "format": "webp", "source": "Copernicus DEM GLO-90 (land) + GEBCO_2026 (sea)",
        "regions": [{"name": n, "north": a, "south": b, "west": c, "east": d} for (n, a, b, c, d) in REGIONS],
        "tiles": keys,
    }))
    meta_p = OUT / "meta.json"
    meta = json.loads(meta_p.read_text())
    meta["detail10"] = {"manifest": f"tiles-{LEVEL}.json", "tiles": len(keys), "metresPerPixel": 153}
    src = {"name": "Copernicus DEM GLO-90", "by": "ESA / Copernicus Programme (via AWS Open Data)",
           "licence": "Free to use with attribution (Copernicus DEM licence)"}
    meta["sources"] = [s for s in meta.get("sources", []) if s["name"] != src["name"]] + [src]
    meta_p.write_text(json.dumps(meta, indent=1))
    print(f"{len(keys)} level-{LEVEL} tiles, {total / 1e6:.1f} MB written this run")


if __name__ == "__main__":
    main()
