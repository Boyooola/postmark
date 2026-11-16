#!/usr/bin/env python3
"""
Postmark fine-detail bake: GEBCO 15 arc-second (~450 m) elevation -> level-8
terrain tiles for selected regions (mountains and dramatic coasts).

Level 8 = a 65536 x 32768 global grid (~610 m per pixel at the equator),
cut into 256 x 256 tiles: tiles/8/X_Y.webp (Terrarium, lossless WebP), plus
tiles-8.json (manifest). Tiles outside the regions are not written; the game
falls back to the level-6 window there.

Source: the 8 GEBCO_2026 "ice surface" GeoTIFF tiles (90 x 90 degrees each),
e.g. gebco_2026_n90.0_s0.0_w0.0_e90.0_geotiff.tif, in --gebco <dir>.

Run (after bake.py):  python3 tools/geo-pipeline/bake_detail.py --gebco <dir>
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bake import OUT, HERE, encode_terrarium  # noqa: E402

LEVEL = 8
TILE = 256
COLS, ROWS = 2 ** LEVEL, 2 ** (LEVEL - 1)          # 256 x 128 tiles
W, H = COLS * TILE, ROWS * TILE                     # 65536 x 32768 pixels
DEG = 360.0 / COLS                                  # 1.40625 degrees per tile
SRC_PER_DEG = 240                                   # 15 arc-seconds

# (name, north, south, west, east) in degrees. Chosen for mountains, fjords,
# volcanoes and island arcs that read best with sharper terrain.
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
]


class Gebco:
    """Global accessor over the 8 GEBCO 90x90-degree GeoTIFFs via memory maps."""

    def __init__(self, folder: Path):
        import tifffile  # type: ignore

        self.tiles = {}
        for p in folder.glob("gebco_2026_n*_s*_w*_e*_geotiff.tif"):
            m = re.search(r"_n(-?[\d.]+)_s(-?[\d.]+)_w(-?[\d.]+)_e(-?[\d.]+)_", p.name)
            n, s, w, e = (float(v) for v in m.groups())
            self.tiles[(round(n), round(w))] = tifffile.memmap(str(p))
        if len(self.tiles) != 8:
            sys.exit(f"Expected 8 GEBCO tiles in {folder}, found {len(self.tiles)}")

    def block(self, r0: int, r1: int, c0: int, c1: int) -> np.ndarray:
        """Rows/cols in global source pixels (row 0 = 90N, col 0 = 180W); cols wrap."""
        out = np.zeros((r1 - r0, c1 - c0), np.float32)
        rr = np.clip(np.arange(r0, r1), 0, 180 * SRC_PER_DEG - 1)
        cc = np.mod(np.arange(c0, c1), 360 * SRC_PER_DEG)
        # Split by source tile.
        for (n, w), mm in self.tiles.items():
            tr0 = (90 - n) * SRC_PER_DEG
            tc0 = (w + 180) * SRC_PER_DEG
            rsel = np.nonzero((rr >= tr0) & (rr < tr0 + 90 * SRC_PER_DEG))[0]
            csel = np.nonzero((cc >= tc0) & (cc < tc0 + 90 * SRC_PER_DEG))[0]
            if len(rsel) == 0 or len(csel) == 0:
                continue
            lr = rr[rsel] - tr0
            lc = cc[csel] - tc0
            # Contiguous runs are the common case; fancy-index otherwise.
            sub = mm[lr.min(): lr.max() + 1][:, lc.min(): lc.max() + 1]
            sub = sub[lr - lr.min()][:, lc - lc.min()]
            out[np.ix_(rsel, csel)] = sub.astype(np.float32)
        return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gebco", type=Path, required=True)
    args = ap.parse_args()
    src = Gebco(args.gebco)

    tiles_dir = OUT / "tiles" / str(LEVEL)
    if tiles_dir.exists():
        for f in tiles_dir.iterdir():
            f.unlink()
    tiles_dir.mkdir(parents=True, exist_ok=True)

    peaks = [l for l in json.loads((HERE / "landmarks.source.json").read_text())["landmarks"] if l.get("summitM")]
    written: list[str] = []
    total_bytes = 0
    report = []
    for name, north, south, west, east in REGIONS:
        # Snap the region to whole tiles.
        tx0 = math.floor((west + 180) / DEG); tx1 = math.ceil((east + 180) / DEG)
        ty0 = math.floor((90 - north) / DEG); ty1 = math.ceil((90 - south) / DEG)
        rw, rh = (tx1 - tx0) * TILE, (ty1 - ty0) * TILE
        lon_w = -180 + tx0 * DEG
        lat_n = 90 - ty0 * DEG
        px_deg = 360.0 / W

        # Source block covering the region (+ margin), then resample onto the level-8 grid.
        margin = 8
        sr0 = int(math.floor((90 - lat_n) * SRC_PER_DEG)) - margin
        sr1 = int(math.ceil((90 - (lat_n - rh * px_deg)) * SRC_PER_DEG)) + margin
        sc0 = int(math.floor((lon_w + 180) * SRC_PER_DEG)) - margin
        sc1 = int(math.ceil((lon_w + rw * px_deg + 180) * SRC_PER_DEG)) + margin
        block = src.block(sr0, sr1, sc0, sc1)
        block[block < -15000] = 0.0
        ratio = (px_deg * SRC_PER_DEG)  # source pixels per output pixel (~1.32)
        block = ndimage.gaussian_filter(block, sigma=0.45 * ratio)
        lat = lat_n - (np.arange(rh) + 0.5) * px_deg
        lon = lon_w + (np.arange(rw) + 0.5) * px_deg
        r = (90 - lat) * SRC_PER_DEG - 0.5 - sr0
        c = (lon + 180) * SRC_PER_DEG - 0.5 - sc0
        E = np.empty((rh, rw), np.float32)
        step = 512
        for y0 in range(0, rh, step):
            y1 = min(rh, y0 + step)
            rr, cc = np.meshgrid(r[y0:y1], c, indexing="ij")
            E[y0:y1] = ndimage.map_coordinates(block, [rr, cc], order=1, mode="nearest")
        del block

        # Coastline agreement with the Natural Earth masks the shader uses, only
        # where the mask is confident (GEBCO's own coast is kept in between).
        # Sample the baked 8192-wide land mask (bilinear): it is exactly what the shader sees.
        surf = np.asarray(Image.open(OUT / "surface.png"))[..., 0].astype(np.float32) / 255.0
        sh, sw = surf.shape
        sy = (90 - lat) / 180 * sh - 0.5
        sx = (lon + 180) / 360 * sw - 0.5
        m = np.empty((rh, rw), np.float32)
        for y0 in range(0, rh, step):
            y1 = min(rh, y0 + step)
            yy, xx = np.meshgrid(sy[y0:y1], sx, indexing="ij")
            m[y0:y1] = ndimage.map_coordinates(surf, [yy, np.mod(xx, sw)], order=1, mode="nearest")
        del surf
        np.maximum(E, 1.0, out=E, where=m > 0.85)
        np.minimum(E, -2.0, out=E, where=m < 0.15)

        # Restore real summits that fall in this region (narrow, ~2 km).
        for p in peaks:
            if not (south <= p["lat"] <= north and west <= p["lon"] <= east):
                continue
            x = (p["lon"] - lon_w) / px_deg - 0.5
            y = (lat_n - p["lat"]) / px_deg - 0.5
            sigma = 2.0 / (40075.0 / W)
            rad = int(math.ceil(sigma * 4.5))
            cx, cy = int(round(x)), int(round(y))
            ys = np.arange(max(cy - rad, 0), min(cy + rad + 1, rh))
            xs = np.arange(max(cx - rad, 0), min(cx + rad + 1, rw))
            orig = E[np.ix_(ys, xs)].copy()
            g = np.exp(-(((xs[None, :] - x) ** 2) + ((ys[:, None] - y) ** 2)) / (2 * sigma * sigma))
            target = float(p["summitM"])
            sample = lambda: _bilinear_local(E, x, y)
            before = sample()
            for _ in range(6):
                E[np.ix_(ys, xs)] = np.where(orig < target, orig + (target - orig) * g, orig)
                err = p["summitM"] - sample()
                if abs(err) < 3:
                    break
                target += err
            report.append({"id": p["id"], "gebco": round(before), "after": round(sample())})

        np.round(E, out=E)
        n_written = 0
        for j in range(ty1 - ty0):
            for i in range(tx1 - tx0):
                ys, xs = slice(j * TILE, (j + 1) * TILE), slice(i * TILE, (i + 1) * TILE)
                if m[ys, xs].max() < 0.15:
                    continue  # open sea
                tx, ty = (tx0 + i) % COLS, ty0 + j
                key = f"{tx}_{ty}"
                if key in written:
                    continue
                fn = tiles_dir / f"{key}.webp"
                Image.fromarray(encode_terrarium(E[ys, xs]), "RGB").save(fn, "WEBP", lossless=True, quality=80, method=4)
                total_bytes += fn.stat().st_size
                written.append(key)
                n_written += 1
        print(f"{name:34s} {rw}x{rh} px, {n_written:4d} tiles, max {int(E.max())} m")
        del E, m

    (OUT / f"tiles-{LEVEL}.json").write_text(json.dumps({
        "level": LEVEL, "tileSize": TILE, "cols": COLS, "rows": ROWS, "degreesPerTile": DEG,
        "encoding": "terrarium", "format": "webp", "source": "GEBCO_2026 Grid (ice surface), 15 arc-second",
        "regions": [{"name": n, "north": a, "south": b, "west": c, "east": d} for (n, a, b, c, d) in REGIONS],
        "tiles": written,
    }, separators=(",", ":")))
    meta_p = OUT / "meta.json"
    meta = json.loads(meta_p.read_text())
    meta["detail8"] = {"manifest": f"tiles-{LEVEL}.json", "tiles": len(written), "bytes": total_bytes,
                       "source": "GEBCO_2026 Grid (ice surface), 15 arc-second", "peaks": report}
    srcs = meta.setdefault("sources", [])
    if not any("GEBCO" in s["name"] for s in srcs):
        srcs.append({"name": "GEBCO_2026 Grid", "by": "GEBCO Compilation Group (2026)",
                     "licence": "Free to use with acknowledgement (GEBCO terms of use)"})
    meta_p.write_text(json.dumps(meta, indent=1))
    print(f"total {len(written)} tiles, {total_bytes / 1e6:.1f} MB")
    print("peaks", report)


def _bilinear_local(E: np.ndarray, x: float, y: float) -> float:
    x0, y0 = int(math.floor(x)), int(math.floor(y))
    fx, fy = x - x0, y - y0
    h, w = E.shape
    def at(xx, yy):
        return float(E[min(max(yy, 0), h - 1), min(max(xx, 0), w - 1)])
    return (at(x0, y0) * (1 - fx) * (1 - fy) + at(x0 + 1, y0) * fx * (1 - fy)
            + at(x0, y0 + 1) * (1 - fx) * fy + at(x0 + 1, y0 + 1) * fx * fy)


if __name__ == "__main__":
    main()
