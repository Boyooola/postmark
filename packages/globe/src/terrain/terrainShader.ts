import { bendChunk } from "../bend";
import { atmosphereChunk, cloudChunk, equirectSampleChunk, geoChunk, heightChunk, noiseChunk } from "../shaders/chunks";

export const terrainVertex = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
${geoChunk}
${heightChunk}
${atmosphereChunk}
attribute vec4 aChunk;        // face-space x0, y0, size, face index
uniform mat3 uFaces[6];
uniform sampler2D uSurface;   // land, lake, river, ice
uniform vec3 uCamPos;
uniform float uElevScale;     // metres -> world units (includes exaggeration)
uniform float uSkirt;
varying vec3 vDir;
varying vec3 vWorld;
// Atmosphere terms vary smoothly, so they are computed per vertex (much cheaper
// than per pixel): sunlight reaching the ground, and the view ray's in-scatter
// and transmittance (aerial perspective).
varying vec3 vSun;
varying vec3 vInscatter;
varying vec3 vTransmit;
${bendChunk}

vec3 spherify(vec3 p) {
  vec3 p2 = p * p;
  return vec3(
    p.x * sqrt(max(0.0, 1.0 - p2.y * 0.5 - p2.z * 0.5 + p2.y * p2.z / 3.0)),
    p.y * sqrt(max(0.0, 1.0 - p2.z * 0.5 - p2.x * 0.5 + p2.z * p2.x / 3.0)),
    p.z * sqrt(max(0.0, 1.0 - p2.x * 0.5 - p2.y * 0.5 + p2.x * p2.y / 3.0)));
}

