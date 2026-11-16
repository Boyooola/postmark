import { Matrix4, Quaternion, Vector3 } from "three";
import { FLIGHT, WORLD_RADIUS, elevationToUnits, unitsToElevation } from "./constants";
import { headingOf, latLonToDirection, tangentFrame, vectorToLatLon, type LatLon } from "./geo";

export interface FlightInput {
  /** -1..1, positive = nose up */
  pitch: number;
  /** -1..1, positive = turn right */
  turn: number;
  boost: boolean;
  slow: boolean;
}

export interface FlightTelemetry extends LatLon {
  /** 0..1 */
  boostEnergy: number;
  boosting: boolean;
  /** 0 at slow speed, 1 at full boost */
  speedFraction: number;
  altitudeM: number;
  groundM: number;
  aglM: number;
  headingDeg: number;
  airspeedKmh: number;
  climbDeg: number;
  scraping: boolean;
}

/** Ground surface height (real metres) at a lat/lon. */
export type SurfaceFn = (lat: number, lon: number) => number;

/**
 * Arcade flight on a sphere. "Down" is always the planet's centre.
 * The plane keeps a horizontal heading (tangent to the sphere) plus a climb
 * angle; banking is cosmetic and follows the turn input.
 */
export class FlightModel {
  readonly position = new Vector3();
  /** horizontal heading, unit vector tangent to the sphere */
  readonly heading = new Vector3();
  readonly orientation = new Quaternion();
  readonly velocity = new Vector3();
  speed: number = FLIGHT.cruiseSpeed;
  /** boost energy, 0..1 */
  boostEnergy = 1;
  /** true while boost is actually being applied */
  boosting = false;
  climb = 0;
  bank = 0;
  scraping = false;

  private up = new Vector3();
  private tmp = new Vector3();
  private fwd = new Vector3();
  private m = new Matrix4();
  private q = new Quaternion();

  constructor(private surfaceM: SurfaceFn) {}

  /**
   * Place the plane over a point, facing a compass heading (degrees), at an
   * altitude above sea level (default: cruise), but never closer than 1,500 m
   * to the ground.
   */
  spawn(lat: number, lon: number, headingDeg: number, altitudeM: number = FLIGHT.cruiseAltitudeM) {
    const up = latLonToDirection(lat, lon, this.up);
    const groundM = this.surfaceM(lat, lon);
    const alt = Math.max(altitudeM, groundM + 1500);
    this.position.copy(up).multiplyScalar(WORLD_RADIUS + elevationToUnits(alt));
    const { east, north } = tangentFrame(up);
    const h = (headingDeg * Math.PI) / 180;
    this.heading.copy(north).multiplyScalar(Math.cos(h)).addScaledVector(east, Math.sin(h)).normalize();
    this.speed = FLIGHT.cruiseSpeed;
    this.boostEnergy = 1;
    this.climb = 0;
    this.bank = 0;
    this.updateOrientation();
  }

  update(dt: number, input: FlightInput) {
    dt = Math.min(dt, 0.1);
    const up = this.up.copy(this.position).normalize();

    // Boost uses energy; it refills when not boosting.
    this.boosting = input.boost && this.boostEnergy > 0.01;
    this.boostEnergy = this.boosting
      ? Math.max(0, this.boostEnergy - FLIGHT.boostDrain * dt)
      : Math.min(1, this.boostEnergy + FLIGHT.boostRefill * dt);

    // Speed
    const target = this.boosting ? FLIGHT.boostSpeed : input.slow ? FLIGHT.slowSpeed : FLIGHT.cruiseSpeed;
    const accel = FLIGHT.acceleration * (target > this.speed ? 1 : 1.5);
    this.speed += Math.sign(target - this.speed) * Math.min(Math.abs(target - this.speed), accel * dt);

    // Heading: rotate around local up
    const turn = clamp(input.turn, -1, 1);
    this.heading.applyAxisAngle(up, -turn * FLIGHT.turnRate * dt);

    // Climb angle: input drives it, otherwise it eases back to level
    const p = clamp(input.pitch, -1, 1);
    if (Math.abs(p) > 0.01) {
      this.climb += p * FLIGHT.pitchRate * dt;
    } else {
      this.climb -= this.climb * Math.min(1, 1.6 * dt);
    }
    this.climb = clamp(this.climb, -FLIGHT.maxClimbAngle, FLIGHT.maxClimbAngle);

    // Cosmetic bank follows turn input
    const targetBank = turn * FLIGHT.maxBankAngle;
    this.bank += (targetBank - this.bank) * Math.min(1, 4 * dt);

    // Move
    this.velocity
      .copy(this.heading)
      .multiplyScalar(Math.cos(this.climb))
      .addScaledVector(up, Math.sin(this.climb))
      .multiplyScalar(this.speed);
    this.position.addScaledVector(this.velocity, dt);

    // Re-project heading onto the new tangent plane (parallel transport)
    const newUp = this.tmp.copy(this.position).normalize();
    this.heading.addScaledVector(newUp, -this.heading.dot(newUp)).normalize();

    // Terrain and ceiling
    const { lat, lon } = vectorToLatLon(this.position);
    const groundR = WORLD_RADIUS + elevationToUnits(this.surfaceM(lat, lon));
    const minR = groundR + FLIGHT.minClearance;
    const maxR = WORLD_RADIUS + elevationToUnits(FLIGHT.ceilingM);
    const r = this.position.length();
    this.scraping = false;
    if (r < minR) {
      this.position.multiplyScalar(minR / r);
      if (this.climb < 0) this.climb = 0;
      this.scraping = true;
    } else if (r > maxR) {
      this.position.multiplyScalar(maxR / r);
      if (this.climb > 0) this.climb *= 0.9;
    }

    this.updateOrientation();
  }

  /** Model space: forward = -Z, up = +Y, right = +X. */
  private updateOrientation() {
    const up = this.up.copy(this.position).normalize();
    const fwd = this.fwd
      .copy(this.heading)
      .multiplyScalar(Math.cos(this.climb))
      .addScaledVector(up, Math.sin(this.climb))
      .normalize();
    const right = this.tmp.crossVectors(fwd, up).normalize();
    const planeUp = new Vector3().crossVectors(right, fwd).normalize();
    // columns: X = right, Y = up, Z = -forward
    this.m.makeBasis(right, planeUp, fwd.clone().negate());
    this.orientation.setFromRotationMatrix(this.m);
    this.q.setFromAxisAngle(new Vector3(0, 0, 1), -this.bank);
    this.orientation.multiply(this.q);
  }

  telemetry(): FlightTelemetry {
    const { lat, lon } = vectorToLatLon(this.position);
    const groundM = this.surfaceM(lat, lon);
    const altitudeM = unitsToElevation(this.position.length() - WORLD_RADIUS);
    return {
      lat,
      lon,
      altitudeM,
      groundM,
      aglM: altitudeM - groundM,
      headingDeg: headingOf(this.heading, this.up.copy(this.position).normalize()),
      airspeedKmh: this.speed * FLIGHT.displayKmhPerUnit,
      boostEnergy: this.boostEnergy,
      boosting: this.boosting,
      speedFraction: (this.speed - FLIGHT.slowSpeed) / (FLIGHT.boostSpeed - FLIGHT.slowSpeed),
      climbDeg: (this.climb * 180) / Math.PI,
      scraping: this.scraping,
    };
  }
}

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}
