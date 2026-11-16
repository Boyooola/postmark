/**
 * GLSL shared by the terrain and sky shaders. Planet centred at the origin,
 * +Y north, lon 0 on +Z (same conventions as @postmark/game-core/geo).
 * Uses PI from three's <common> chunk.
 */

export const geoChunk = /* glsl */ `
vec2 dirToLatLon(vec3 d) { return vec2(asin(clamp(d.y, -1.0, 1.0)), atan(d.x, d.z)); }
vec2 dirToUV(vec3 d) {
  vec2 ll = dirToLatLon(d);
  return vec2(ll.y / (2.0 * PI) + 0.5, 0.5 - ll.x / PI);
}
`;

/** Fragment-only: needs screen-space derivatives. */
export const equirectSampleChunk = /* glsl */ `
// Seam-free sampling of an equirectangular texture with mipmaps
// (Tarini's trick: pick whichever u has continuous derivatives).
vec4 sampleEquirect(sampler2D t, vec3 d) {
  vec2 uv = dirToUV(d);
  vec2 uvB = vec2(fract(uv.x + 0.5) - 0.5, uv.y);
  vec2 dxA = dFdx(uv), dyA = dFdy(uv);
  vec2 dxB = dFdx(uvB), dyB = dFdy(uvB);
  bool useB = abs(dxB.x) + abs(dyB.x) < abs(dxA.x) + abs(dyA.x);
  return textureGrad(t, uv, useB ? dxB : dxA, useB ? dyB : dyA);
}
`;

export const noiseChunk = /* glsl */ `
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash13(i), hash13(i + vec3(1,0,0)), f.x),
                 mix(hash13(i + vec3(0,1,0)), hash13(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash13(i + vec3(0,0,1)), hash13(i + vec3(1,0,1)), f.x),
                 mix(hash13(i + vec3(0,1,1)), hash13(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; }
  return s;
}
`;

/** Single-scattering atmosphere (Rayleigh + Mie), a few samples per ray. */
export const atmosphereChunk = /* glsl */ `
uniform vec3 uSunDir;
uniform float uRadius;
uniform float uAtmoRadius;
uniform float uScaleHeight;
uniform vec3 uBetaR;
uniform float uBetaM;
uniform float uSunIntensity;

vec2 raySphere(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  float h = b * b - c;
  if (h < 0.0) return vec2(1e9, -1e9);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}
float atmoDensity(vec3 p) { return exp(-max(length(p) - uRadius, 0.0) / uScaleHeight); }

float opticalDepthToSun(vec3 p) {
  float L = raySphere(p, uSunDir, uAtmoRadius).y;
  float seg = max(L, 0.0) / 4.0;
  float od = 0.0;
  for (int i = 0; i < 4; i++) od += atmoDensity(p + uSunDir * seg * (float(i) + 0.5)) * seg;
  return od;
}

// 1 if the sun is visible from p, 0 if the planet is in the way (soft edge).
float sunVisibility(vec3 p) {
  float t = dot(p, uSunDir);
  if (t > 0.0) return 1.0;
  float d = length(p - uSunDir * t);
  return smoothstep(uRadius - 0.3, uRadius + 1.2, d);
}

// Sunlight colour arriving at p (reddens at sunset, fades on the night side).
vec3 sunlightAt(vec3 p) {
  float vis = sunVisibility(p);
  if (vis <= 0.0) return vec3(0.0);
  float od = opticalDepthToSun(p);
  return exp(-(uBetaR + uBetaM) * od) * vis;
}

// In-scattered light and transmittance along a ray, up to maxT.
vec3 scatter(vec3 ro, vec3 rd, float maxT, out vec3 transmittance) {
  transmittance = vec3(1.0);
  vec2 ta = raySphere(ro, rd, uAtmoRadius);
  float t0 = max(ta.x, 0.0);
  float t1 = min(ta.y, maxT);
  vec2 tp = raySphere(ro, rd, uRadius * 0.9995);
  if (tp.x > 0.0) t1 = min(t1, tp.x);
  if (t1 <= t0) return vec3(0.0);
  const int N = 8;
  float seg = (t1 - t0) / float(N);
  vec3 sumR = vec3(0.0), sumM = vec3(0.0);
  float odView = 0.0;
  for (int i = 0; i < N; i++) {
    vec3 p = ro + rd * (t0 + seg * (float(i) + 0.5));
    float d = atmoDensity(p) * seg;
    odView += d;
    float sunUp = dot(normalize(p), uSunDir);
    float shadow = sunVisibility(p);
    // Cheap multiple-scattering stand-in: keeps twilight skies from going black.
    float twilight = smoothstep(-0.30, 0.10, sunUp) * 0.06;
    vec3 viewAtt = exp(-(uBetaR + uBetaM) * odView);
    sumR += viewAtt * d * twilight;
    if (shadow <= 0.0) continue;
    float odSun = opticalDepthToSun(p);
    vec3 att = exp(-(uBetaR + uBetaM) * (odView + odSun)) * shadow;
    sumR += att * d;
    sumM += att * d;
  }
  float mu = dot(rd, uSunDir);
  float phaseR = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
  float g = 0.76;
  float phaseM = 3.0 / (8.0 * PI) * ((1.0 - g * g) * (1.0 + mu * mu)) /
                 ((2.0 + g * g) * pow(max(1.0 + g * g - 2.0 * g * mu, 1e-4), 1.5));
  transmittance = exp(-(uBetaR + uBetaM) * odView);
  return uSunIntensity * (sumR * uBetaR * phaseR + sumM * uBetaM * phaseM);
}
`;
