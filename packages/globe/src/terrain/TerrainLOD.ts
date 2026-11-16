import {
  BufferAttribute,
  Frustum,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Matrix3,
  Matrix4,
  Mesh,
  PerspectiveCamera,
  ShaderMaterial,
  Sphere,
  Texture,
  Vector2,
  Vector3,
  Vector4,
} from "three";
import { DETAIL_EDGE_FADE, WORLD_RADIUS, elevationToUnits, type DetailWindow } from "@postmark/game-core";
import type { AtmosphereUniforms } from "../atmosphereParams";
import type { CloudUniforms } from "../cloudParams";
import { terrainFragment, terrainVertex } from "./terrainShader";

/** Cells per chunk edge. Every chunk is the same 33x33 vertex grid, drawn instanced. */
const GRID = 32;
const MAX_INSTANCES = 4096;

/** Cube faces as (u axis, v axis, normal); u x v = normal so triangles wind outward. */
const FACES: [Vector3, Vector3, Vector3][] = [
  [new Vector3(0, 0, -1), new Vector3(0, 1, 0), new Vector3(1, 0, 0)],
  [new Vector3(0, 0, 1), new Vector3(0, 1, 0), new Vector3(-1, 0, 0)],
  [new Vector3(1, 0, 0), new Vector3(0, 0, -1), new Vector3(0, 1, 0)],
  [new Vector3(1, 0, 0), new Vector3(0, 0, 1), new Vector3(0, -1, 0)],
  [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)],
  [new Vector3(-1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, -1)],
];

export interface TerrainTextures {
  height: Texture;
  heightSize: { width: number; height: number };
  detail: Texture;
  surface: Texture;
  aux: Texture;
}

export interface TerrainOptions {
  maxDepth?: number;
  /** split a chunk when the camera is closer than splitFactor x its edge length */
  splitFactor?: number;
}

function spherify(p: Vector3, out: Vector3) {
  const x2 = p.x * p.x, y2 = p.y * p.y, z2 = p.z * p.z;
  return out.set(
    p.x * Math.sqrt(Math.max(0, 1 - y2 / 2 - z2 / 2 + (y2 * z2) / 3)),
    p.y * Math.sqrt(Math.max(0, 1 - z2 / 2 - x2 / 2 + (z2 * x2) / 3)),
    p.z * Math.sqrt(Math.max(0, 1 - x2 / 2 - y2 / 2 + (x2 * y2) / 3)),
  ).normalize();
}

function buildChunkGeometry(): InstancedBufferGeometry {
  const n = GRID + 1;
  const pos: number[] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) pos.push(i / GRID, j / GRID, 0);
  const idx: number[] = [];
  const id = (i: number, j: number) => j * n + i;
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const a = id(i, j), b = id(i + 1, j), c = id(i + 1, j + 1), d = id(i, j + 1);
      idx.push(a, b, c, a, c, d);
    }
  }
  // Skirts: a ring of vertices pushed down below the border hides LOD cracks.
  const ring: number[] = [];
  for (let i = 0; i <= GRID; i++) ring.push(id(i, 0));
  for (let j = 1; j <= GRID; j++) ring.push(id(GRID, j));
  for (let i = GRID - 1; i >= 0; i--) ring.push(id(i, GRID));
  for (let j = GRID - 1; j >= 1; j--) ring.push(id(0, j));
  const skirtStart = pos.length / 3;
  for (const r of ring) pos.push(pos[r * 3], pos[r * 3 + 1], 1);
  for (let k = 0; k < ring.length; k++) {
    const k2 = (k + 1) % ring.length;
    const a = ring[k], b = ring[k2], sa = skirtStart + k, sb = skirtStart + k2;
    idx.push(a, sa, sb, a, sb, b, a, sb, sa, a, b, sb); // both windings
  }
  const g = new InstancedBufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
  g.setIndex(idx);
  return g;
}

export class TerrainLOD {
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  readonly material: ShaderMaterial;
  private chunkAttr: InstancedBufferAttribute;
  private maxDepth: number;
  private splitFactor: number;
  private frustum = new Frustum();
  private projView = new Matrix4();
  private tmpA = new Vector3();
  private tmpB = new Vector3();
  private sphere = new Sphere();
  private count = 0;
  private maxElevUnits = elevationToUnits(9000);
  chunksDrawn = 0;

