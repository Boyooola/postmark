import {
  BackSide,
  CustomBlending,
  Group,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  NoColorSpace,
  OneFactor,
  OneMinusSrcAlphaFactor,
  ShaderMaterial,
  SphereGeometry,
  type Texture,
  TextureLoader,
  Vector3,
} from "three";
import { WORLD_RADIUS } from "@postmark/game-core";
import type { AtmosphereUniforms } from "./atmosphereParams";
import { atmosphereChunk, noiseChunk } from "./shaders/chunks";

/** North geomagnetic pole (IGRF, ~2025); the south one is roughly antipodal. */
const MAG_POLE = { lat: 80.8, lon: -72.6 };
/** Aurora layer, world units above the surface (1 u = 6.371 km; drawn ~100-300 km up). */
const AURORA_BOTTOM = 15;
const AURORA_TOP = 45;
/** How far away the moon is drawn, and its apparent size (real: 0.52 deg; a bit bigger reads better). */
const MOON_DISTANCE = 5000;
const MOON_ANGULAR_DEG = 1.8;

const skyVertex = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
  #include <logdepthbuf_vertex>
}
`;

const skyFragment = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${atmosphereChunk}
${noiseChunk}
uniform vec3 uCamPos;
uniform float uTime;
uniform vec3 uMagPole;
uniform float uAurora;     // 0..1, how much aurora shows (night at the camera)
uniform vec3 uMoonDir;
uniform float uMoonGlow;   // moon phase x visibility
varying vec3 vWorld;

// ---------------------------------------------------------------- aurora
// Curtains in a ring around each geomagnetic pole (magnetic latitude ~67-72),
// green with a sharp lower edge, fading to red at the top, folded by slow noise
// and striped by fine vertical rays. Ray-marched through a shell 100-300 km up.
vec3 aurora(vec3 ro, vec3 rd, float maxT) {
  if (uAurora <= 0.001) return vec3(0.0);
  float rb = uRadius + ${AURORA_BOTTOM.toFixed(1)}, rt = uRadius + ${AURORA_TOP.toFixed(1)};
  vec2 outer = raySphere(ro, rd, rt);
  if (outer.y <= 0.0) return vec3(0.0);
  float t0 = max(outer.x, 0.0), t1 = min(outer.y, maxT);
  // Skip the inner part if the ray dips below the bottom of the layer.
  vec2 inner = raySphere(ro, rd, rb);
  if (inner.x > 0.0) t1 = min(t1, inner.x);
  t1 = min(t1, t0 + 900.0);
  if (t1 <= t0) return vec3(0.0);
  vec3 e1 = normalize(cross(uMagPole, abs(uMagPole.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 e2 = cross(uMagPole, e1);
  const int N = 28;
  float seg = (t1 - t0) / float(N);
  vec3 sum = vec3(0.0);
  for (int i = 0; i < N; i++) {
    vec3 p = ro + rd * (t0 + seg * (float(i) + 0.5));
    float r = length(p);
    vec3 d = p / r;
    float mlat = degrees(asin(clamp(dot(d, uMagPole), -1.0, 1.0)));
    float am = abs(mlat);
    if (am < 58.0 || am > 82.0) continue;
    float phi = atan(dot(d, e1), dot(d, e2));
    // Ribbon centre wanders with magnetic longitude and time.
    // Two thin curtains that fold and drift along the oval.
    float fold = sin(phi * 3.0 + uTime * 0.05) * 1.6
               + (vnoise(vec3(phi * 5.0, uTime * 0.03, sign(mlat))) - 0.5) * 3.0
               + (vnoise(vec3(phi * 22.0, uTime * 0.08, 3.1)) - 0.5) * 0.9;
    float c1 = 69.0 + fold, c2 = 71.2 + fold * 0.7;
    float band = exp(-pow((am - c1) / 0.35, 2.0)) + 0.6 * exp(-pow((am - c2) / 0.3, 2.0));
    float hf = clamp((r - rb) / (rt - rb), 0.0, 1.0);
    // Fine vertical rays (field-aligned), shimmering.
    float rays = 0.25 + 0.75 * pow(vnoise(vec3(phi * 420.0, hf * 2.0, uTime * 0.6)), 1.5);
    float patchy = smoothstep(0.3, 0.7, vnoise(vec3(phi * 7.0, uTime * 0.02, 1.7)));
    vec3 green = vec3(0.12, 1.0, 0.42) * exp(-hf * 4.0) * smoothstep(0.0, 0.04, hf);
    vec3 red = vec3(0.75, 0.10, 0.40) * smoothstep(0.5, 1.0, hf) * 0.1;
    // Only on the night side of the planet.
    float dark = 1.0 - smoothstep(-0.25, 0.05, dot(d, uSunDir));
    sum += (green + red) * band * rays * patchy * dark * seg;
  }
  return sum * 0.12 * uAurora;
}

void main() {
  #include <logdepthbuf_fragment>
  vec3 rd = normalize(vWorld - uCamPos);
  vec3 T;
  vec3 col = scatter(uCamPos, rd, 1e9, T);
  // Hidden behind the (drawn) planet?
  vec2 tp = raySphere(uCamPos - uPlanetC, rd, uPlanetR);
  bool open = tp.x < 0.0 || tp.x > 1e8;
  if (open) {
    float d = dot(rd, uSunDir);
    // Sun disc, a tight glow around it and a wide soft halo, all dimmed and
    // reddened by the air in front.
    float disc = smoothstep(0.99985, 0.99993, d) * 40.0;
    float glow = pow(max(d, 0.0), 1800.0) * 3.0 + pow(max(d, 0.0), 220.0) * 0.12 + pow(max(d, 0.0), 14.0) * 0.012;
    // A soft halo around the moon, stronger near full.
    float dm = max(dot(rd, uMoonDir), 0.0);
    float moonHalo = (pow(dm, 3000.0) * 0.25 + pow(dm, 300.0) * 0.03) * uMoonGlow;
    col += T * (disc + glow) + moonHalo;
  }
  col += aurora(uCamPos, rd, open ? 1e9 : tp.x) * T;
  float a = 1.0 - (T.r + T.g + T.b) / 3.0;
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Star field + Milky Way (NASA Deep Star Maps, celestial coordinates), turning with sidereal time. */
const starsFragment = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D uStarsTex;
uniform float uStars;
uniform float uGmst;      // radians
uniform vec3 uCamPos;
varying vec3 vWorld;
void main() {
  #include <logdepthbuf_fragment>
  vec3 d = normalize(vWorld - uCamPos);
  float dec = asin(clamp(d.y, -1.0, 1.0));
  float ra = atan(d.x, d.z) + uGmst;          // Earth-fixed longitude -> right ascension
  vec2 uv = vec2(fract(0.5 - ra / (2.0 * PI)), 0.5 - dec / PI);
  vec3 c = pow(texture2D(uStarsTex, uv).rgb, vec3(2.2)) * 2.2;
  gl_FragColor = vec4(c * uStars, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** The moon: NASA LROC colour map, lit by the sun so the phase is right; near side faces Earth. */
const moonFragment = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D uMoonTex;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;    // from Earth towards the moon
uniform float uVisible;
varying vec3 vWorld;
varying vec3 vNormal2;
void main() {
  #include <logdepthbuf_fragment>
  vec3 n = normalize(vNormal2);
  vec3 f = -uMoonDir;                                    // towards Earth = lon 0
  vec3 up = normalize(vec3(0.0, 1.0, 0.0) - f * f.y + vec3(1e-5, 0.0, 0.0));
  vec3 right = cross(up, f);
  float lon = atan(dot(n, right), dot(n, f));
  float lat = asin(clamp(dot(n, up), -1.0, 1.0));
  vec3 alb = pow(texture2D(uMoonTex, vec2(0.5 + lon / (2.0 * PI), 0.5 - lat / PI)).rgb, vec3(2.2));
  float lit = max(dot(n, uSunDir), 0.0);
  vec3 c = alb * (lit * 2.6 + 0.012);                    // + a hint of earthshine
  gl_FragColor = vec4(c * uVisible, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const moonVertex = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vWorld;
varying vec3 vNormal2;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vNormal2 = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
  #include <logdepthbuf_vertex>
}
`;

