import {
  ClampToEdgeWrapping,
  DataTexture,
  DataUtils,
  FloatType,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RedFormat,
  RepeatWrapping,
  Texture,
  type WebGLRenderer,
} from "three";
import { HeightField, type City, type Landmark } from "@postmark/game-core";
import type { TileManifest } from "./terrain/DetailTerrain";

export interface GeoMeta {
  height: { width: number; height: number; minM: number; maxM: number; source: string };
  surface: { width: number; height: number };
  aux: { width: number; height: number };
  sources: { name: string; by: string; licence: string }[];
}

export interface GeoAssets {
  meta: GeoMeta;
  heights: HeightField;
  heightTexture: Texture;
  surfaceTexture: Texture;
  auxTexture: Texture;
  coastTexture: Texture;
  /** true-colour satellite map (sRGB, decoded in the shader) */
  colorTexture: Texture;
  landmarks: Landmark[];
  cities: City[];
  tiles: TileManifest | null;
  /** fine (~610 m) tiles for selected regions */
  tilesFine: TileManifest | null;
  floatLinear: boolean;
}

export type Progress = (label: string, fraction: number) => void;

async function fetchBitmap(url: string, maxSize?: number): Promise<ImageBitmap> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url} (${res.status})`);
  const blob = await res.blob();
  const opts: ImageBitmapOptions = { colorSpaceConversion: "none", premultiplyAlpha: "none" };
  const probe = await createImageBitmap(blob, opts);
  if (maxSize && probe.width > maxSize) {
    const w = maxSize, h = Math.round((probe.height * maxSize) / probe.width);
    probe.close();
    return createImageBitmap(blob, { ...opts, resizeWidth: w, resizeHeight: h, resizeQuality: "high" });
  }
  return probe;
}

function pixels(bmp: ImageBitmap): Uint8ClampedArray {
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true, colorSpace: "srgb" })!;
  ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(0, 0, bmp.width, bmp.height).data;
}

function colourTexture(bmp: ImageBitmap): Texture {
  const t = new Texture(bmp);
  t.colorSpace = NoColorSpace; // these are data masks, not colours
  t.wrapS = RepeatWrapping;
  t.wrapT = ClampToEdgeWrapping;
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  t.anisotropy = 4;
  t.flipY = false; // v = 0 is the top row (latitude +90)
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

export async function loadGeoAssets(base: string, renderer: WebGLRenderer, progress: Progress = () => {}): Promise<GeoAssets> {
  const maxTex = renderer.capabilities.maxTextureSize;
  progress("Reading the atlas", 0.02);
  const [meta, landmarks, cities, tiles, tilesFine] = await Promise.all([
    fetch(`${base}/meta.json`).then((r) => r.json() as Promise<GeoMeta>),
    fetch(`${base}/landmarks.json`).then((r) => r.json()).then((j) => j.landmarks as Landmark[]),
    fetch(`${base}/cities.json`).then((r) => r.json()).then((j) => j.cities as City[]),
    fetch(`${base}/tiles.json`).then((r) => (r.ok ? (r.json() as Promise<TileManifest>) : null)).catch(() => null),
    fetch(`${base}/tiles-8.json`).then((r) => (r.ok ? (r.json() as Promise<TileManifest>) : null)).catch(() => null),
  ]);

  progress("Loading elevation data", 0.1);
  const heightBmp = await fetchBitmap(`${base}/height.png`);
  progress("Decoding elevation", 0.45);
  const heights = HeightField.fromTerrarium(pixels(heightBmp), heightBmp.width, heightBmp.height);
  heightBmp.close();

  // Elevation lives on the GPU as real metres in a single float channel.
  const floatLinear = renderer.extensions.has("OES_texture_float_linear");
  const heightTexture = floatLinear
    ? new DataTexture(heights.data, heights.width, heights.height, RedFormat, FloatType)
    : new DataTexture(toHalf(heights.data), heights.width, heights.height, RedFormat, HalfFloatType);
  heightTexture.wrapS = RepeatWrapping;
  heightTexture.wrapT = ClampToEdgeWrapping;
  heightTexture.minFilter = LinearFilter;
  heightTexture.magFilter = LinearFilter;
  heightTexture.generateMipmaps = false;
  heightTexture.flipY = false;
  heightTexture.colorSpace = NoColorSpace;
  heightTexture.needsUpdate = true;

  progress("Loading coastlines, lakes and rivers", 0.6);
  const [surfaceBmp, auxBmp, coastBmp, colorBmp] = await Promise.all([
    fetchBitmap(`${base}/surface.png`, Math.min(maxTex, 8192)),
    fetchBitmap(`${base}/extras.png`, Math.min(maxTex, 4096)),
    fetchBitmap(`${base}/coast.png`, Math.min(maxTex, 8192)),
    fetchBitmap(`${base}/color.webp`, Math.min(maxTex, 8192)),
  ]);
  progress("Preparing the world", 0.9);
  return {
    meta,
    heights,
    heightTexture,
    surfaceTexture: colourTexture(surfaceBmp),
    auxTexture: colourTexture(auxBmp),
    coastTexture: colourTexture(coastBmp),
    colorTexture: colourTexture(colorBmp),
    landmarks,
    cities,
    tiles,
    tilesFine,
    floatLinear,
  };
}

function toHalf(src: Float32Array): Uint16Array {
  const out = new Uint16Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = DataUtils.toHalfFloat(src[i]);
  return out;
}
