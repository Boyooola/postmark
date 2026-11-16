import {
  ClampToEdgeWrapping,
  DataTexture,
  DataUtils,
  FloatType,
  HalfFloatType,
  LinearFilter,
  NoColorSpace,
  RedFormat,
} from "three";
import type { DetailWindow, TerrainHeights } from "@postmark/game-core";

export interface TileManifest {
  level: number;
  tileSize: number;
  cols: number;
  rows: number;
  degreesPerTile: number;
  format?: string;
  tiles: string[];
}

const TILES_ACROSS = 8; // window = 8 x 8 tiles = 45 x 45 degrees at level 6
const RECENTER_TILES = 1.75; // recentre when the plane is this far from the window centre
const CACHE_LIMIT = 192; // decoded tiles kept in memory (~50 MB)

/**
 * Streams high-resolution elevation tiles around the plane into one square
 * texture (the "detail window"). The base map covers everything else.
 * While a new window loads, the previous one stays in use, so nothing pops out.
 */
export class DetailTerrain {
  readonly size: number;
  readonly texture: DataTexture;
  window: DetailWindow | null = null;
  loading = false;
  private present: Set<string>;
  private cache = new Map<string, Float32Array>();
  private canvas: OffscreenCanvas;
  private ctx: OffscreenCanvasRenderingContext2D;
  private origin = { tx0: Number.NaN, ty0: Number.NaN };

