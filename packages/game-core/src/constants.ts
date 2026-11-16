/**
 * World scale. One source of truth for every unit conversion in the game.
 *
 * Horizontal: the planet is modelled at true proportions, scaled so that the
 * Earth's mean radius (6,371 km) is WORLD_RADIUS units. 1 unit = 6.371 km.
 *
 * Vertical: real elevations are multiplied by VERTICAL_EXAGGERATION when drawn,
 * otherwise Everest would be a 1.4-unit bump on a 1000-unit sphere. All data,
 * physics and HUD readouts stay in real metres; only the rendering (and the
 * collision surface, so it matches what you see) is exaggerated.
 */
export const EARTH_RADIUS_M = 6_371_000;
export const WORLD_RADIUS = 1000;
export const METERS_PER_UNIT = EARTH_RADIUS_M / WORLD_RADIUS; // 6371
export const VERTICAL_EXAGGERATION = 8;

/** Real elevation in metres -> rendered height above the sea-level sphere, in world units. */
export const elevationToUnits = (meters: number): number =>
  (meters * VERTICAL_EXAGGERATION) / METERS_PER_UNIT;

/** Rendered height above sea level in world units -> real-world-equivalent metres. */
export const unitsToElevation = (units: number): number =>
  (units * METERS_PER_UNIT) / VERTICAL_EXAGGERATION;

/** Great-circle surface distance: world units -> kilometres. */
export const unitsToKm = (units: number): number => (units * METERS_PER_UNIT) / 1000;

/**
 * Flight tuning, in the style of Geographical Adventures: the plane cruises
 * high and fast so the planet's curve and whole mountain ranges are in view.
 * Speeds are world units per second; time is compressed (the HUD shows a
 * plausible airspeed, not the true ground speed).
 */
export const FLIGHT = {
  cruiseSpeed: 5.0,
  boostSpeed: 12.0,
  slowSpeed: 2.5,
  acceleration: 4.0,
  turnRate: 1.1, // rad/s at full input
  pitchRate: 0.8, // rad/s change of climb angle
  maxClimbAngle: (30 * Math.PI) / 180,
  maxBankAngle: (40 * Math.PI) / 180,
  /** default cruising altitude, real metres above sea level */
  cruiseAltitudeM: 9_000,
  /** minimum clearance above terrain, world units (~0.3 u = ~240 m real at 8x) */
  minClearance: 0.3,
  /** ceiling, real metres */
  ceilingM: 20_000,
  /** boost energy: drains while boosting, refills otherwise (fractions per second) */
  boostDrain: 0.22,
  boostRefill: 0.07,
  /** HUD airspeed = speed * this (km/h) */
  displayKmhPerUnit: 90,
} as const;
