/**
 * Global elevation grid in real metres (equirectangular, pixel centres,
 * lon -180..180 left to right, lat 90..-90 top to bottom). Same layout as
 * apps/web/public/geo/height.png.
 */
export class HeightField {
  constructor(
    readonly width: number,
    readonly height: number,
    readonly data: Float32Array,
  ) {
    if (data.length !== width * height) throw new Error("HeightField: size mismatch");
  }

  /** Decode a Terrarium-encoded RGBA pixel buffer (from height.png). */
  static fromTerrarium(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): HeightField {
    const data = new Float32Array(width * height);
    for (let i = 0, p = 0; i < data.length; i++, p += 4) {
      data[i] = rgba[p] * 256 + rgba[p + 1] + rgba[p + 2] / 256 - 32768;
    }
    return new HeightField(width, height, data);
  }

  private at(x: number, y: number): number {
    const w = this.width;
    const xx = ((x % w) + w) % w;
    const yy = Math.min(Math.max(y, 0), this.height - 1);
    return this.data[yy * w + xx];
  }

  /** Bilinear elevation in metres. Ocean cells hold (negative) depth. */
  sample(lat: number, lon: number): number {
    const x = ((lon + 180) / 360) * this.width - 0.5;
    const y = ((90 - lat) / 180) * this.height - 0.5;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const a = this.at(x0, y0);
    const b = this.at(x0 + 1, y0);
    const c = this.at(x0, y0 + 1);
    const d = this.at(x0 + 1, y0 + 1);
    return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
  }

  /**
   * Height of the surface you can fly into, in metres: the ground on land,
   * the water surface (0) at sea. Lakes below sea level are treated as sea level.
   */
  surface(lat: number, lon: number): number {
    return Math.max(this.sample(lat, lon), 0);
  }
}
