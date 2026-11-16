"""Bake night-side and sky textures.

Inputs (download by hand, see docs/geodata.md)
  --lights  BlackMarble_2016_3km_gray.jpg   NASA Earth at Night 2016, grayscale, 13500x6750
  --moon    lroc_color_2k.jpg                NASA SVS CGI Moon Kit colour map, 2048x1024
  --stars   starmap_2020_8k.exr              NASA SVS Deep Star Maps 2020, celestial coords, 8192x4096

Outputs (apps/web/public/geo/)
  lights.webp  8192x4096 grayscale (stored RGB), night lights, sRGB-encoded radiance
  moon.jpg     1024x512 sRGB, lunar albedo; u = 0.5 is the near-side centre (lon 0)
  stars.webp   8192x4096 sRGB, star field + Milky Way in celestial coordinates:
               u = 0.5 - RA / 360 deg (RA 0 at the centre, increasing to the left),
               v = 0.5 - Dec / 180 deg

Run: python3 tools/geo-pipeline/bake_sky.py --lights ... --moon ... --stars ...
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image

from bake import OUT

Image.MAX_IMAGE_PIXELS = None


def bake_lights(src: Path) -> None:
    im = Image.open(src).convert("L")
    # Box-filter in linear light so isolated towns don't vanish when shrinking.
    lut = ((np.arange(256, dtype=np.float32) / 255.0) ** 2.2)
    lin = lut[np.asarray(im)]
    small = np.asarray(Image.fromarray(lin).resize((8192, 4096), Image.BOX))
    enc = (np.clip(small, 0, 1) ** (1 / 2.2) * 255).round().astype(np.uint8)
    Image.fromarray(enc, "L").convert("RGB").save(OUT / "lights.webp", quality=90, method=4)
    print("  lights.webp", (OUT / "lights.webp").stat().st_size // 1024, "KB")


def bake_moon(src: Path) -> None:
    Image.open(src).convert("RGB").resize((1024, 512), Image.LANCZOS).save(OUT / "moon.jpg", quality=88)
    print("  moon.jpg", (OUT / "moon.jpg").stat().st_size // 1024, "KB")


def bake_stars(src: Path) -> None:
    import OpenEXR

    with OpenEXR.File(str(src)) as f:
        rgb = f.channels()["RGB"].pixels.astype(np.float32)
    # Linear radiance 0..1; store sRGB-encoded so faint Milky Way detail keeps its bits.
    enc = (np.clip(rgb, 0, 1) ** (1 / 2.2) * 255).round().astype(np.uint8)
    Image.fromarray(enc, "RGB").save(OUT / "stars.webp", quality=88, method=4)
    print("  stars.webp", (OUT / "stars.webp").stat().st_size // 1024, "KB")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--lights", type=Path)
    ap.add_argument("--moon", type=Path)
    ap.add_argument("--stars", type=Path)
    a = ap.parse_args()
    if a.lights:
        bake_lights(a.lights)
    if a.moon:
        bake_moon(a.moon)
    if a.stars:
        bake_stars(a.stars)

    meta_p = OUT / "meta.json"
    meta = json.loads(meta_p.read_text())
    meta["sky"] = {
        "lights": {"file": "lights.webp", "width": 8192, "height": 4096, "encoding": "sRGB-encoded night radiance (grey)"},
        "moon": {"file": "moon.jpg", "width": 1024, "height": 512},
        "stars": {"file": "stars.webp", "width": 8192, "height": 4096, "projection": "celestial, RA 0 at centre increasing left"},
    }
    srcs = {
        "Black Marble 2016 (night lights)": {"by": "NASA Earth Observatory", "licence": "Public domain (US Government)"},
        "CGI Moon Kit (LROC colour)": {"by": "NASA Goddard Scientific Visualization Studio", "licence": "Public domain (US Government)"},
        "Deep Star Maps 2020": {"by": "NASA Goddard Scientific Visualization Studio", "licence": "Public domain (US Government)"},
    }
    keep = [s for s in meta.get("sources", []) if s["name"] not in srcs]
    meta["sources"] = keep + [{"name": k, **v} for k, v in srcs.items()]
    meta_p.write_text(json.dumps(meta, indent=1))
    print("done")


if __name__ == "__main__":
    main()
