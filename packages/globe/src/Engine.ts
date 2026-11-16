import {
  ACESFilmicToneMapping,
  Color,
  DirectionalLight,
  HemisphereLight,
  Object3D,
  PerspectiveCamera,
  Quaternion,
  Scene,
  SRGBColorSpace,
  Timer,
  Vector3,
  WebGLRenderer,
} from "three";
import { CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import {
  Deliveries,
  FLIGHT,
  FlightModel,
  TerrainHeights,
  bearingDeg,
  distanceKm,
  latLonToDirection,
  nearest,
  type DropResult,
  type FlightTelemetry,
  type Landmark,
  type LatLon,
} from "@postmark/game-core";
import { loadGeoAssets, type GeoAssets, type Progress } from "./assets";
import { createAtmosphereUniforms } from "./atmosphereParams";
import { WorldBend } from "./bend";
import { Input, type ActionKey } from "./Input";
import { Landmarks } from "./Landmarks";
import { Trail, createPlaneModel, loadPlaneModel, type PlaneModel } from "./Plane";
import { Sky } from "./Sky";
import { Clouds } from "./Clouds";
import { createCloudUniforms } from "./cloudParams";
import { TerrainLOD } from "./terrain/TerrainLOD";
import { Balloons } from "./Balloons";
import { Parcels } from "./Parcels";
import { DetailTerrain } from "./terrain/DetailTerrain";

export interface HudTarget {
  city: string;
  country: string;
  distanceKm: number;
  /** direction relative to the plane's heading, -180..180 (0 = straight ahead) */
  relativeDeg: number;
}

export interface NearestInfo {
  name: string;
  detail: string;
  distanceKm: number;
  relativeDeg: number;
}

export interface HudState {
  telemetry: FlightTelemetry;
  targets: HudTarget[];
  delivered: number;
  /** seconds since the run started */
  elapsedS: number;
  /** developer overlay only */
  landmark: NearestInfo | null;
  localTime: string;
  timeScale: number;
  fps: number;
  chunks: number;
  streaming: boolean;
}

export type GameEvent =
  | { type: "delivered"; city: string; country: string; distanceKm: number; delivered: number }
  | { type: "missed"; city: string; country: string; distanceKm: number };

export interface EngineOptions {
  container: HTMLElement;
  /** URL prefix of the baked geo assets, e.g. "/geo" */
  assetBase: string;
  onProgress?: Progress;
  onHud?: (s: HudState) => void;
  onEvent?: (e: GameEvent) => void;
  onAction?: (a: ActionKey) => void;
  start?: { lat: number; lon: number; headingDeg: number; altitudeM?: number; utcHours?: number };
  /** glTF of the player's plane (default /models/aircraft/mailplane.glb) */
  planeUrl?: string;
}

/** Chase camera, Geographical Adventures style: high and behind, so the curve of the Earth shows. */
const CAMERA = { back: 3.0, up: 2.3, lookAhead: 2.6, lookUp: -1.2, fov: 62, boostFov: 74 };
const PLANE_SCALE = 2.5;

const DEFAULT_START = { lat: 47.2, lon: 6.6, headingDeg: 140, altitudeM: FLIGHT.cruiseAltitudeM, utcHours: 14.6 };
const SUN_DECLINATION_DEG = 12;

export class Engine {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  private labels: CSS2DRenderer;
  private input: Input;
  private timer = new Timer();
  private raf = 0;
  private disposed = false;

  private assets!: GeoAssets;
  private terrain!: TerrainLOD;
  private heights!: TerrainHeights;
  private detail: DetailTerrain | null = null;
  private fine: DetailTerrain | null = null;
  private sky!: Sky;
  private clouds!: Clouds;
  private cloudUniforms = createCloudUniforms();
  private landmarks!: Landmarks;
  private flight!: FlightModel;
  private plane: PlaneModel = createPlaneModel();
  private trails = [new Trail(160, 0.0045 * PLANE_SCALE), new Trail(160, 0.0045 * PLANE_SCALE)];
  private deliveries!: Deliveries;
  private balloons!: Balloons;
  private parcels!: Parcels;
  private runTime = 0;
  private sun = new Vector3();
  /** Render-only curved horizon (bend.ts). */
  readonly bend = new WorldBend();
  private bendSaved: { obj: Object3D; pos: Vector3; quat: Quaternion }[] = [];
  private sunLight = new DirectionalLight(0xffffff, 3);
  private hemi = new HemisphereLight(0xbfd8ff, 0x3a3020, 0.6);

  private utcHours = DEFAULT_START.utcHours;
  timeScale = 60; // game seconds per real second (1 day = 24 min)
  private lastSpawn: { lat: number; lon: number; headingDeg: number; altitudeM: number; utcHours: number } = { ...DEFAULT_START };
  private hudTimer = 0;
  private frames = 0;
  private fpsTimer = 0;
  private fps = 0;
  private paused = false;

  private constructor(private opts: EngineOptions) {
    const { container } = opts;
    this.renderer = new WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.setClearColor(new Color(0x000000));
    container.appendChild(this.renderer.domElement);

    this.labels = new CSS2DRenderer();
    this.labels.setSize(container.clientWidth, container.clientHeight);
    Object.assign(this.labels.domElement.style, { position: "absolute", inset: "0", pointerEvents: "none" });
    container.appendChild(this.labels.domElement);

    this.camera = new PerspectiveCamera(CAMERA.fov, container.clientWidth / container.clientHeight, 0.01, 20000);
    this.plane.root.scale.setScalar(PLANE_SCALE);

    this.input = new Input();
    this.input.onAction((a) => this.handleAction(a));
    window.addEventListener("resize", this.onResize);
  }

  static async create(opts: EngineOptions): Promise<Engine> {
    const e = new Engine(opts);
    if (!e.renderer.capabilities.isWebGL2) throw new Error("Postmark needs a browser with WebGL 2.");
    await e.init();
    return e;
  }

  private async init() {
    const { opts } = this;
    this.assets = await loadGeoAssets(opts.assetBase, this.renderer, opts.onProgress);
    if (this.disposed) return;
    const atmo = createAtmosphereUniforms(this.sun, this.bend);
    this.heights = new TerrainHeights(this.assets.heights);
    const surface = (lat: number, lon: number) => this.heights.surface(lat, lon);

    if (this.assets.tiles) {
      this.detail = new DetailTerrain(opts.assetBase, this.assets.tiles, this.heights, this.assets.floatLinear, (w) => {
        if (w) this.terrain?.setDetailWindow(w);
        this.landmarks?.reposition();
      });
    }
    if (this.assets.tilesFine) {
      // ~610 m terrain where it exists (mountain regions); off elsewhere.
      this.fine = new DetailTerrain(
        opts.assetBase,
        this.assets.tilesFine,
        this.heights,
        this.assets.floatLinear,
        (w) => {
          this.terrain?.setFineWindow(w);
          this.landmarks?.reposition();
        },
        (lat, lon) => this.heights.sample(lat, lon, 1),
        (w) => (this.heights.fine = w),
        true,
      );
    }
    this.terrain = new TerrainLOD(
      {
        height: this.assets.heightTexture,
        heightSize: this.assets.heights,
        detail: this.detail?.texture ?? this.assets.heightTexture,
        fine: this.fine?.texture ?? this.assets.heightTexture,
        surface: this.assets.surfaceTexture,
        aux: this.assets.auxTexture,
        color: this.assets.colorTexture,
        coast: this.assets.coastTexture,
      },
      atmo,
      this.cloudUniforms,
    );
    this.sky = new Sky(atmo);
    this.clouds = new Clouds(atmo, this.cloudUniforms);
    this.clouds.mesh.visible = this.cloudUniforms.uCloudCover.value > 0;
    this.landmarks = new Landmarks(this.assets.landmarks, surface);
    this.flight = new FlightModel(surface);
    this.deliveries = new Deliveries(this.assets.cities);
    this.balloons = new Balloons(surface);
    this.parcels = new Parcels(surface, (where) => this.onParcelLanded(where));

    this.scene.add(
      this.terrain.mesh, this.sky.group, this.clouds.mesh, this.landmarks.group, this.balloons.group,
      this.parcels.group, this.plane.root, this.sunLight, this.sunLight.target, this.hemi,
    );
    for (const t of this.trails) this.scene.add(t.mesh);

    const s = { ...DEFAULT_START, ...opts.start };
    this.utcHours = s.utcHours ?? DEFAULT_START.utcHours;
    if (this.detail) {
      opts.onProgress?.("Streaming terrain around you", 0.95);
      const deg = this.assets.tiles!.degreesPerTile;
      await this.detail.load((s.lon + 180) / deg, (90 - s.lat) / deg);
      if (this.fine) {
        const d8 = this.assets.tilesFine!.degreesPerTile;
        await this.fine.load((s.lon + 180) / d8, (90 - s.lat) / d8);
      }
      if (this.disposed) return;
    }
    this.spawn(s.lat, s.lon, s.headingDeg, s.altitudeM);
    this.snapCamera();
    this.deliveries.start(s);
    this.balloons.sync(this.deliveries.targets);

    // Swap in the Blender model when it arrives (the placeholder flies meanwhile).
    void loadPlaneModel(`${opts.planeUrl ?? "/models/aircraft/mailplane.glb"}`).then((model) => {
      if (!model || this.disposed) return;
      this.scene.remove(this.plane.root);
      model.root.scale.setScalar(PLANE_SCALE);
      this.plane = model;
      this.scene.add(model.root);
    });

    opts.onProgress?.("Ready", 1);
    // Compile shaders before the first frame to avoid a hitch.
    this.updateSun();
    this.terrain.update(this.camera);
    this.renderer.compile(this.scene, this.camera);
    this.timer.connect(document);
    this.loop();
  }

  /** True while a new high-resolution terrain window is loading. */
  get streaming(): boolean {
    return (this.detail?.loading ?? false) || (this.fine?.loading ?? false);
  }

  get landmarkList(): Landmark[] {
    return this.assets?.landmarks ?? [];
  }

  // ------------------------------------------------------------------ actions
  spawn(lat: number, lon: number, headingDeg: number, altitudeM: number = FLIGHT.cruiseAltitudeM) {
    this.lastSpawn = { lat, lon, headingDeg, altitudeM, utcHours: this.utcHours };
    this.flight.spawn(lat, lon, headingDeg, altitudeM);
    this.trails.forEach((t) => t.reset());
    this.detail?.update(lat, lon, true);
    this.fine?.update(lat, lon, true);
  }

  /** Developer shortcut: fly towards a landmark from ~250 km south of it. */
  teleportToLandmark(id: string) {
    const lm = this.assets.landmarks.find((l) => l.id === id);
    if (!lm) return;
    this.spawn(Math.max(-89, lm.lat - 2.2), lm.lon, 0);
    this.snapCamera();
  }

  /** Drop a parcel from the plane (Space). */
  dropParcel() {
    const p = this.flight.position.clone().addScaledVector(this.flight.position.clone().normalize(), -0.15);
    this.parcels.drop(p, this.flight.velocity);
  }

  private onParcelLanded(where: LatLon) {
    const r: DropResult | null = this.deliveries.resolveDrop(where);
    if (!r) return;
    const base = { city: r.target.city, country: r.target.country, distanceKm: r.distanceKm };
    if (r.hit) {
      this.balloons.sync(this.deliveries.targets);
      this.opts.onEvent?.({ type: "delivered", ...base, delivered: this.deliveries.delivered });
    } else {
      this.opts.onEvent?.({ type: "missed", ...base });
    }
  }

  setTimeScale(s: number) {
    this.timeScale = Math.max(0, Math.min(3600 * 4, s));
  }

  /** 0 = clear skies, 1 = overcast. */
  setCloudCover(c: number) {
    this.cloudUniforms.uCloudCover.value = Math.max(0, Math.min(1, c));
    if (this.clouds) this.clouds.mesh.visible = this.cloudUniforms.uCloudCover.value > 0;
  }

  setPaused(p: boolean) {
    this.paused = p;
  }

  /** Testing / screenshots: put the camera somewhere specific. */
  debugView(lat: number, lon: number, altitudeM: number, headingDeg: number, utcHours?: number) {
    if (utcHours !== undefined) this.utcHours = utcHours;
    this.spawn(lat, lon, headingDeg, altitudeM);
    this.snapCamera();
  }

  private handleAction(a: ActionKey) {
    if (a === "drop") this.dropParcel();
    if (a === "timeFaster") this.setTimeScale(this.timeScale === 0 ? 60 : this.timeScale * 4);
    if (a === "timeSlower") this.setTimeScale(this.timeScale <= 15 ? 0 : this.timeScale / 4);
    if (a === "respawn") {
      this.spawn(this.lastSpawn.lat, this.lastSpawn.lon, this.lastSpawn.headingDeg, this.lastSpawn.altitudeM);
      this.snapCamera();
    }
    this.opts.onAction?.(a);
  }

  // --------------------------------------------------------------------- loop
  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.1);
    const t = this.timer.getElapsed();
    if (!this.paused) {
      this.utcHours = (this.utcHours + (dt * this.timeScale) / 3600 + 24) % 24;
      this.cloudUniforms.uCloudTime.value += dt * Math.max(1, this.timeScale / 60);
      this.flight.update(dt, this.input.read(dt));
      this.parcels.update(dt);
      this.runTime += dt;
    }
    if (this.detail) {
      const p = this.flight.telemetry();
      this.detail.update(p.lat, p.lon);
      // The fine window waits for the detail window it falls back on.
      if (!this.detail.loading) this.fine?.update(p.lat, p.lon);
    }
    this.updateSun();
    this.updatePlane(t);
    this.updateChaseCamera(dt);

    this.terrain.setFrame(t, this.renderer.domElement.height, this.camera);
    this.terrain.update(this.camera);
    this.sky.update(this.camera.position, this.sun);
    this.clouds.update(this.camera.position);
    this.landmarks.update(this.camera.position);
    this.balloons.update(this.camera.position, t);
    this.bendProps();
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
    this.unbendProps();
    this.tickHud(dt);
  };

  /** Move props onto the curved (drawn) world for this frame; real poses are restored after drawing. */
  private bendProps() {
    this.bend.update(this.camera.position);
    if (this.bend.curvature <= 1) return;
    let i = 0;
    for (const g of [this.landmarks.group, this.balloons.group, this.parcels.group]) {
      for (const obj of g.children) {
        const s = (this.bendSaved[i] ??= { obj, pos: new Vector3(), quat: new Quaternion() });
        s.obj = obj;
        s.pos.copy(obj.position);
        s.quat.copy(obj.quaternion);
        this.bend.place(obj, s.pos, s.quat);
        i++;
      }
    }
    this.bendSaved.length = i;
  }

  private unbendProps() {
    for (const s of this.bendSaved) {
      s.obj.position.copy(s.pos);
      s.obj.quaternion.copy(s.quat);
    }
  }

  /** Curved-horizon strength: 1 = real Earth, higher = smaller-looking planet. */
  setCurvature(c: number) {
    this.bend.curvature = Math.max(1, c);
  }

  private updateSun() {
    const subsolarLon = (12 - this.utcHours) * 15;
    latLonToDirection(SUN_DECLINATION_DEG, subsolarLon, this.sun);
    this.sunLight.position.copy(this.flight?.position ?? new Vector3()).addScaledVector(this.sun, 50);
    this.sunLight.target.position.copy(this.flight?.position ?? new Vector3());
    const up = this.flight ? this.flight.position.clone().normalize() : new Vector3(0, 1, 0);
    const day = Math.max(0, Math.min(1, (up.dot(this.sun) + 0.1) / 0.3));
    this.sunLight.intensity = 3.2 * day;
    this.hemi.intensity = 0.15 + 0.6 * day;
    // Simple eye adaptation: open up at dusk and at night.
    const camUp = this.camera.position.clone().normalize();
    const camDay = Math.max(0, Math.min(1, (camUp.dot(this.sun) + 0.05) / 0.35));
    this.renderer.toneMappingExposure = 0.9 + (1 - camDay) * 0.7;
  }

  private updatePlane(t: number) {
    const { root, propeller, wingTips } = this.plane;
    root.position.copy(this.flight.position);
    root.quaternion.copy(this.flight.orientation);
    propeller.rotation.z = t * 60;
    root.updateMatrixWorld(true);
    wingTips.forEach((tip, i) => {
      const p = tip.getWorldPosition(new Vector3());
      this.trails[i].update(p, this.camera, t);
    });
  }

  private chaseFwd = new Vector3();
  private chaseUp = new Vector3();
  private desired = new Vector3();
  private lookAt = new Vector3();
  private chaseTarget(out: Vector3, look: Vector3) {
    const f = this.flight;
    const up = this.chaseUp.copy(f.position).normalize();
    // Follow the heading, and only a little of the climb, so the horizon stays calm.
    const fwd = this.chaseFwd.copy(f.heading).multiplyScalar(Math.cos(f.climb * 0.4)).addScaledVector(up, Math.sin(f.climb * 0.4)).normalize();
    out.copy(f.position).addScaledVector(fwd, -CAMERA.back).addScaledVector(up, CAMERA.up);
    look.copy(f.position).addScaledVector(fwd, CAMERA.lookAhead).addScaledVector(up, CAMERA.lookUp);
    return up;
  }

  private updateChaseCamera(dt: number) {
    const up = this.chaseTarget(this.desired, this.lookAt);
    const k = 1 - Math.exp(-dt * 4);
    this.camera.position.lerp(this.desired, k);
    this.camera.up.copy(up);
    this.camera.lookAt(this.lookAt);
    const targetFov = this.flight.boosting ? CAMERA.boostFov : CAMERA.fov;
    this.camera.fov += (targetFov - this.camera.fov) * (1 - Math.exp(-dt * 2.5));
    this.camera.updateProjectionMatrix();
  }

  private snapCamera() {
    const up = this.chaseTarget(this.desired, this.lookAt);
    this.camera.position.copy(this.desired);
    this.camera.up.copy(up);
    this.camera.lookAt(this.lookAt);
  }

  private tickHud(dt: number) {
    this.frames++;
    this.fpsTimer += dt;
    if (this.fpsTimer >= 0.5) {
      this.fps = Math.round(this.frames / this.fpsTimer);
      this.frames = 0;
      this.fpsTimer = 0;
    }
    this.hudTimer += dt;
    if (this.hudTimer < 0.1 || !this.opts.onHud) return;
    this.hudTimer = 0;
    const tel = this.flight.telemetry();
    const rel = (b: number) => ((b - tel.headingDeg + 540) % 360) - 180;
    const lm = nearest(tel, this.assets.landmarks);
    const local = (this.utcHours + tel.lon / 15 + 48) % 24;
    const hh = Math.floor(local), mm = Math.floor((local - hh) * 60);
    this.opts.onHud({
      telemetry: tel,
      targets: this.deliveries.targets.map((t) => ({
        city: t.city,
        country: t.country,
        distanceKm: distanceKm(tel, t),
        relativeDeg: rel(bearingDeg(tel, t)),
      })),
      delivered: this.deliveries.delivered,
      elapsedS: this.runTime,
      landmark: lm && {
        name: lm.item.name,
        detail: `${lm.item.city}, ${lm.item.country}`,
        distanceKm: lm.distanceKm,
        relativeDeg: rel(lm.bearingDeg),
      },
      localTime: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`,
      timeScale: this.timeScale,
      fps: this.fps,
      chunks: this.terrain.chunksDrawn,
      streaming: this.streaming,
    });
  }

  private onResize = () => {
    const c = this.opts.container;
    this.camera.aspect = c.clientWidth / c.clientHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(c.clientWidth, c.clientHeight);
    this.labels.setSize(c.clientWidth, c.clientHeight);
  };

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener("resize", this.onResize);
    this.input.dispose();
    this.timer.dispose();
    this.terrain?.dispose();
    this.detail?.dispose();
    this.fine?.dispose();
    this.sky?.dispose();
    this.clouds?.dispose();
    this.assets?.heightTexture.dispose();
    this.assets?.surfaceTexture.dispose();
    this.assets?.auxTexture.dispose();
    this.assets?.coastTexture.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labels.domElement.remove();
  }
}