function skyTexture(t: Texture) {
  t.colorSpace = NoColorSpace; // decoded in the shaders
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  t.anisotropy = 4;
  t.flipY = false; // v = 0 is the top row (project convention)
  return t;
}

/** Atmosphere shell (sky, sun, auroras), the moon, and the star field behind them. */
export class Sky {
  readonly group = new Group();
  readonly material: ShaderMaterial;
  private starMaterial: ShaderMaterial;
  private moonMaterial: ShaderMaterial;
  private starSphere: Mesh;
  private moon: Mesh;
  private moonDir = new Vector3(0, 0, 1);

  constructor(atmo: AtmosphereUniforms, assetBase: string) {
    const radius = atmo.uAtmoRadius.value * 1.01;
    const magPole = new Vector3();
    {
      const la = (MAG_POLE.lat * Math.PI) / 180, lo = (MAG_POLE.lon * Math.PI) / 180;
      magPole.set(Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo));
    }
    this.material = new ShaderMaterial({
      vertexShader: skyVertex,
      fragmentShader: skyFragment,
      uniforms: {
        ...atmo,
        uCamPos: { value: new Vector3() },
        uTime: { value: 0 },
        uMagPole: { value: magPole },
        uAurora: { value: 0 },
        uMoonDir: { value: this.moonDir },
        uMoonGlow: { value: 0 },
      },
      side: BackSide,
      transparent: true,
      depthWrite: false,
      blending: CustomBlending,
      blendSrc: OneFactor,
      blendDst: OneMinusSrcAlphaFactor,
    });
    const shell = new Mesh(new SphereGeometry(radius, 96, 48), this.material);
    shell.renderOrder = 10;
    shell.frustumCulled = false;

