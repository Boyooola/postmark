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

/** Fraction of the window, at each edge, over which detail blends into the base map. */
export const DETAIL_EDGE_FADE = 0.06;

function smoothstep(a: number, b: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * Elevation lookups for physics and placement: the global base map, with the
 * streamed detail window blended in. Must match the shader's heightAt().
 */
export class TerrainHeights {
  detail: DetailWindow | null = null;

  constructor(readonly base: HeightField) {}

  /** Where (0..1) a point falls inside the detail window, or null if outside. */
  windowCoords(lat: number, lon: number): { du: number; dv: number; weight: number } | null {
    const d = this.detail;
    if (!d) return null;
    const du = ((((lon - d.lon0) % 360) + 360) % 360) / d.spanDeg;
    const dv = (d.lat0 - lat) / d.spanDeg;
    if (du <= 0 || du >= 1 || dv <= 0 || dv >= 1) return null;
    const edge = Math.min(du, 1 - du, dv, 1 - dv);
    return { du, dv, weight: smoothstep(0, DETAIL_EDGE_FADE, edge) };
  }

  /** Elevation in metres (negative = ocean depth). */
  sample(lat: number, lon: number): number {
    const hb = this.base.sample(lat, lon);
    const c = this.windowCoords(lat, lon);
    if (!c || c.weight <= 0) return hb;
    const d = this.detail!;
    const n = d.size;
    const x = Math.min(Math.max(c.du * n - 0.5, 0), n - 1);
    const y = Math.min(Math.max(c.dv * n - 0.5, 0), n - 1);
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const x1 = Math.min(x0 + 1, n - 1), y1 = Math.min(y0 + 1, n - 1);
    const fx = x - x0, fy = y - y0;
    const a = d.data[y0 * n + x0], b = d.data[y0 * n + x1];
    const cc = d.data[y1 * n + x0], dd = d.data[y1 * n + x1];
    const hd = a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + cc * (1 - fx) * fy + dd * fx * fy;
    return hb + (hd - hb) * c.weight;
  }

  /** Surface you can fly into: ground on land, 0 at sea. */
  surface(lat: number, lon: number): number {
    return Math.max(this.sample(lat, lon), 0);
  }
}