  constructor(tex: TerrainTextures, atmo: AtmosphereUniforms, clouds: CloudUniforms, opts: TerrainOptions = {}) {
    this.maxDepth = opts.maxDepth ?? 8;
    this.splitFactor = opts.splitFactor ?? 2.2;
    const geometry = buildChunkGeometry();
    this.chunkAttr = new InstancedBufferAttribute(new Float32Array(MAX_INSTANCES * 4), 4);
    this.chunkAttr.setUsage(35048 /* DynamicDrawUsage */);
    geometry.setAttribute("aChunk", this.chunkAttr);
    geometry.instanceCount = 0;

    const faces = FACES.map(([a, b, n]) => new Matrix3().set(a.x, b.x, n.x, a.y, b.y, n.y, a.z, b.z, n.z));
    this.material = new ShaderMaterial({
      vertexShader: terrainVertex,
      fragmentShader: terrainFragment,
      uniforms: {
        ...atmo,
        ...clouds,
        uFaces: { value: faces },
        uHeight: { value: tex.height },
        uSurface: { value: tex.surface },
        uAux: { value: tex.aux },
        uDetail: { value: tex.detail },
        uDetailRect: { value: new Vector4(0, 0, 1, 0) },
        uDetailFade: { value: DETAIL_EDGE_FADE },
        uStepRad: { value: new Vector2((2 * Math.PI) / tex.heightSize.width, 0.001) },
        uElevScale: { value: elevationToUnits(1) },
        uSkirt: { value: 0.02 * WORLD_RADIUS },
        uCamPos: { value: new Vector3() },
        uHaze: { value: 0.5 },
        uInscatter: { value: 0.42 },
        uNightLights: { value: 0.9 },
      },
    });
    this.mesh = new Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
  }

  /** Point the shaders at a newly loaded detail window. */
  setDetailWindow(w: DetailWindow) {
    (this.material.uniforms.uDetailRect.value as Vector4).set(w.lon0, w.lat0, w.spanDeg, 1);
    (this.material.uniforms.uStepRad.value as Vector2).y = ((w.spanDeg / w.size) * Math.PI) / 180;
  }

  /** Re-select chunks for this camera. Cheap enough to run every frame. */
  update(camera: PerspectiveCamera) {
    camera.updateMatrixWorld();
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    (this.material.uniforms.uCamPos.value as Vector3).copy(camera.position);
    this.count = 0;
    for (let f = 0; f < 6; f++) this.select(f, -1, -1, 2, 0, camera.position);
    this.chunkAttr.needsUpdate = true;
    this.chunkAttr.clearUpdateRanges();
    this.chunkAttr.addUpdateRange(0, this.count * 4);
    this.mesh.geometry.instanceCount = this.count;
    this.chunksDrawn = this.count;
  }

  private select(face: number, x0: number, y0: number, size: number, depth: number, cam: Vector3) {
    if (this.count >= MAX_INSTANCES) return;
    const [a, b, n] = FACES[face];
    const half = size / 2;
    const c = this.tmpA.copy(n).addScaledVector(a, x0 + half).addScaledVector(b, y0 + half);
    const dir = spherify(c, this.tmpB);
    const R = WORLD_RADIUS;
    const angularRadius = size * 0.62; // radians, generous
    const camDist = cam.length();

    // Horizon culling: chunks entirely beyond the horizon (incl. tallest mountains) are skipped.
    if (camDist > R) {
      const horizon = Math.acos(R / camDist) + Math.acos(R / (R + this.maxElevUnits));
      const ang = Math.acos(Math.max(-1, Math.min(1, dir.dot(cam) / camDist)));
      if (ang - angularRadius > horizon + 0.02) return;
    }

    // Frustum culling with a bounding sphere around the chunk.
    const edge = size * 0.785 * R;
    this.sphere.center.copy(dir).multiplyScalar(R + this.maxElevUnits * 0.5);
    this.sphere.radius = edge * 0.75 + this.maxElevUnits;
    if (!this.frustum.intersectsSphere(this.sphere)) return;

    const dist = Math.max(0, this.sphere.center.distanceTo(cam) - edge * 0.71);
    if (depth < this.maxDepth && dist < edge * this.splitFactor) {
      const q = half;
      this.select(face, x0, y0, q, depth + 1, cam);
      this.select(face, x0 + q, y0, q, depth + 1, cam);
      this.select(face, x0, y0 + q, q, depth + 1, cam);
      this.select(face, x0 + q, y0 + q, q, depth + 1, cam);
      return;
    }
    const arr = this.chunkAttr.array as Float32Array;
    const o = this.count * 4;
    arr[o] = x0;
    arr[o + 1] = y0;
    arr[o + 2] = size;
    arr[o + 3] = face;
    this.count++;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