    // Stars and the Milky Way on a big sphere that follows the camera.
    const loader = new TextureLoader();
    this.starMaterial = new ShaderMaterial({
      vertexShader: skyVertex,
      fragmentShader: starsFragment,
      uniforms: { uStarsTex: { value: null }, uStars: { value: 0 }, uGmst: { value: 0 }, uCamPos: { value: new Vector3() } },
      side: BackSide,
      depthWrite: false,
    });
    this.starSphere = new Mesh(new SphereGeometry(8000, 64, 32), this.starMaterial);
    this.starSphere.renderOrder = -10;
    this.starSphere.frustumCulled = false;
    this.starSphere.visible = false;
    loader.load(`${assetBase}/stars.webp`, (t) => {
      this.starMaterial.uniforms.uStarsTex.value = skyTexture(t);
      this.starSphere.visible = true;
    });

    // The moon.
    this.moonMaterial = new ShaderMaterial({
      vertexShader: moonVertex,
      fragmentShader: moonFragment,
      uniforms: { uMoonTex: { value: null }, uSunDir: atmo.uSunDir, uMoonDir: { value: this.moonDir }, uVisible: { value: 1 } },
      // Writes depth so the star sphere behind it can never paint over it,
      // whatever order the two are drawn in.
      depthWrite: true,
    });
    const moonR = MOON_DISTANCE * Math.tan((MOON_ANGULAR_DEG * Math.PI) / 360);
    this.moon = new Mesh(new SphereGeometry(moonR, 48, 24), this.moonMaterial);
    this.moon.renderOrder = -5;
    this.moon.frustumCulled = false;
    this.moon.visible = false;
    loader.load(`${assetBase}/moon.jpg`, (t) => {
      this.moonMaterial.uniforms.uMoonTex.value = skyTexture(t);
      this.moon.visible = true;
    });

    this.group.add(this.starSphere, this.moon, shell);
  }

  /**
   * @param sunDir   unit vector towards the sun (world)
   * @param moonDir  unit vector towards the moon (world)
   * @param gmstRad  Greenwich sidereal angle, turns the star field
   * @param time     seconds, animates auroras
   */
  update(camPos: Vector3, sunDir: Vector3, moonDir: Vector3, gmstRad: number, time: number, moonPhase = 1) {
    (this.material.uniforms.uCamPos.value as Vector3).copy(camPos);
    this.material.uniforms.uTime.value = time;
    const up = camPos.clone().normalize();
    const sunUp = up.dot(sunDir);
    // Stars (and auroras) come out as the sky above the camera darkens.
    const day = Math.max(0, Math.min(1, (sunUp + 0.2) / 0.2));
    const space = Math.max(0, Math.min(1, (camPos.length() - WORLD_RADIUS - 30) / 200));
    this.starMaterial.uniforms.uStars.value = Math.max(1 - day, space);
    this.starMaterial.uniforms.uGmst.value = gmstRad;
    (this.starMaterial.uniforms.uCamPos.value as Vector3).copy(camPos);
    this.starSphere.position.copy(camPos);
    this.material.uniforms.uAurora.value = Math.max(0, Math.min(1, (0.02 - sunUp) / 0.2));
    // Moon: placed far away in its direction, following the camera.
    this.moonDir.copy(moonDir);
    this.moon.position.copy(camPos).addScaledVector(moonDir, MOON_DISTANCE);
    this.moonMaterial.uniforms.uVisible.value = 1;
    this.material.uniforms.uMoonGlow.value = moonPhase * (1 - day);
  }

  dispose() {
    this.group.traverse((o) => {
      const m = o as Mesh;
      m.geometry?.dispose();
      (m.material as ShaderMaterial | undefined)?.dispose?.();
    });
    (this.starMaterial.uniforms.uStarsTex.value as Texture | null)?.dispose();
    (this.moonMaterial.uniforms.uMoonTex.value as Texture | null)?.dispose();
  }
}
