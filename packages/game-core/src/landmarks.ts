import { distanceKm, bearingDeg, type LatLon } from "./geo";

export type LandmarkKind = "building" | "monument" | "ruins" | "mountain" | "waterfall" | "natural" | "bridge";

/** Shape of apps/web/public/geo/landmarks.json (baked by tools/geo-pipeline). */
export interface Landmark extends LatLon {
  id: string;
  name: string;
  city: string;
  country: string;
  kind: LandmarkKind;
  /** height of the structure above its base, metres (0 for natural sites) */
  structureHeightM: number;
  /** real summit elevation for mountains, metres */
  summitM?: number;
  /** ground elevation at the site from the DEM (summit for mountains), metres */
  groundElevationM: number;
  /** optional glTF model, e.g. "/models/landmarks/eiffel-tower.glb" (see docs/blender-pipeline.md) */
  model?: string;
}

export interface City extends LatLon {
  name: string;
  country: string;
  pop: number;
  capital: boolean;
  elevationM: number;
}

export interface Nearest<T> {
  item: T;
  distanceKm: number;
  bearingDeg: number;
}

export function nearest<T extends LatLon>(from: LatLon, items: readonly T[], filter?: (t: T) => boolean): Nearest<T> | null {
  let best: Nearest<T> | null = null;
  for (const item of items) {
    if (filter && !filter(item)) continue;
    const d = distanceKm(from, item);
    if (!best || d < best.distanceKm) best = { item, distanceKm: d, bearingDeg: 0 };
  }
  if (best) best.bearingDeg = bearingDeg(from, best.item);
  return best;
}
