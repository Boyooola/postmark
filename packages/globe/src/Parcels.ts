import {
  BoxGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
} from "three";
import { WORLD_RADIUS, elevationToUnits, vectorToLatLon, type LatLon } from "@postmark/game-core";

const GRAVITY = 3.0; // world units / s^2 (game-scaled)
const CHUTE_DELAY = 0.45; // seconds before the parachute opens
const CHUTE_SINK = 2.4; // terminal sink speed under the chute, units/s
const DRAG = 0.9; // horizontal drag under the chute, 1/s
const LINGER = 2.5; // seconds a landed parcel stays visible

interface Parcel {
  root: Group;
  chute: Mesh;
  pos: Vector3;
  vel: Vector3;
  age: number;
  landedAt: number | null;
}

/**
 * Parcels dropped from the plane: they keep some of the plane's speed, open a
 * parachute and drift down. Where they land decides the delivery.
 */
export class Parcels {
  readonly group = new Group();
  private parcels: Parcel[] = [];
  private boxGeo = new BoxGeometry(0.12, 0.1, 0.12);
  private boxMat = new MeshStandardMaterial({ color: 0xc8935a, roughness: 0.85 });
  private chuteGeo = new SphereGeometry(0.32, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  private chuteMat = new MeshStandardMaterial({ color: 0xe0453a, roughness: 0.6, side: DoubleSide });
  private q = new Quaternion();
  private yAxis = new Vector3(0, 1, 0);

  constructor(
    private surfaceM: (lat: number, lon: number) => number,
    private onLanded: (where: LatLon) => void,
  ) {}

  drop(from: Vector3, planeVelocity: Vector3) {
    const root = new Group();
    const box = new Mesh(this.boxGeo, this.boxMat);
    const chute = new Mesh(this.chuteGeo, this.chuteMat);
    chute.position.y = 0.45;
    chute.scale.setScalar(0.01);
    root.add(box, chute);
    root.scale.setScalar(2.2);
    this.group.add(root);
    this.parcels.push({
      root,
      chute,
      pos: from.clone(),
      vel: planeVelocity.clone().multiplyScalar(0.55),
      age: 0,
      landedAt: null,
    });
  }

  update(dt: number) {
    for (const p of this.parcels) {
      p.age += dt;
      if (p.landedAt === null) {
        const up = p.pos.clone().normalize();
        const open = p.age > CHUTE_DELAY;
        // Split velocity into vertical and horizontal parts.
        const vUp = p.vel.dot(up);
        const horiz = p.vel.clone().addScaledVector(up, -vUp);
        let newVUp = vUp - GRAVITY * dt;
        if (open) {
          newVUp = Math.max(newVUp, -CHUTE_SINK);
          horiz.multiplyScalar(Math.exp(-DRAG * dt));
        }
        p.vel.copy(horiz).addScaledVector(up, newVUp);
        p.pos.addScaledVector(p.vel, dt);
        const s = Math.min(1, Math.max(0, (p.age - CHUTE_DELAY) / 0.35));
        p.chute.scale.set(s, s * 0.8, s);
        const { lat, lon } = vectorToLatLon(p.pos);
        const groundR = WORLD_RADIUS + elevationToUnits(this.surfaceM(lat, lon));
        if (p.pos.length() <= groundR) {
          p.pos.setLength(groundR);
          p.landedAt = p.age;
          this.onLanded({ lat, lon });
        }
        p.root.quaternion.copy(this.q.setFromUnitVectors(this.yAxis, up));
      } else {
        // Collapse the chute after landing.
        const t = (p.age - p.landedAt) / 0.6;
        p.chute.scale.set(Math.max(0, 1 - t), Math.max(0, 0.8 - t), Math.max(0, 1 - t));
      }
      p.root.position.copy(p.pos);
    }
    this.parcels = this.parcels.filter((p) => {
      const keep = p.landedAt === null || p.age - p.landedAt < LINGER;
      if (!keep) this.group.remove(p.root);
      return keep;
    });
  }

  clear() {
    for (const p of this.parcels) this.group.remove(p.root);
    this.parcels = [];
  }
}
