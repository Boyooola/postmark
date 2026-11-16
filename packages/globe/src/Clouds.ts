import { DoubleSide, Mesh, ShaderMaterial, SphereGeometry, Vector3 } from "three";
import type { AtmosphereUniforms } from "./atmosphereParams";
import { cloudRadius, type CloudUniforms } from "./cloudParams";
import { atmosphereChunk, cloudChunk, noiseChunk } from "./shaders/chunks";

const vertex = /* glsl */ `
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

const fragment = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${noiseChunk}
${atmosphereChunk}
${cloudChunk}
uniform vec3 uCamPos;
varying vec3 vWorld;
void main() {
  #include <logdepthbuf_fragment>
  vec3 dir = normalize(vWorld);
  float dens = cloudDensity(dir);
  if (dens < 0.01) discard;

  // Self-shadowing: how much cloud lies a little way towards the sun.
  vec3 sunT = normalize(uSunDir - dir * dot(uSunDir, dir) + vec3(1e-5));
  float towardSun = cloudDensity(normalize(dir + sunT * 0.006));
  float lit = 1.0 - 0.45 * towardSun;

  vec3 sun = sunlightAt(vWorld) * 1.7;
  float day = smoothstep(-0.15, 0.2, dot(dir, uSunDir));
  vec3 ambient = vec3(0.45, 0.55, 0.72) * 0.35 * day + vec3(0.015, 0.02, 0.03);
  bool below = length(uCamPos) < length(vWorld);
  float underside = below ? 0.62 : 1.0;
  vec3 col = vec3(1.0) * (sun * lit * underside + ambient);

  vec3 toFrag = vWorld - uCamPos;
  float dist = length(toFrag);
  vec3 T;
  vec3 inscatter = scatter(uCamPos, toFrag / dist, dist, T);
  col = col * T + inscatter * 0.5;

  // Fade out right in front of the camera so flying through is not a flat wall.
  // A thin layer seen edge-on would read as a hard white band: fade grazing views.
  float grazing = abs(dot(toFrag / dist, dir));
  float alpha = dens * 0.75 * smoothstep(0.08, 0.9, dist) * smoothstep(0.02, 0.22, grazing);
  gl_FragColor = vec4(col * alpha, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** A thin procedural cloud layer at CLOUD_ALTITUDE_M. */
export class Clouds {
  readonly mesh: Mesh<SphereGeometry, ShaderMaterial>;

  constructor(atmo: AtmosphereUniforms, clouds: CloudUniforms) {
    const material = new ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      uniforms: { ...atmo, ...clouds, uCamPos: { value: new Vector3() } },
      transparent: true,
      premultipliedAlpha: true,
      depthWrite: false,
      side: DoubleSide,
    });
    this.mesh = new Mesh(new SphereGeometry(cloudRadius(), 384, 192), material);
    this.mesh.renderOrder = 20;
    this.mesh.frustumCulled = false;
  }

  update(camPos: Vector3) {
    (this.mesh.material.uniforms.uCamPos.value as Vector3).copy(camPos);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
