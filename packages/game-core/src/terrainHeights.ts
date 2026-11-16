import type { HeightField } from "./heightfield";

/**
 * A square high-resolution patch of the elevation grid, centred near the plane.
 * Pixel (i, j) sits at lon0 + (i + 0.5) * span / size, lat0 - (j + 0.5) * span / size.
 */
export interface DetailWindow {
  data: Float32Array;
  size: number;
  /** west edge, degrees (may be < -180; longitudes wrap) */
  lon0: number;
  /** north edge, degrees */
  lat0: number;
  /** width = height of the window, degrees */
  spanDeg: number;
}

/** Fraction of the window, at each edge, over which detail blends into the coarser data. */
export const DETAIL_EDGE_FADE = 0.06;

function smoothstep(a: number, b: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Where (0..1) a point falls inside a window, with its blend weight, or null if outside. */
export function windowCoords(w: DetailWindow | null, lat: number, lon: number): { du: number; dv: number; weight: number } | null {
  if (!w) return null;
  const du = ((((lon - w.lon0) % 360) + 360) % 360) / w.spanDeg;
  const dv = (w.lat0 - lat) / w.spanDeg;
  if (du <= 0 || du >= 1 || dv <= 0 || dv >= 1) return null;
  const edge = Math.min(du, 1 - du, dv, 1 - dv);
  return { du, dv, weight: smoothstep(0, DETAIL_EDGE_FADE, edge) };
}

function sampleWindow(w: DetailWindow, du: number, dv: number): number {
  const n = w.size;
  const x = Math.min(Math.max(du * n - 0.5, 0), n - 1);
  const y = Math.min(Math.max(dv * n - 0.5, 0), n - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, n - 1), y1 = Math.min(y0 + 1, n - 1);
  const fx = x - x0, fy = y - y0;
  const a = w.data[y0 * n + x0], b = w.data[y0 * n + x1];
  const c = w.data[y1 * n + x0], d = w.data[y1 * n + x1];
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

/**
 * Elevation lookups for physics and placement: the global base map, then the
 * streamed detail window (~2.4 km) and the fine window (~610 m, mountain
 * regions only), each blended in at its edges. Must match the shader's heightAt().
 */
export class TerrainHeights {
  /** level-6 window (~2.4 km) */
  detail: DetailWindow | null = null;
  /** level-8 window (~610 m), only where fine tiles exist */
  fine: DetailWindow | null = null;

  constructor(readonly base: HeightField) {}

  /** Kept for callers that only care about the level-6 window. */
  windowCoords(lat: number, lon: number) {
    return windowCoords(this.detail, lat, lon);
  }

  /** Elevation in metres (negative = ocean depth), using data up to `maxLevel` (0 base, 1 detail, 2 fine). */
  sample(lat: number, lon: number, maxLevel = 2): number {
    let h = this.base.sample(lat, lon);
    if (maxLevel >= 1) {
      const c = windowCoords(this.detail, lat, lon);
      if (c && c.weight > 0) h += (sampleWindow(this.detail!, c.du, c.dv) - h) * c.weight;
    }
    if (maxLevel >= 2) {
      const c = windowCoords(this.fine, lat, lon);
      if (c && c.weight > 0) h += (sampleWindow(this.fine!, c.du, c.dv) - h) * c.weight;
    }
    return h;
  }

  /** Surface you can fly into: ground on land, 0 at sea. */
  surface(lat: number, lon: number): number {
    return Math.max(this.sample(lat, lon), 0);
  }
}