  /**
   * @param fill   elevation to use where no tile was baked (the coarser data)
   * @param assign where the live window goes in TerrainHeights (detail or fine)
   * @param skipEmpty if true, a window with no baked tiles at all is not used (null)
   */
  constructor(
    private baseUrl: string,
    private manifest: TileManifest,
    private heights: TerrainHeights,
    private floatLinear: boolean,
    private onChange: (w: DetailWindow | null) => void,
    private fill: (lat: number, lon: number) => number = (lat, lon) => heights.base.sample(lat, lon),
    private assign: (w: DetailWindow | null) => void = (w) => (heights.detail = w),
    private skipEmpty = false,
  ) {
    this.size = manifest.tileSize * TILES_ACROSS;
    this.present = new Set(manifest.tiles);
    this.canvas = new OffscreenCanvas(manifest.tileSize, manifest.tileSize);
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true })!;
    const n = this.size * this.size;
    this.texture = floatLinear
      ? new DataTexture(new Float32Array(n), this.size, this.size, RedFormat, FloatType)
      : new DataTexture(new Uint16Array(n), this.size, this.size, RedFormat, HalfFloatType);
    this.texture.wrapS = ClampToEdgeWrapping;
    this.texture.wrapT = ClampToEdgeWrapping;
    this.texture.minFilter = LinearFilter;
    this.texture.magFilter = LinearFilter;
    this.texture.generateMipmaps = false;
    this.texture.flipY = false;
    this.texture.colorSpace = NoColorSpace;
  }

  /** Call every frame (cheap). Starts loading a new window when the plane nears the edge. */
  update(lat: number, lon: number, force = false) {
    if (this.loading) return;
    const { degreesPerTile: deg, cols } = this.manifest;
    const fx = (lon + 180) / deg;
    const fy = (90 - lat) / deg;
    if (!force && (this.window || (this.skipEmpty && !Number.isNaN(this.origin.tx0)))) {
      const cx = this.origin.tx0 + TILES_ACROSS / 2;
      const cy = this.origin.ty0 + TILES_ACROSS / 2;
      let dx = Math.abs(fx - cx) % cols;
      dx = Math.min(dx, cols - dx);
      const dy = Math.abs(fy - cy);
      const atPole = this.origin.ty0 === 0 || this.origin.ty0 === this.manifest.rows - TILES_ACROSS;
      if (dx < RECENTER_TILES && (dy < RECENTER_TILES || atPole)) return;
    }
    void this.load(fx, fy);
  }

  /** Load the window around (fx, fy) in tile units. Resolves when it is live. */
  async load(fx: number, fy: number): Promise<void> {
    const { rows, degreesPerTile: deg } = this.manifest;
    const tx0 = Math.round(fx - TILES_ACROSS / 2);
    const ty0 = Math.max(0, Math.min(rows - TILES_ACROSS, Math.round(fy - TILES_ACROSS / 2)));
    if (tx0 === this.origin.tx0 && ty0 === this.origin.ty0 && (this.window || this.skipEmpty)) return;
    this.loading = true;
    try {
      if (this.skipEmpty && !this.anyTiles(tx0, ty0)) {
        // Nothing sharper here: switch the window off.
        this.window = null;
        this.origin = { tx0, ty0 };
        this.assign(null);
        this.onChange(null);
        return;
      }
      const ts = this.manifest.tileSize;
      const n = this.size;
      const data = new Float32Array(n * n);
      const jobs: Promise<void>[] = [];
      for (let j = 0; j < TILES_ACROSS; j++) {
        for (let i = 0; i < TILES_ACROSS; i++) {
          jobs.push(
            this.tile(tx0 + i, ty0 + j).then((t) => {
              for (let y = 0; y < ts; y++) data.set(t.subarray(y * ts, (y + 1) * ts), (j * ts + y) * n + i * ts);
            }),
          );
        }
      }
      await Promise.all(jobs);
      const win: DetailWindow = { data, size: n, lon0: -180 + tx0 * deg, lat0: 90 - ty0 * deg, spanDeg: TILES_ACROSS * deg };
      // Swap in: GPU texture, CPU heights, then listeners (shader uniforms, landmarks).
      if (this.floatLinear) {
        this.texture.image.data = data;
      } else {
        const half = new Uint16Array(n * n);
        for (let k = 0; k < half.length; k++) half[k] = DataUtils.toHalfFloat(data[k]);
        this.texture.image.data = half;
      }
      this.texture.needsUpdate = true;
      this.window = win;
      this.origin = { tx0, ty0 };
      this.assign(win);
      this.onChange(win);
    } finally {
      this.loading = false;
    }
  }

  /** One decoded tile (metres), from cache, network, or synthesised from the base map. */
  private async tile(txRaw: number, ty: number): Promise<Float32Array> {
    const { cols, tileSize: ts, degreesPerTile: deg } = this.manifest;
    const tx = ((txRaw % cols) + cols) % cols;
    const key = `${tx}_${ty}`;
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key); // refresh LRU position
      this.cache.set(key, hit);
      return hit;
    }
    let out: Float32Array;
    if (this.present.has(key)) {
      const ext = this.manifest.format ?? "png";
      const res = await fetch(`${this.baseUrl}/tiles/${this.manifest.level}/${key}.${ext}`);
      if (!res.ok) throw new Error(`tile ${key}: ${res.status}`);
      const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
      this.ctx.clearRect(0, 0, ts, ts);
      this.ctx.drawImage(bmp, 0, 0);
      bmp.close();
      const px = this.ctx.getImageData(0, 0, ts, ts).data;
      out = new Float32Array(ts * ts);
      for (let k = 0, p = 0; k < out.length; k++, p += 4) out[k] = px[p] * 256 + px[p + 1] + px[p + 2] / 256 - 32768;
    } else {
      // No tile was baked here: fill from the coarser data.
      out = new Float32Array(ts * ts);
      const lonW = -180 + tx * deg, latN = 90 - ty * deg, step = deg / ts;
      for (let y = 0; y < ts; y++) {
        const lat = latN - (y + 0.5) * step;
        for (let x = 0; x < ts; x++) out[y * ts + x] = this.fill(lat, lonW + (x + 0.5) * step);
      }
      return out; // not cached: the coarser data it came from may change
    }
    this.cache.set(key, out);
    if (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!);
    return out;
  }

  private anyTiles(tx0: number, ty0: number) {
    const { cols } = this.manifest;
    for (let j = 0; j < TILES_ACROSS; j++)
      for (let i = 0; i < TILES_ACROSS; i++) if (this.present.has(`${(((tx0 + i) % cols) + cols) % cols}_${ty0 + j}`)) return true;
    return false;
  }

  dispose() {
    this.texture.dispose();
    this.cache.clear();
  }
}
