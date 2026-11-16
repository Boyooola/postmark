import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  SphereGeometry,
  Vector3,
  type Camera,
  type Object3D,
} from "three";

/**
 * Placeholder mail plane built from primitives (forward = -Z, up = +Y).
 * Replace with a Blender model later: see docs/blender-pipeline.md.
 * Size is in world units; 0.3 u long reads well at the default chase distance.
 */
export function createPlaneModel(): { root: Group; propeller: Object3D; wingTips: [Object3D, Object3D] } {
  const root = new Group();
  const body = new MeshStandardMaterial({ color: 0xf2c230, roughness: 0.55, metalness: 0.05 });
  const trim = new MeshStandardMaterial({ color: 0xb8322a, roughness: 0.6 });
  const dark = new MeshStandardMaterial({ color: 0x2a2a2e, roughness: 0.4 });

  const fuselage = new Mesh(new CylinderGeometry(0.022, 0.014, 0.3, 10), body);
  fuselage.rotation.x = Math.PI / 2;
  root.add(fuselage);
  const nose = new Mesh(new CylinderGeometry(0.024, 0.022, 0.04, 10), trim);
  nose.rotation.x = Math.PI / 2;
  nose.position.z = -0.16;
  root.add(nose);

  const wing = new Mesh(new BoxGeometry(0.42, 0.008, 0.07), body);
  wing.position.set(0, -0.004, -0.04);
  root.add(wing);
  const stripeL = new Mesh(new BoxGeometry(0.04, 0.0085, 0.071), trim);
  stripeL.position.set(-0.17, -0.004, -0.04);
  const stripeR = stripeL.clone();
  stripeR.position.x = 0.17;
  root.add(stripeL, stripeR);

  const tailplane = new Mesh(new BoxGeometry(0.14, 0.006, 0.04), body);
  tailplane.position.set(0, 0.004, 0.13);
  root.add(tailplane);
  const fin = new Mesh(new BoxGeometry(0.006, 0.06, 0.05), trim);
  fin.position.set(0, 0.03, 0.13);
  root.add(fin);

  const canopy = new Mesh(new SphereGeometry(0.018, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2), dark);
  canopy.scale.set(1, 0.8, 1.8);
  canopy.position.set(0, 0.016, -0.02);
  root.add(canopy);

  const propeller = new Group();
  const blade = new Mesh(new BoxGeometry(0.11, 0.008, 0.003), dark);
  propeller.add(blade);
  const blade2 = blade.clone();
  blade2.rotation.z = Math.PI / 2;
  propeller.add(blade2);
  propeller.position.z = -0.182;
  root.add(propeller);

  // Navigation lights: red on the left wingtip, green on the right.
  const red = new Mesh(new SphereGeometry(0.008, 8, 6), new MeshBasicMaterial({ color: 0xff2a2a }));
  red.position.set(-0.21, -0.004, -0.04);
  const green = new Mesh(new SphereGeometry(0.008, 8, 6), new MeshBasicMaterial({ color: 0x2aff5a }));
  green.position.set(0.21, -0.004, -0.04);
  root.add(red, green);

  return { root, propeller, wingTips: [red, green] };
}

/** Fading ribbon that trails behind a point (the wingtip vapour trails). */
export class Trail {
  readonly mesh: Mesh;
  private points: Vector3[] = [];
  private geom = new BufferGeometry();
  private pos: Float32Array;
  private alpha: Float32Array;
  private tmp = new Vector3();
  private side = new Vector3();
  private lastPush = 0;

  constructor(private max = 160, private width = 0.0045) {
    this.pos = new Float32Array(max * 2 * 3);
    this.alpha = new Float32Array(max * 2);
    this.geom.setAttribute("position", new BufferAttribute(this.pos, 3));
    this.geom.setAttribute("alpha", new BufferAttribute(this.alpha, 1));
    const idx: number[] = [];
    for (let i = 0; i < max - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    this.geom.setIndex(idx);
    const mat = new MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      blending: AdditiveBlending,
    });
    mat.onBeforeCompile = (s) => {
      s.vertexShader = s.vertexShader
        .replace("#include <common>", "#include <common>\nattribute float alpha; varying float vA;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvA = alpha;");
      s.fragmentShader = s.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying float vA;")
        .replace("vec4 diffuseColor = vec4( diffuse, opacity );", "vec4 diffuseColor = vec4( diffuse * vA * 0.45, vA );");
    };
    this.mesh = new Mesh(this.geom, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 30; // after sky and clouds
  }

  reset() {
    this.points = [];
    this.geom.setDrawRange(0, 0);
  }

  update(source: Vector3, camera: Camera, time: number) {
    if (time - this.lastPush > 0.03 || this.points.length === 0) {
      this.points.unshift(source.clone());
      if (this.points.length > this.max) this.points.pop();
      this.lastPush = time;
    } else {
      this.points[0].copy(source);
    }
    const n = this.points.length;
    if (n < 2) return;
    for (let i = 0; i < n; i++) {
      const p = this.points[i];
      const q = this.points[Math.min(i + 1, n - 1)];
      const prev = this.points[Math.max(i - 1, 0)];
      this.tmp.subVectors(prev, q);
      const toCam = camera.position.clone().sub(p);
      this.side.crossVectors(this.tmp, toCam).normalize().multiplyScalar(this.width * (0.35 + 0.65 * i / this.max));
      this.pos.set([p.x + this.side.x, p.y + this.side.y, p.z + this.side.z], i * 6);
      this.pos.set([p.x - this.side.x, p.y - this.side.y, p.z - this.side.z], i * 6 + 3);
      const a = Math.pow(1 - i / n, 1.5);
      this.alpha[i * 2] = a;
      this.alpha[i * 2 + 1] = a;
    }
    this.geom.attributes.position.needsUpdate = true;
    this.geom.attributes.alpha.needsUpdate = true;
    this.geom.setDrawRange(0, (n - 1) * 6);
    this.geom.computeBoundingSphere();
  }
}

