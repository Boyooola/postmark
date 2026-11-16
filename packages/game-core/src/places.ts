import type { LatLon } from "./geo";

/**
 * "Where am I": the country or sea under a point, from the baked places.png
 * (tools/geo-pipeline/bake_places.py). Per pixel v = R*65536 + G*256 + B;
 * country = v >> 9, sea = v & 511 (index + 1, 0 = none). Equirectangular,
 * v = 0 at the top. `rgba` is canvas pixel data (4 bytes per pixel, alpha ignored).
 */
export interface PlacesData {
  width: number;
  height: number;
  rgba: Uint8Array | Uint8ClampedArray;
  countries: string[];
  seas: string[];
}

export class Places {
  constructor(private d: PlacesData) {}

  /** Country name over land, otherwise the sea or ocean, otherwise null. */
  at(p: LatLon): string | null {
    const { width: w, height: h, rgba } = this.d;
    const x = ((Math.floor(((p.lon + 180) / 360) * w) % w) + w) % w;
    const y = Math.min(h - 1, Math.max(0, Math.floor(((90 - p.lat) / 180) * h)));
    const i = (y * w + x) * 4;
    const v = rgba[i] * 65536 + rgba[i + 1] * 256 + rgba[i + 2];
    const c = v >> 9;
    if (c > 0) return this.d.countries[c - 1] ?? null;
    const s = v & 511;
    return s > 0 ? (this.d.seas[s - 1] ?? null) : null;
  }
}