void main() {
  vec2 st = aChunk.xy + position.xy * aChunk.z;
  int face = int(aChunk.w + 0.5);
  vec3 dir = normalize(spherify(uFaces[face] * vec3(st, 1.0)));
  vec2 uv = dirToUV(dir);
  float h = heightAt(dir).x;
  float lake = textureLod(uSurface, uv, 0.0).g;
  float disp = lake > 0.5 ? h : max(h, 0.0);
  float r = uRadius + disp * uElevScale - position.z * aChunk.z * uSkirt;
  vec3 world = bendWorld(dir * r);
  vDir = dir;
  vWorld = world;
  vSun = sunlightAt(dir * (r + 0.05));
  vec3 toV = world - uCamPos;
  float d = length(toV);
  vInscatter = scatter(uCamPos, toV / max(d, 1e-6), d, vTransmit);
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  #include <logdepthbuf_vertex>
}
`;

export const terrainFragment = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${geoChunk}
${heightChunk}
${equirectSampleChunk}
${noiseChunk}
${atmosphereChunk}
${cloudChunk}
uniform sampler2D uSurface;
uniform sampler2D uAux;       // R = night lights (Black Marble, sRGB-encoded)
uniform vec3 uMoonDir;
uniform float uMoonPhase;     // illuminated fraction 0..1
uniform sampler2D uColor;     // satellite true colour, sRGB
uniform vec3 uSatGrade;       // brightness, saturation, contrast of the satellite colour
uniform sampler2D uCoast;     // signed km to the sea coast: (v*255 - 128) * 0.5, > 0 at sea
uniform vec4 uStepRad;        // angular sample step: base map, detail, fine, sharp windows
uniform float uElevScale;
uniform vec3 uCamPos;
uniform float uHaze;
uniform float uNightLights;
uniform float uInscatter;
uniform float uTime;          // seconds, for waves and surf
uniform float uPixelAngle;    // radians per screen pixel (for anti-aliasing procedural detail)
uniform float uRelief;        // 0..1 strength of synthetic relief detail
uniform float uAmbient;       // sky fill-light strength (low = deep, contrasty shadows)
varying vec3 vDir;
varying vec3 vWorld;
varying vec3 vSun;
varying vec3 vInscatter;
varying vec3 vTransmit;

// ---------------------------------------------------------------- relief detail
// Ridged multifractal noise: sharp crests and branching gullies, a cheap stand-in
// for erosion below the DEM's ~2 km resolution. Octaves smaller than ~2 pixels
// are faded out so the surface never shimmers.
float ridge(vec3 p) { float n = 1.0 - abs(vnoise(p) * 2.0 - 1.0); return n * n; }
// Domain warp: bends the ridges so they branch like drainage, not like scales.
// Computed once per pixel and shared by the three erosion() taps.
vec3 erosionWarp(vec3 p) {
  return vec3(vnoise(p * 0.45 + 3.1), vnoise(p * 0.45 + 7.7), vnoise(p * 0.45 + 1.3)) * 1.6;
}
float erosion(vec3 p, float pix) {
  float freq = 1.7, amp = 1.0, sum = 0.0, norm = 0.0, prev = 1.0;
  for (int i = 0; i < 5; i++) {
    float fade = clamp((1.0 / (freq * pix) - 2.0) * 0.5, 0.0, 1.0);
    float r = ridge(p * freq + float(i) * 17.3);
    sum += r * amp * mix(1.0, prev, 0.6) * fade;
    norm += amp;
    prev = r;
    freq *= 2.07;
    amp *= 0.52;
  }
  return sum / norm;
}

// ---------------------------------------------------------------- terrain shadows
// March from the surface towards the sun through the heightmap; any terrain the
// ray passes under casts a shadow. Steps grow geometrically, so long evening
// shadows of big ranges reach tens of km while nearby ridges stay crisp.
// Returns sun visibility 0..1 with a soft penumbra.
uniform float uShadowSoft;
float terrainShadow(vec3 start, float pix) {
  float topR = uRadius + 8900.0 * uElevScale;
  float t = max(pix * 1.5, 0.006);
  float vis = 1.0;
  for (int i = 0; i < 16; i++) {
    vec3 p = start + uSunDir * t;
    float r = length(p);
    if (r > topR) break;
    vec3 d = p / r;
    float surf = uRadius + max(heightAt(d).x, 0.0) * uElevScale;
    vis = min(vis, clamp((r - surf) / (t * uShadowSoft), 0.0, 1.0));
    if (vis <= 0.001) return 0.0;
    t *= 1.55;
  }
  return vis;
}

// ---------------------------------------------------------------- palette
// Land colour starts from the real satellite colour (graded in main()), then adds
// what a ~5 km image can't resolve: bare rock on steep faces, lighter crests and
// darker gullies, and snow that follows the actual ridges.
vec3 landColor(vec3 sat, float h, float alat, float slope, float n1, float n2, float ridgeV) {
  vec3 rockDk  = vec3(0.060, 0.054, 0.048);
  vec3 rockLt  = vec3(0.170, 0.155, 0.140);
  vec3 snow    = vec3(0.640, 0.670, 0.720);

  vec3 c = sat * (0.86 + 0.28 * n2);
  float rocky = clamp(smoothstep(0.45, 1.1, slope) * 0.85 + smoothstep(2600.0, 4200.0, h) * 0.35, 0.0, 1.0);
  vec3 rock = mix(rockDk, rockLt, clamp(ridgeV * 1.3 + n2 * 0.3 - 0.15, 0.0, 1.0));
  c = mix(c, rock, rocky * 0.75);
  // Snow above a latitude-dependent snowline, sliding off steep faces.
  float snowLine = mix(5200.0, 1100.0, smoothstep(20.0, 72.0, alat)) + (n1 - 0.5) * 700.0;
  float snowAmt = smoothstep(snowLine - 300.0, snowLine + 300.0, h + ridgeV * 500.0)
                  * (1.0 - smoothstep(0.9, 1.6, slope) * 0.7);
  return mix(c, snow, snowAmt);
}

// ---------------------------------------------------------------- ocean
// Gradient of a few travelling waves in the local tangent plane (world units).
vec2 waveSlope(vec2 q, float t, float pix) {
  vec2 g = vec2(0.0);
  const int N = 5;
  vec2 dirs[N] = vec2[](vec2(0.81, 0.59), vec2(-0.37, 0.93), vec2(0.97, -0.24), vec2(-0.71, -0.70), vec2(0.15, 0.99));
  float lambdas[N] = float[](0.42, 0.27, 0.17, 0.11, 0.07);
  for (int i = 0; i < N; i++) {
    float k = 6.2831853 / lambdas[i];
    float fade = clamp((lambdas[i] / pix - 3.0) * 0.4, 0.0, 1.0);
    float ph = k * dot(dirs[i], q) - t * sqrt(9.8 * k) * 0.05 + float(i) * 1.7;
    g += dirs[i] * cos(ph) * 0.035 * fade;
  }
  return g;
}

void main() {
  #include <logdepthbuf_fragment>
  vec3 dir = normalize(vDir);
  vec2 ll = dirToLatLon(dir);
  float alat = abs(ll.x) * 180.0 / PI;
  vec3 north = normalize(vec3(0.0, 1.0, 0.0) - dir * dir.y + vec3(1e-6, 0.0, 0.0));
  vec3 east = normalize(cross(north, dir));
  vec3 toCam = uCamPos - vWorld;
  float camDist = length(toCam);
  float pix = max(camDist * uPixelAngle, 1e-4); // world units covered by one pixel here

  // Real elevation and slope from the heightmap (finite differences along the
  // local east/north great circles, one texel apart).
  vec2 hw = heightAtLL(ll);
  float h = hw.x;
  float stp = hw.y > 2.5 ? uStepRad.w : (hw.y > 1.5 ? uStepRad.z : (hw.y > 0.5 ? uStepRad.y : uStepRad.x));
  // Never step finer than a screen pixel: keeps sharp data from shimmering far away.
  stp = max(stp, pix / uRadius * 0.75);
  // Neighbours along the local east/north great circles, in lat/lon directly
  // (no per-tap trigonometry).
  float dLon = stp / max(cos(ll.x), 0.02);
  float hE = heightAtLL(ll + vec2(0.0, dLon)).x;
  float hW = heightAtLL(ll - vec2(0.0, dLon)).x;
  float hN = heightAtLL(ll + vec2(stp, 0.0)).x;
  float hS = heightAtLL(ll - vec2(stp, 0.0)).x;
  float arc = 2.0 * stp * uRadius;
  float sE = (max(hE, 0.0) - max(hW, 0.0)) * uElevScale / arc;
  float sN = (max(hN, 0.0) - max(hS, 0.0)) * uElevScale / arc;
  float slope = length(vec2(sE, sN));

  vec4 surf = sampleEquirect(uSurface, dir);
  vec4 aux = sampleEquirect(uAux, dir);
  vec2 shoreF = (sampleEquirect(uCoast, dir).rg * 255.0 - 128.0) * 0.5;
  float coastKm = shoreF.x;   // > 0 at sea
  float lakeKm = shoreF.y;    // > 0 on lakes
  float land = surf.r, lake = surf.g, river = surf.b, ice = surf.a;
  // Sea vs land from the coast distance field (smooth, sub-texel accurate) rather
  // than the coarse land mask, so coastlines are clean curves, not stair steps.
  float edgeW = max(0.12, pix * 6.371 * 0.8);
  float seaMask = 1.0 - smoothstep(0.35, 0.65, land);
  float sea = coastKm < 6.0 && coastKm > -6.0 ? smoothstep(-edgeW, edgeW, coastKm) : seaMask;
  float lakeW = abs(lakeKm) < 6.0 ? smoothstep(-edgeW, edgeW, lakeKm) : smoothstep(0.35, 0.65, lake);
  float water = clamp(max(sea, lakeW), 0.0, 1.0);
  // Distance to whichever shore this water belongs to (sea coast or lake shore).
  float shoreKm = lakeW > sea ? lakeKm : coastKm;

  // Synthetic relief: strongest in mountains, gentle in hills, none on plains/sea.
  vec3 wp = dir * uRadius;
  float mountain = clamp(smoothstep(300.0, 2500.0, h) * 0.8 + smoothstep(0.06, 0.45, slope) * 0.7, 0.0, 1.0);
  // Less synthetic relief where real ~610 m data is present (level 2).
  float reliefM = (50.0 + 430.0 * mountain) * uRelief * (1.0 - water) * (hw.y > 2.5 ? 0.12 : (hw.y > 1.5 ? 0.4 : 1.0));
  float e0 = 0.0, ridgeV = 0.0;
  if (reliefM > 1.0 && pix < 0.6) {
    float de = max(pix * 1.5, 0.02);
    vec3 warp = erosionWarp(wp);
    e0 = erosion(wp + warp, pix);
    float eE = erosion(wp + warp + east * de, pix);
    float eN = erosion(wp + warp + north * de, pix);
    float s = reliefM * uElevScale / de;
    sE += (eE - e0) * s;
    sN += (eN - e0) * s;
    ridgeV = e0;
  }
  vec3 nLand = normalize(dir - east * sE * 1.15 - north * sN * 1.15);
  float slopeAll = length(vec2(sE, sN));

  // ------------------------------------------------ albedo
  float n1 = fbm(dir * 140.0);
  float n2 = fbm(dir * 2600.0);
  // Satellite colour, graded towards the darker, muted Geographical Adventures look.
  vec3 sat = pow(sampleEquirect(uColor, dir).rgb, vec3(2.2));
  float satLum = dot(sat, vec3(0.2126, 0.7152, 0.0722));
  sat = max(mix(vec3(satLum), sat, uSatGrade.y), 0.0);
  sat = pow(sat * 4.0, vec3(uSatGrade.z)) / 4.0 * uSatGrade.x;
  vec3 lc = landColor(sat, h, alat, slopeAll, n1, n2, ridgeV);
  vec3 iceCol = vec3(0.66, 0.71, 0.78) * (0.9 + 0.1 * fbm(dir * 600.0));
  lc = mix(lc, iceCol, smoothstep(0.3, 0.7, ice));
  // Beaches: a thin pale band on low ground right at the sea.
  float beach = (1.0 - smoothstep(0.0, 0.25, -coastKm)) * (1.0 - smoothstep(5.0, 30.0, h)) * (1.0 - ice);
  lc = mix(lc, vec3(0.30, 0.26, 0.18), beach * 0.5);
  // Rivers: thin dark water lines.
  lc = mix(lc, vec3(0.015, 0.045, 0.075), smoothstep(0.3, 0.9, river) * 0.75);

  // Ocean colour: deep navy, a little lighter over shelves and in a thin coastal band.
  float depth = lakeW > sea ? 60.0 : max(-h, 0.0);
  vec3 deep    = vec3(0.0030, 0.0090, 0.032);
  vec3 mid     = vec3(0.0050, 0.0160, 0.050);
  vec3 shallow = vec3(0.0100, 0.0380, 0.070);
  vec3 wc = mix(shallow, mid, smoothstep(0.0, 120.0, depth));
  wc = mix(wc, deep, smoothstep(150.0, 3000.0, depth));
  wc = mix(wc, vec3(0.020, 0.070, 0.085), (1.0 - smoothstep(0.0, 0.9, coastKm)) * sea * 0.6);

  // ------------------------------------------------ water surface
  vec2 q = vec2(dot(wp, east), dot(wp, north));
  vec2 ws = waveSlope(q, uTime, pix);
  float rip = vnoise(vec3(q * 38.0, uTime * 0.35)) - 0.5;
  vec3 nWater = normalize(dir - east * (ws.x + rip * 0.02) - north * (ws.y + rip * 0.02));

  // Surf: a crisp white line on the shore and thin wave crests rolling in towards
  // it, broken into segments. Widths follow the pixel size so they stay readable
  // from cruise altitude and don't shimmer.
  float foam = 0.0;
  float pk = pix * 6.371;                       // km per pixel
  if (water > 0.01 && shoreKm < 12.0 && pk < 2.5) {
    float w = max(0.14, pk * 1.6);              // line width, km
    float spacing = max(1.0, pk * 8.0);         // distance between crests, km
    float breakup = vnoise(dir * 5200.0 + vec3(uTime * 0.03));
    float shoreLine = 1.0 - smoothstep(w * 0.6, w * 1.8, shoreKm);
    float f = fract(shoreKm / spacing + uTime * 0.22 + breakup * 0.35);
    float crest = smoothstep(1.0 - w / spacing * 1.6, 1.0, f) * (1.0 - smoothstep(0.96, 1.0, f));
    crest *= (1.0 - smoothstep(spacing * 0.4, spacing * 3.2, shoreKm)) * smoothstep(0.35, 0.6, breakup);
    foam = max(shoreLine * (0.8 + 0.2 * breakup), crest);
    foam *= 1.0 - smoothstep(1.2, 2.5, pk);
  }

  vec3 albedo = mix(lc, wc, water);
  albedo = mix(albedo, vec3(0.70, 0.74, 0.76), foam * water);
  vec3 n = normalize(mix(nLand, nWater, water));

  // ------------------------------------------------ lighting
  vec3 V = toCam / camDist;
  vec3 sunCol = vSun * 2.9;
  float cloudHere = uCloudCover > 0.0 ? cloudDensity(dir) : 0.0;
  sunCol *= 1.0 - 0.6 * cloudHere;
  float ndl = max(dot(n, uSunDir), 0.0);
  float day = smoothstep(-0.15, 0.2, dot(dir, uSunDir));
  float shadow = 1.0;
  if (ndl > 0.0 && day > 0.0) {
    float surfR = uRadius + (water > 0.5 ? max(h, 0.0) * (1.0 - sea) : max(h, 0.0)) * uElevScale;
    shadow = terrainShadow(dir * (surfR + max(pix * 0.5, 0.002)), pix);
  }
  ndl *= shadow;
  // Sky light from above (less in deep gullies), plus a little bounce.
  float ao = mix(0.55, 1.0, clamp(ridgeV * 1.6, 0.0, 1.0)) * (1.0 - water) + water;
  vec3 skyAmb = uAmbient * vec3(0.12, 0.14, 0.18) * (0.55 + 0.45 * dot(n, dir)) * day * ao;
  // Moonlight: a faint cool light from the moon's direction, scaled by its phase.
  float moonUp = max(dot(n, uMoonDir), 0.0) * smoothstep(-0.05, 0.1, dot(dir, uMoonDir));
  vec3 moonLight = vec3(0.05, 0.065, 0.095) * uMoonPhase * moonUp * (1.0 - day);
  vec3 col = albedo * (sunCol * ndl + skyAmb + moonLight + vec3(0.007, 0.009, 0.014));

  // Water: sun glitter on the waves and a sky reflection that grows at grazing angles.
  vec3 Hh = normalize(uSunDir + V);
  float nh = max(dot(nWater, Hh), 0.0);
  float fres = 0.02 + 0.98 * pow(1.0 - max(dot(nWater, V), 0.0), 5.0);
  float glitter = pow(nh, 900.0) * 9.0 + pow(nh, 120.0) * 0.6 + pow(nh, 18.0) * 0.03;
  vec3 skyRefl = vec3(0.03, 0.05, 0.10) * day;
  col += water * (1.0 - foam) * (sunCol * glitter * shadow + skyRefl * fres * 0.5);

  // ------------------------------------------------ city lights
  // Real night lights (NASA Black Marble 2016). Warm sodium orange at the edges,
  // whiter in bright centres; up close the ~5 km texture is broken into points so
  // towns read as clusters of lights. They switch on through dusk.
  float night = 1.0 - smoothstep(-0.10, 0.05, dot(dir, uSunDir));
  float lightsV = aux.r;
  // City cores saturate the source image; a steep curve keeps them bright but
  // lets the suburbs and towns fall off, so lights read as points, not blobs.
  float rad = pow(lightsV, 2.8) * 0.32;
  float near = 1.0 - smoothstep(4.0, 30.0, camDist);
  vec3 cell = floor(dir * 24000.0);
  float sparkle = mix(1.0, 0.25 + 1.5 * hash13(cell), near);
  vec3 lightCol = mix(vec3(1.0, 0.58, 0.24), vec3(1.0, 0.85, 0.62), smoothstep(0.35, 0.85, lightsV));
  col += lightCol * rad * sparkle * night * uNightLights * (1.0 - water * 0.95) * (1.0 - 0.6 * cloudHere);

  // ------------------------------------------------ aerial perspective
  col = col * mix(vec3(1.0), vTransmit, uHaze) + vInscatter * uInscatter;

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
