import { distanceKm, type LatLon } from "./geo";
import type { City } from "./landmarks";

/**
 * Delivery loop (Geographical Adventures style): one destination is open
 * at a time; the player drops a parcel by parachute and it counts if it lands
 * close enough to a destination city.
 */
export const DELIVERY = {
  activeTargets: 1,
  /** a parcel landing within this distance of a destination is delivered */
  hitRadiusKm: 80,
  /** new destinations are picked this far from the player... */
  minDistanceKm: 600,
  maxDistanceKm: 7000,
  /** ...and this far from each other */
  minSeparationKm: 900,
  /** cities eligible as destinations */
  minPopulation: 1_000_000,
} as const;

/** Shorter display names, in the spirit of "Scotland (UK)". */
const COUNTRY_NAMES: Record<string, string> = {
  "United States of America": "United States",
  "United Kingdom": "UK",
  "Democratic Republic of the Congo": "DR Congo",
  "Republic of the Congo": "Congo",
  "Russian Federation": "Russia",
  "Central African Republic": "Central African Rep.",
  "Bosnia and Herzegovina": "Bosnia",
  "United Republic of Tanzania": "Tanzania",
  "Dominican Republic": "Dominican Rep.",
  "United Arab Emirates": "UAE",
  "Ivory Coast": "Côte d'Ivoire",
};
export const displayCountry = (name: string) => COUNTRY_NAMES[name] ?? name;

export interface DeliveryTarget extends LatLon {
  id: string;
  city: string;
  country: string;
}

export interface DropResult {
  /** the destination the parcel landed nearest to */
  target: DeliveryTarget;
  distanceKm: number;
  hit: boolean;
}

/** Small deterministic PRNG so runs (and tests) are reproducible from a seed. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Deliveries {
  targets: DeliveryTarget[] = [];
  delivered = 0;
  private pool: DeliveryTarget[];

  constructor(cities: readonly City[], private rng: () => number = mulberry32(Date.now())) {
    const seen = new Set<string>();
    this.pool = [];
    for (const c of cities) {
      if (!(c.capital || c.pop >= DELIVERY.minPopulation)) continue;
      const id = `${c.name}|${c.country}`;
      if (seen.has(id)) continue;
      seen.add(id);
      this.pool.push({ id, city: c.name, country: displayCountry(c.country), lat: c.lat, lon: c.lon });
    }
  }

  get poolSize() {
    return this.pool.length;
  }

  /** Open a fresh set of destinations around the player. */
  start(from: LatLon) {
    this.targets = [];
    while (this.targets.length < DELIVERY.activeTargets) {
      const t = this.pick(from);
      if (!t) break;
      this.targets.push(t);
    }
  }

  /** A parcel has landed: work out which destination it was for and whether it counts. */
  resolveDrop(landing: LatLon): DropResult | null {
    if (this.targets.length === 0) return null;
    let best = 0;
    let bestD = Infinity;
    this.targets.forEach((t, i) => {
      const d = distanceKm(landing, t);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    const target = this.targets[best];
    const hit = bestD <= DELIVERY.hitRadiusKm;
    if (hit) {
      this.delivered++;
      const next = this.pick(landing);
      if (next) this.targets[best] = next;
      else this.targets.splice(best, 1);
    }
    return { target, distanceKm: bestD, hit };
  }

  private pick(from: LatLon): DeliveryTarget | null {
    const ok = (c: DeliveryTarget, minD: number, maxD: number) => {
      if (this.targets.some((t) => t.id === c.id)) return false;
      const d = distanceKm(from, c);
      if (d < minD || d > maxD) return false;
      return this.targets.every((t) => distanceKm(t, c) >= DELIVERY.minSeparationKm);
    };
    // Prefer the normal distance band; widen it if the region is sparse.
    for (const [minD, maxD] of [
      [DELIVERY.minDistanceKm, DELIVERY.maxDistanceKm],
      [200, 12000],
      [0, Infinity],
    ] as const) {
      const candidates = this.pool.filter((c) => ok(c, minD, maxD));
      if (candidates.length) return candidates[Math.floor(this.rng() * candidates.length)];
    }
    return null;
  }
}
