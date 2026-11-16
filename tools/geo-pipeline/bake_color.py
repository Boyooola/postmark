"""Bake the satellite colour map and patch the shore fields.

Inputs
  --bmng <dir>   NASA Blue Marble Next Generation 500 m tiles, the eight files
                 world.YYYYMM.3x21600x21600.{A,B,C,D}{1,2}.jpg (one month).
                 A..D = 180W-90W, 90W-0, 0-90E, 90E-180E; 1 = north, 2 = south.
                 Download from the NASA Earth Observatory "Base Map" page (the plain
                 version without topography shading; see docs/geodata.md).

Outputs (apps/web/public/geo/)
  color.webp     8192x4096 sRGB, the surface's true colour (~4.9 km per pixel).
                 Graded in the terrain shader, not here, so the look stays tunable.
  coast.png      re-written from surface.png with the sea + lake shore fields
                 (same as bake.py step 2b) so lakes get surf without a full re-bake.
  meta.json      gains a "color" entry and the NASA credit.

Run:  python3 tools/geo-pipeline/bake_color.py --bmng ~/Downloads
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from bake import OUT, save_shore_fields  # noqa: E402

Image.MAX_IMAGE_PIXELS = None
COLOR_W, COLOR_H = 8192, 4096
TILE = 21600
DRAFT = 4  # decode each 21600^2 JPEG at 1/4 scale (libjpeg DCT scaling): fast and low-memory


def find_tiles(d: Path) -> tuple[str, dict[str, Path]]:
    tiles: dict[str, dict[str, Path]] = {}
    for p in d.glob("world.*.3x21600x21600.*.jpg"):
        m = re.match(r"world\.(\d{6})\.3x21600x21600\.([A-D][12])\.jpg$", p.name)
        if m:
            tiles.setdefault(m.group(1), {})[m.group(2)] = p
    full = {k: v for k, v in tiles.items() if len(v) == 8}
    if not full:
        sys.exit(f"No complete set of 8 BMNG tiles in {d}")
    month = sorted(full)[-1] if "200406" not in full else "200406"
    return month, full[month]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bmng", type=Path, required=True)
    args = ap.parse_args()
    month, tiles = find_tiles(args.bmng)
    print(f"Blue Marble {month[:4]}-{month[4:]}")

    small = TILE // DRAFT
    mosaic = np.zeros((2 * small, 4 * small, 3), np.uint8)
    for col, letter in enumerate("ABCD"):
        for row in (1, 2):
            im = Image.open(tiles[f"{letter}{row}"])
            im.draft("RGB", (small, small))
            im = im.convert("RGB")
            if im.size != (small, small):
                im = im.resize((small, small), Image.BOX)
            mosaic[(row - 1) * small: row * small, col * small:(col + 1) * small] = np.asarray(im)
            print(f"  tile {letter}{row}")

    # Downsample in linear light (one channel at a time to keep memory low) so
    # bright snow/sand doesn't bleed dark.
    lut = ((np.arange(256, dtype=np.float32) / 255.0) ** 2.2).astype(np.float32)
    out = np.zeros((COLOR_H, COLOR_W, 3), np.float32)
    for c in range(3):
        out[..., c] = np.asarray(Image.fromarray(lut[mosaic[..., c]]).resize((COLOR_W, COLOR_H), Image.BOX))
    del mosaic
    srgb = (np.clip(out, 0, 1) ** (1 / 2.2) * 255).round().astype(np.uint8)
    Image.fromarray(srgb, "RGB").save(OUT / "color.webp", quality=88, method=4)
    print("  color.webp", (OUT / "color.webp").stat().st_size // 1024, "KB")

    print("Shore fields from surface.png")
    surf = np.asarray(Image.open(OUT / "surface.png")).astype(np.float32) / 255.0
    save_shore_fields(surf[..., 0], surf[..., 1], OUT / "coast.png")

    meta_p = OUT / "meta.json"
    meta = json.loads(meta_p.read_text())
    meta["color"] = {"file": "color.webp", "width": COLOR_W, "height": COLOR_H, "encoding": "sRGB true colour",
                     "month": f"{month[:4]}-{month[4:]}"}
    meta["coast"] = meta.get("coast", {}) | {"decode": "km = (v - 128) * 0.5; R > 0 at sea, G > 0 on lakes"}
    src = {"name": f"Blue Marble: Next Generation ({month[:4]}-{month[4:]}, 500 m)", "by": "NASA Earth Observatory (Reto Stöckli)",
           "licence": "Public domain (US Government); credit NASA Earth Observatory"}
    meta["sources"] = [s for s in meta.get("sources", []) if not s["name"].startswith("Blue Marble")] + [src]
    meta_p.write_text(json.dumps(meta, indent=1))
    print("done")


if __name__ == "__main__":
    main()
