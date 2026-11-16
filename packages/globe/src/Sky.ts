import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  CustomBlending,
  Group,
  Mesh,
  OneFactor,
  OneMinusSrcAlphaFactor,
  Points,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from "three";
import type { AtmosphereUniforms } from "./atmosphereParams";
import { atmosphereChunk } from "./shaders/chunks";

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
uniform vec3 uCamPos;
varying vec3 vWorld;
void main() {
  #include <logdepthbuf_fragment>
  vec3 rd = normalize(vWorld - uCamPos);
  vec3 T;
  vec3 col = scatter(uCamPos, rd, 1e9, T);
  // Sun disc, dimmed and reddened by the air in front of it.
  vec2 tp = raySphere(uCamPos - uPlanetC, rd, uPlanetR);
  if (tp.x < 0.0 || tp.x > 1e8) {
    float d = dot(rd, uSunDir);
    col += T * (smoothstep(0.99985, 0.99995, d) * 40.0 + pow(max(d, 0.0), 2000.0) * 2.0);
  }
  float a = 1.0 - (T.r + T.g + T.b) / 3.0;
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Atmosphere shell (sky from below, glowing limb from orbit) + a star field behind it. */
export class Sky {
  readonly group = new Group();
  readonly material: ShaderMaterial;
  private stars: Points;
  private starMaterial!: ShaderMaterial;

  constructor(atmo: AtmosphereUniforms) {
    const radius = atmo.uAtmoRadius.value * 1.01;
    this.material = new ShaderMaterial({
      vertexShader: skyVertex,
      fragmentShader: skyFragment,
      uniforms: { ...atmo, uCamPos: { value: new Vector3() } },
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

    // Stars: fixed points on a big sphere, drawn first.
    const n = 4000;
    const p = new Float32Array(n * 3);
    const c = new Float32Array(n * 3);
    let seed = 1234567;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < n; i++) {
      const u = rnd() * 2 - 1, t = rnd() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      p.set([s * Math.cos(t) * 6000, u * 6000, s * Math.sin(t) * 6000], i * 3);
      const b = Math.pow(rnd(), 3) * 0.9 + 0.1;
      const warm = rnd();
      c.set([b * (0.85 + 0.15 * warm), b * 0.9, b * (1.0 - 0.2 * warm)], i * 3);
    }
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(p, 3));
    g.setAttribute("color", new BufferAttribute(c, 3));
    const starMat = new ShaderMaterial({
      vertexShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        attribute vec3 color; varying vec3 vC; uniform float uStars;
        void main(){ vC = color * uStars; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_PointSize = 1.0 + 1.5 * color.g;
        #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <logdepthbuf_pars_fragment>
        varying vec3 vC;
        void main(){
        #include <logdepthbuf_fragment>
        gl_FragColor = vec4(vC, 1.0); }`,
      uniforms: { uStars: { value: 1 } },
      depthWrite: false,
      blending: AdditiveBlending,
      transparent: true,
    });
    this.starMaterial = starMat;
    this.stars = new Points(g, starMat);
    this.stars.renderOrder = -10;
    this.stars.frustumCulled = false;
    this.group.add(this.stars, shell);
  }

  update(camPos: Vector3, sunDir: Vector3) {
    (this.material.uniforms.uCamPos.value as Vector3).copy(camPos);
    // Stars fade out when the sky above the camera is lit (or we are high in space).
    const up = camPos.clone().normalize();
    const day = Math.max(0, Math.min(1, (up.dot(sunDir) + 0.12) / 0.25));
    const space = Math.max(0, Math.min(1, (camPos.length() - 1030) / 200));
    this.starMaterial.uniforms.uStars.value = Math.max(1 - day, space);
    this.stars.position.copy(camPos); // stars at infinity
  }

  dispose() {
    this.group.traverse((o) => {
      const m = o as Mesh;
      m.geometry?.dispose();
      (m.material as ShaderMaterial | undefined)?.dispose?.();
    });
  }
}
