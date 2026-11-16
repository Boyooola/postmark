import {
  AdditiveBlending,
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  DodecahedronGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  TorusGeometry,
  Vector3,
} from "three";
import { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  WORLD_RADIUS,
  elevationToUnits,
  latLonToDirection,
  type Landmark,
  type LandmarkKind,
} from "@postmark/game-core";

/**
 * Landmarks "pop out" of the globe: real structure heights are scaled up by
 * DISPLAY_SCALE (on top of the terrain's vertical exaggeration) so a 330 m
 * tower is readable from a plane flying at several kilometres.
 */
export const LANDMARK_DISPLAY_SCALE = 4;
const MIN_HEIGHT_UNITS = 0.35;

const KIND_COLOR: Record<LandmarkKind, number> = {
  building: 0xe8e1d0,
  monument: 0xd9c28a,
  ruins: 0xc9a46a,
  mountain: 0xff5a3c,
  waterfall: 0x7fd6ff,
  natural: 0x8fcf6a,
  bridge: 0xd8513a,
};

function placeholder(kind: LandmarkKind, h: number): Object3D {
  const mat = new MeshStandardMaterial({ color: KIND_COLOR[kind], roughness: 0.7 });
  const g = new Group();
  switch (kind) {
    case "building": {
      const base = new Mesh(new BoxGeometry(h * 0.35, h * 0.25, h * 0.35), mat);
      base.position.y = h * 0.125;
      const spire = new Mesh(new ConeGeometry(h * 0.12, h * 0.8, 6), mat);
      spire.position.y = h * 0.25 + h * 0.4;
      g.add(base, spire);
      break;
    }
    case "monument": {
      const plinth = new Mesh(new BoxGeometry(h * 0.3, h * 0.3, h * 0.3), mat);
      plinth.position.y = h * 0.15;
      const figure = new Mesh(new CylinderGeometry(h * 0.06, h * 0.1, h * 0.7, 8), mat);
      figure.position.y = h * 0.65;
      g.add(plinth, figure);
      break;
    }
    case "ruins": {
      const pyr = new Mesh(new ConeGeometry(h * 0.6, h, 4), mat);
      pyr.position.y = h * 0.5;
      pyr.rotation.y = Math.PI / 4;
      g.add(pyr);
      break;
    }
    case "mountain": {
      const pole = new Mesh(new CylinderGeometry(h * 0.015, h * 0.015, h, 6), new MeshStandardMaterial({ color: 0xdddddd }));
      pole.position.y = h * 0.5;
      const flag = new Mesh(new BoxGeometry(h * 0.35, h * 0.2, h * 0.01), mat);
      flag.position.set(h * 0.18, h * 0.88, 0);
      g.add(pole, flag);
      break;
    }
    case "waterfall": {
      const fall = new Mesh(new BoxGeometry(h * 0.6, h, h * 0.1), mat);
      fall.position.y = h * 0.5;
      g.add(fall);
      break;
    }
    case "bridge": {
      const arch = new Mesh(new TorusGeometry(h * 0.5, h * 0.05, 6, 24, Math.PI), mat);
      arch.position.y = 0;
      g.add(arch);
      break;
    }
    default: {
      const rock = new Mesh(new DodecahedronGeometry(h * 0.45, 0), mat);
      rock.position.y = h * 0.3;
      rock.scale.y = 0.7;
      g.add(rock);
    }
  }
  return g;
}

export interface LandmarkMarker {
  landmark: Landmark;
  root: Object3D;
  label: CSS2DObject;
  position: Vector3;
}

export class Landmarks {
  readonly group = new Group();
  readonly markers: LandmarkMarker[] = [];
  private loader = new GLTFLoader();

  constructor(list: Landmark[], private surfaceM: (lat: number, lon: number) => number) {
    const beamMat = new MeshBasicMaterial({
      color: 0xffe9a8,
      transparent: true,
      opacity: 0.22,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    for (const lm of list) {
      const up = latLonToDirection(lm.lat, lm.lon);
      const position = up.clone().multiplyScalar(WORLD_RADIUS + elevationToUnits(this.groundOf(lm)));
      const root = new Group();
      root.position.copy(position);
      root.quaternion.copy(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), up));

      const realH = lm.structureHeightM || 120;
      const h = Math.max(elevationToUnits(realH) * LANDMARK_DISPLAY_SCALE, MIN_HEIGHT_UNITS);
      const model = placeholder(lm.kind, h);
      root.add(model);

      // A soft light beam makes landmarks findable from far away.
      const beam = new Mesh(new CylinderGeometry(0.03, 0.03, 6, 8, 1, true), beamMat);
      beam.position.y = 3 + h;
      beam.renderOrder = 30;
      root.add(beam);

      const el = document.createElement("div");
      el.className = "pm-landmark-label";
      el.innerHTML = `<strong>${lm.name}</strong><span>${lm.city}, ${lm.country}</span>`;
      const label = new CSS2DObject(el);
      label.position.set(0, h + 0.4, 0);
      label.visible = false;
      root.add(label);

      if (lm.model) this.loadModel(lm, root, model);

      this.group.add(root);
      this.markers.push({ landmark: lm, root, label, position });
    }
  }

  private groundOf(lm: Landmark) {
    return lm.kind === "mountain" && lm.summitM ? lm.summitM : this.surfaceM(lm.lat, lm.lon);
  }

  /** Re-seat markers on the ground after sharper terrain streams in. */
  reposition() {
    for (const m of this.markers) {
      const up = latLonToDirection(m.landmark.lat, m.landmark.lon);
      m.position.copy(up).multiplyScalar(WORLD_RADIUS + elevationToUnits(this.groundOf(m.landmark)));
      m.root.position.copy(m.position);
    }
  }

  private loadModel(lm: Landmark, root: Object3D, placeholderObj: Object3D) {
    // Models are authored in real metres (docs/blender-pipeline.md).
    this.loader.load(
      lm.model!,
      (gltf) => {
        const s = elevationToUnits(1) * LANDMARK_DISPLAY_SCALE;
        gltf.scene.scale.setScalar(s);
        root.remove(placeholderObj);
        root.add(gltf.scene);
      },
      undefined,
      () => console.warn(`[landmarks] could not load ${lm.model}, keeping placeholder`),
    );
  }

  /** Show labels only for nearby landmarks, to keep the screen clean. */
  update(camPos: Vector3) {
    for (const m of this.markers) {
      const d = m.position.distanceTo(camPos);
      m.label.visible = d < 40;
      (m.label.element as HTMLElement).style.opacity = String(Math.max(0, Math.min(1, (40 - d) / 12)));
    }
  }
}
