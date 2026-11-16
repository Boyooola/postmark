import { atmosphereChunk, equirectSampleChunk, geoChunk, noiseChunk } from "../shaders/chunks";

export const terrainVertex = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
${geoChunk}
attribute vec4 aChunk;        // face-space x0, y0, size, face index
uniform mat3 uFaces[6];
uniform sampler2D uHeight;    // metres, R channel, equirectangular
uniform sampler2D uSurface;   // land, lake, river, ice
uniform float uRadius;
uniform float uElevScale;     // metres -> world units (includes exaggeration)
uniform float uSkirt;
varying vec3 vDir;
varying vec3 vWorld;

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
  float h = textureLod(uHeight, uv, 0.0).r;
  float lake = textureLod(uSurface, uv, 0.0).g;
  float disp = lake > 0.5 ? h : max(h, 0.0);
  float r = uRadius + disp * uElevScale - position.z * aChunk.z * uSkirt;
  vec3 world = dir * r;
  vDir = dir;
  vWorld = world;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  #include <logdepthbuf_vertex>
}
`;

export const terrainFragment = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${geoChunk}
${equirectSampleChunk}
${noiseChunk}
${atmosphereChunk}
uniform sampler2D uHeight;
uniform sampler2D uSurface;
uniform sampler2D uAux;
uniform vec2 uHeightTexel;    // 1/width, 1/height
uniform float uElevScale;
uniform vec3 uCamPos;
uniform float uHaze;
uniform float uNightLights;
uniform float uInscatter;
varying vec3 vDir;
varying vec3 vWorld;

vec3 landColor(float h, float alat, float slope, float desert, vec3 dir) {
  vec3 forest   = vec3(0.075, 0.17, 0.065);
  vec3 green    = vec3(0.17, 0.29, 0.10);
  vec3 dryGrass = vec3(0.42, 0.40, 0.24);
  vec3 sand     = vec3(0.78, 0.63, 0.42);
  vec3 rock     = vec3(0.38, 0.34, 0.31);
  vec3 tundra   = vec3(0.34, 0.35, 0.27);
  vec3 c = mix(forest, green, smoothstep(8.0, 32.0, alat));
  c = mix(c, tundra, smoothstep(55.0, 70.0, alat));
  float n = fbm(dir * 900.0);
  c *= 0.85 + 0.3 * n;
  c = mix(c, dryGrass, smoothstep(700.0, 2200.0, h) * 0.65);
  c = mix(c, rock, smoothstep(1800.0, 3800.0, h));
  c = mix(c, sand * (0.9 + 0.2 * n), desert);
  c = mix(c, rock, smoothstep(0.45, 0.9, slope) * 0.75);
  float snowLine = mix(5300.0, 700.0, smoothstep(22.0, 75.0, alat)) + (n - 0.5) * 500.0;
  float snow = smoothstep(snowLine - 250.0, snowLine + 250.0, h) * (1.0 - 0.6 * smoothstep(0.8, 1.4, slope));
  return mix(c, vec3(0.80, 0.83, 0.88), snow);
}

void main() {
  #include <logdepthbuf_fragment>
  vec3 dir = normalize(vDir);
  vec2 uv = dirToUV(dir);
  vec2 ll = dirToLatLon(dir);
  float alat = abs(ll.x) * 180.0 / PI;

  // Real elevation and surface slope from the heightmap
  float h  = texture(uHeight, uv).r;
  float hE = texture(uHeight, uv + vec2(uHeightTexel.x, 0.0)).r;
  float hW = texture(uHeight, uv - vec2(uHeightTexel.x, 0.0)).r;
  float hN = texture(uHeight, uv - vec2(0.0, uHeightTexel.y)).r;
  float hS = texture(uHeight, uv + vec2(0.0, uHeightTexel.y)).r;
  float cosLat = max(cos(ll.x), 0.03);
  float dxE = 2.0 * uHeightTexel.x * 2.0 * PI * uRadius * cosLat;
  float dyN = 2.0 * uHeightTexel.y * PI * uRadius;
  float sE = (max(hE, 0.0) - max(hW, 0.0)) * uElevScale / dxE;
  float sN = (max(hN, 0.0) - max(hS, 0.0)) * uElevScale / dyN;
  vec3 north = normalize(vec3(0.0, 1.0, 0.0) - dir * dir.y + vec3(1e-6, 0.0, 0.0));
  vec3 east = normalize(cross(north, dir));
  vec3 nLand = normalize(dir - east * sE - north * sN);
  float slope = length(vec2(sE, sN)); // rise over run in rendered (exaggerated) space

  // Synthetic detail: the DEM is ~18 km per sample, so add fine shading
  // (normals only, geometry stays true to the data). Stronger in mountains,
  // fades out with distance.
  float camDist = length(vWorld - uCamPos);
  float detailAmt = (0.12 + 0.55 * smoothstep(300.0, 3000.0, h) + 0.4 * smoothstep(0.2, 0.8, slope))
                    * (1.0 - smoothstep(25.0, 120.0, camDist)) * step(0.0, h);
  if (detailAmt > 0.001) {
    vec3 q = dir * 1400.0;
    float e = 0.35;
    float d0 = fbm(q);
    float dE = fbm(q + east * e) - d0;
    float dN = fbm(q + north * e) - d0;
    nLand = normalize(nLand - (east * dE + north * dN) * (detailAmt * 1.4 / e));
  }

  vec4 surf = sampleEquirect(uSurface, dir);
  vec4 aux = sampleEquirect(uAux, dir);
  float land = surf.r, lake = surf.g, river = surf.b, ice = surf.a;
  float water = clamp(max(1.0 - smoothstep(0.35, 0.65, land), smoothstep(0.35, 0.65, lake)), 0.0, 1.0);

  // Albedo
  vec3 lc = landColor(h, alat, slope, aux.g, dir);
  vec3 iceCol = vec3(0.78, 0.83, 0.90) * (0.92 + 0.08 * fbm(dir * 400.0));
  lc = mix(lc, iceCol, smoothstep(0.3, 0.7, ice));
  float depth = lake > 0.5 ? 25.0 : max(-h, 0.0);
  vec3 shallow = vec3(0.06, 0.36, 0.42);
  vec3 deep = vec3(0.006, 0.035, 0.11);
  vec3 wc = mix(shallow, deep, pow(clamp(depth / 4000.0, 0.0, 1.0), 0.4));
  lc = mix(lc, mix(shallow, deep, 0.35), smoothstep(0.2, 0.8, river) * 0.85);
  vec3 albedo = mix(lc, wc, water);
  vec3 n = normalize(mix(nLand, dir, water));

  // Lighting
  vec3 V = normalize(uCamPos - vWorld);
  vec3 sunCol = sunlightAt(vWorld + dir * 0.05) * 2.3;
  float ndl = max(dot(n, uSunDir), 0.0);
  float day = smoothstep(-0.15, 0.2, dot(dir, uSunDir));
  vec3 ambient = vec3(0.35, 0.45, 0.65) * 0.12 * day + vec3(0.02, 0.03, 0.05);
  vec3 col = albedo * (sunCol * ndl + ambient);

  // Water: sun glint + sky reflection
  vec3 Hh = normalize(uSunDir + V);
  float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, V), 0.0), 5.0);
  float spec = pow(max(dot(n, Hh), 0.0), 500.0) * 1.0 + pow(max(dot(n, Hh), 0.0), 60.0) * 0.008;
  col += water * (sunCol * spec + vec3(0.25, 0.4, 0.65) * fres * 0.35 * day);

  // City lights on the night side
  float night = 1.0 - smoothstep(-0.12, 0.08, dot(dir, uSunDir));
  // Far away: a soft glow. Up close: the glow breaks into individual points.
  float density = aux.r;
  float glow = pow(density, 2.4) * 0.6;
  vec3 cell = floor(dir * 26000.0);
  float pts = step(1.0 - density * density * 0.09, hash13(cell)) * (0.6 + 0.8 * hash13(cell + 7.0));
  float near = 1.0 - smoothstep(4.0, 40.0, camDist);
  float lights = mix(glow, pts * 1.4 + glow * 0.05, near);
  // The light map is ~10 km per pixel; keep it off mountainsides and high ground.
  lights *= mix(1.0, 0.12, smoothstep(350.0, 1200.0, h)) * (1.0 - 0.8 * smoothstep(0.2, 0.55, slope));
  col += lights * vec3(1.0, 0.72, 0.38) * night * uNightLights * (1.0 - water * 0.9);

  // Aerial perspective
  vec3 toFrag = vWorld - uCamPos;
  float dist = length(toFrag);
  vec3 T;
  vec3 inscatter = scatter(uCamPos, toFrag / dist, dist, T);
  col = col * mix(vec3(1.0), T, uHaze) + inscatter * uInscatter;

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
