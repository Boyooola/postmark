import {
  BoxGeometry,
  BufferAttribute,
  Color,
  CylinderGeometry,
  Group,
  LatheGeometry,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  Vector2,
  Vector3,
} from "three";
import {
  FLIGHT,
  WORLD_RADIUS,
  elevationToUnits,
  latLonToDirection,
  type DeliveryTarget,
} from "@postmark/game-core";

/** Two-colour stripe palettes; a country always gets the same one. */
const PALETTES: [number, number][] = [
  [0xd94f3d, 0xf4e9d8], [0x2f6db5, 0xf2c230], [0x1f8a5b, 0xf4e9d8], [0x7a3fa0, 0xf2c230],
  [0xe07a2e, 0x2b3a67], [0xc8324b, 0x2f6db5], [0x2a9d8f, 0xe9c46a], [0x264653, 0xe76f51],
  [0xb5179e, 0xf8f9fa], [0x3a86ff, 0xffbe0b], [0x588157, 0xdad7cd], [0x9d0208, 0xffba08],
];

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Balloon envelope + basket, about 1 unit tall, origin at the basket. */
function buildBalloon(country: string): Group {
  const [a, b] = PALETTES[hash(country) % PALETTES.length];
  const pts: Vector2[] = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24; // bottom -> top
    const y = t;
    const r = t < 0.25 ? 0.08 + t * 1.4 : 0.43 * Math.sin(Math.PI * (0.18 + 0.82 * t)) + 0.02;
    pts.push(new Vector2(Math.max(r, 0.001), y));
  }
  const env = new LatheGeometry(pts, 32);
  // Vertical gores in alternating colours.
  const colors = new Float32Array(env.attributes.position.count * 3);
  const ca = new Color(a), cb = new Color(b);
  const pos = env.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const ang = Math.atan2(pos.getZ(i), pos.getX(i));
    const gore = Math.floor(((ang + Math.PI) / (2 * Math.PI)) * 12);
    (gore % 2 === 0 ? ca : cb).toArray(colors, i * 3);
  }
  env.setAttribute("color", new BufferAttribute(colors, 3));
  const envelope = new Mesh(env, new MeshStandardMaterial({ vertexColors: true, roughness: 0.6 }));
  envelope.position.y = 0.32;
  envelope.scale.setScalar(1.25);

  const basket = new Mesh(new BoxGeometry(0.14, 0.11, 0.14), new MeshStandardMaterial({ color: 0x8a5a2b, roughness: 0.9 }));
  basket.position.y = 0.05;
  const ropeMat = new MeshStandardMaterial({ color: 0x3a2a1a });
  const g = new Group();
  g.add(envelope, basket);
  for (const [x, z] of [[-0.06, -0.06], [0.06, -0.06], [-0.06, 0.06], [0.06, 0.06]]) {
    const rope = new Mesh(new CylinderGeometry(0.004, 0.004, 0.24, 4), ropeMat);
    rope.position.set(x * 1.4, 0.22, z * 1.4);
    g.add(rope);
  }
  return g;
}

interface BalloonEntry {
  target: DeliveryTarget;
  root: Group;
  base: Vector3;
  up: Vector3;
  phase: number;
}

/**
 * A hot-air balloon floats over each open destination, a little below
 * cruising height, so you can spot it from far away and line up a drop.
 */
export class Balloons {
  readonly group = new Group();
  private entries = new Map<string, BalloonEntry>();
  private tmp = new Vector3();

  constructor(private surfaceM: (lat: number, lon: number) => number) {}

  /** Make the balloons match the open destinations. */
  sync(targets: readonly DeliveryTarget[]) {
    const ids = new Set(targets.map((t) => t.id));
    for (const [id, e] of this.entries) {
      if (!ids.has(id)) {
        this.group.remove(e.root);
        this.entries.delete(id);
      }
    }
    for (const t of targets) {
      if (this.entries.has(t.id)) continue;
      const up = latLonToDirection(t.lat, t.lon);
      const altM = Math.max(FLIGHT.cruiseAltitudeM - 1800, this.surfaceM(t.lat, t.lon) + 2500);
      const base = up.clone().multiplyScalar(WORLD_RADIUS + elevationToUnits(altM));
      const root = buildBalloon(t.country);
      root.quaternion.copy(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), up));
      root.position.copy(base);
      this.group.add(root);
      this.entries.set(t.id, { target: t, root, base, up, phase: Math.random() * 10 });
    }
  }

  /** Gentle bobbing, and grow with distance so balloons stay visible far away. */
  update(camPos: Vector3, time: number) {
    for (const e of this.entries.values()) {
      const bob = Math.sin(time * 0.8 + e.phase) * 0.08;
      e.root.position.copy(e.base).addScaledVector(e.up, bob);
      const d = this.tmp.copy(e.root.position).sub(camPos).length();
      e.root.scale.setScalar(Math.min(Math.max(d * 0.035, 1.1), 7));
      e.root.rotation.y = 0;
    }
  }
}
