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
export const VERTICAL_EXAGGERATION = 12;

/** Real elevation in metres -> rendered height above the sea-level sphere, in world units. */
export const elevationToUnits = (meters: number): number =>
  (meters * VERTICAL_EXAGGERATION) / METERS_PER_UNIT;

/** Rendered height above sea level in world units -> real-world-equivalent metres. */
export const unitsToElevation = (units: number): number =>
  (units * METERS_PER_UNIT) / VERTICAL_EXAGGERATION;

/** Great-circle surface distance: world units -> kilometres. */
export const unitsToKm = (units: number): number => (units * METERS_PER_UNIT) / 1000;

/**
 * Flight tuning. Speeds are in world units per second. The game compresses
 * time: the HUD shows an airspeed that feels right for a small plane rather
 * than the true ground speed (2 u/s would be ~46,000 km/h).
 */
export const FLIGHT = {
  cruiseSpeed: 2.0,
  boostSpeed: 5.5,
  slowSpeed: 1.0,
  acceleration: 1.6,
  turnRate: 0.9, // rad/s at full input
  pitchRate: 0.9, // rad/s change of climb angle
  maxClimbAngle: (35 * Math.PI) / 180,
  maxBankAngle: (45 * Math.PI) / 180,
  /** minimum clearance above terrain, world units (~ 80 m real at 12x) */
  minClearance: 0.15,
  /** ceiling, real metres */
  ceilingM: 15_000,
  /** HUD airspeed = speed * this (km/h) */
  displayKmhPerUnit: 180,
} as const;
