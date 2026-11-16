import { Quaternion, Vector3, type Object3D } from "three";
import { WORLD_RADIUS } from "@postmark/game-core";

/**
 * Render-only "small planet" curvature, in the spirit of Geographical Adventures.
 *
 * Everything is drawn on a sphere of radius R / curvature that touches the real
 * sphere right under the camera. Ground distance from that point and height above
 * sea level are kept, so nearby terrain looks exactly the same, but the horizon
 * bends away and you see the planet curve. Physics, collisions, the HUD and all
 * game data keep using the real, unbent positions; only drawing goes through this.
 *
 * GLSL twin: `bendChunk` below. Keep them identical.
 */
export class WorldBend {
  /** 1 = real Earth; 4 = drawn as a planet a quarter of Earth's radius. */
  curvature = 5;
  readonly nadir = new Vector3(0, 1, 0);
  readonly uniforms = {
    uBendNadir: { value: this.nadir },
    uBendRatio: { value: 4 },
    // Planet sphere as the atmosphere shaders should see it (horizon occlusion).
    uPlanetC: { value: new Vector3() },
    uPlanetR: { value: WORLD_RADIUS },
  };

  update(cameraPos: Vector3) {
    this.nadir.copy(cameraPos).normalize();
    const c = Math.max(1, this.curvature);
    const rEff = WORLD_RADIUS / c;
    this.uniforms.uBendRatio.value = c;
    this.uniforms.uPlanetC.value.copy(this.nadir).multiplyScalar(WORLD_RADIUS - rEff);
    this.uniforms.uPlanetR.value = rEff;
  }

  private d = new Vector3();
  private perp = new Vector3();
  private q = new Quaternion();

  /** Bent position of a real world position (out may alias p). Returns the bend rotation in `rot` if given. */
  apply(p: Vector3, out: Vector3, rot?: Quaternion): Vector3 {
    const c = Math.max(1, this.curvature);
    const r = p.length();
    if (c === 1 || r === 0) {
      rot?.identity();
      return out.copy(p);
    }
    const dir = this.d.copy(p).divideScalar(r);
    // Angle from the nadir via the chord (precise for tiny angles, unlike acos).
    this.perp.copy(dir).sub(this.nadir);
    const theta = 2 * Math.asin(Math.min(1, this.perp.length() / 2));
    const rEff = WORLD_RADIUS / c;
    const phi = Math.min(theta * c, Math.PI);
    this.perp.addScaledVector(this.nadir, -this.perp.dot(this.nadir));
    const pl = this.perp.length();
    if (pl < 1e-9) this.perp.set(0, 0, 0);
    else this.perp.divideScalar(pl);
    const ndir = new Vector3().copy(this.nadir).multiplyScalar(Math.cos(phi)).addScaledVector(this.perp, Math.sin(phi));
    if (rot) rot.setFromUnitVectors(dir, ndir);
    const h = r - WORLD_RADIUS;
    return out.copy(this.nadir).multiplyScalar(WORLD_RADIUS - rEff).addScaledVector(ndir, rEff + h);
  }

  /**
   * Place an object at its bent position. `basePos`/`baseQuat` are its real pose;
   * the object's own position/quaternion are overwritten.
   */
  place(obj: Object3D, basePos: Vector3, baseQuat?: Quaternion) {
    this.apply(basePos, obj.position, this.q);
    if (baseQuat) obj.quaternion.copy(this.q).multiply(baseQuat);
  }
}

/** GLSL twin of WorldBend.apply (needs uRadius). */
export const bendChunk = /* glsl */ `
uniform vec3 uBendNadir;
uniform float uBendRatio;
vec3 bendWorld(vec3 p) {
  if (uBendRatio <= 1.0) return p;
  float r = length(p);
  vec3 dir = p / r;
  // Angle from the nadir via the chord: precise near the camera, unlike acos.
  vec3 delta = dir - uBendNadir;
  float theta = 2.0 * asin(min(1.0, length(delta) * 0.5));
  float rEff = uRadius / uBendRatio;
  float phi = min(theta * uBendRatio, PI);
  vec3 perp = delta - uBendNadir * dot(delta, uBendNadir);
  float pl = length(perp);
  perp = pl > 1e-9 ? perp / pl : vec3(0.0);
  vec3 ndir = uBendNadir * cos(phi) + perp * sin(phi);
  return uBendNadir * (uRadius - rEff) + ndir * (rEff + (r - uRadius));
}
`;
