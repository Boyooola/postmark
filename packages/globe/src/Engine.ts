import {
  ACESFilmicToneMapping,
  Color,
  DirectionalLight,
  HemisphereLight,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Timer,
  Vector3,
  WebGLRenderer,
} from "three";
import { CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  FlightModel,
  WORLD_RADIUS,
  latLonToDirection,
  nearest,
  type City,
  type FlightTelemetry,
  type Landmark,
} from "@postmark/game-core";
import { loadGeoAssets, type GeoAssets, type Progress } from "./assets";
import { createAtmosphereUniforms } from "./atmosphereParams";
import { Input, type ActionKey } from "./Input";
import { Landmarks } from "./Landmarks";
import { Trail, createPlaneModel } from "./Plane";
import { Sky } from "./Sky";
import { TerrainLOD } from "./terrain/TerrainLOD";

export type CameraMode = "chase" | "orbit";

export interface NearestInfo {
  name: string;
  detail: string;
  distanceKm: number;
  bearingDeg: number;
  /** bearing relative to the plane's heading, -180..180 (0 = straight ahead) */
  relativeDeg: number;
}

export interface HudState {
  telemetry: FlightTelemetry;
  landmark: NearestInfo | null;
  city: NearestInfo | null;
  /** local solar time at the plane, "HH:MM" */
  localTime: string;
  timeScale: number;
  cameraMode: CameraMode;
  fps: number;
  chunks: number;
}

export interface EngineOptions {
  container: HTMLElement;
  /** URL prefix of the baked geo assets, e.g. "/geo" */
  assetBase: string;
  onProgress?: Progress;
  onHud?: (s: HudState) => void;
  onAction?: (a: ActionKey) => void;
  start?: { lat: number; lon: number; headingDeg: number; aglM?: number; utcHours?: number };
}

const DEFAULT_START = { lat: 46.45, lon: 7.35, headingDeg: 150, aglM: 2200, utcHours: 14.6 };
const SUN_DECLINATION_DEG = 12;

export class Engine {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  private labels: CSS2DRenderer;
  private orbit: OrbitControls;
  private input: Input;
  private timer = new Timer();
  private raf = 0;
  private disposed = false;

  private assets!: GeoAssets;
  private terrain!: TerrainLOD;
  private sky!: Sky;
  private landmarks!: Landmarks;
  private flight!: FlightModel;
  private plane = createPlaneModel();
  private trails = [new Trail(), new Trail()];
  private sun = new Vector3();
  private sunLight = new DirectionalLight(0xffffff, 3);
  private hemi = new HemisphereLight(0xbfd8ff, 0x3a3020, 0.6);

  private utcHours = DEFAULT_START.utcHours;
  timeScale = 60; // game seconds per real second (1 day = 24 min)
  cameraMode: CameraMode = "chase";
  private lastSpawn = { ...DEFAULT_START };
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

    this.camera = new PerspectiveCamera(60, container.clientWidth / container.clientHeight, 0.004, 20000);
    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enabled = false;
    this.orbit.minDistance = WORLD_RADIUS * 1.08;
    this.orbit.maxDistance = WORLD_RADIUS * 6;
    this.orbit.enablePan = false;
    this.orbit.rotateSpeed = 0.4;

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
    const atmo = createAtmosphereUniforms(this.sun);

    this.terrain = new TerrainLOD(
      { height: this.assets.heightTexture, heightSize: this.assets.heights, surface: this.assets.surfaceTexture, aux: this.assets.auxTexture },
      atmo,
    );
    this.sky = new Sky(atmo);
    this.landmarks = new Landmarks(this.assets.landmarks, this.assets.heights);
    this.flight = new FlightModel((lat, lon) => this.assets.heights.surface(lat, lon));

    this.scene.add(this.terrain.mesh, this.sky.group, this.landmarks.group, this.plane.root, this.sunLight, this.sunLight.target, this.hemi);
    for (const t of this.trails) this.scene.add(t.mesh);

    const s = { ...DEFAULT_START, ...opts.start };
    this.utcHours = s.utcHours ?? DEFAULT_START.utcHours;
    this.spawn(s.lat, s.lon, s.headingDeg, s.aglM);
    this.snapCamera();

    opts.onProgress?.("Ready", 1);
    // Compile shaders before the first frame to avoid a hitch.
    this.updateSun();
    this.terrain.update(this.camera);
    this.renderer.compile(this.scene, this.camera);
    this.timer.connect(document);
    this.loop();
  }

  get landmarkList(): Landmark[] {
    return this.assets?.landmarks ?? [];
  }

  // ------------------------------------------------------------------ actions
  spawn(lat: number, lon: number, headingDeg: number, aglM = 2000) {
    this.lastSpawn = { lat, lon, headingDeg, aglM, utcHours: this.utcHours };
    this.flight.spawn(lat, lon, headingDeg, aglM);
    this.trails.forEach((t) => t.reset());
  }

  /** Fly towards a landmark from ~40 km south of it. */
  teleportToLandmark(id: string) {
    const lm = this.assets.landmarks.find((l) => l.id === id);
    if (!lm) return;
    const lat = Math.max(-89, lm.lat - 0.38);
    const agl = lm.kind === "mountain" ? Math.max(1500, (lm.summitM ?? 0) - this.assets.heights.surface(lat, lm.lon) + 800) : 1400;
    this.spawn(lat, lm.lon, 0, agl);
    if (this.cameraMode === "orbit") this.setCameraMode("chase");
    this.snapCamera();
  }

  setCameraMode(mode: CameraMode) {
    this.cameraMode = mode;
    this.orbit.enabled = mode === "orbit";
    if (mode === "orbit") {
      this.camera.up.set(0, 1, 0);
      this.camera.position.copy(this.flight.position).normalize().multiplyScalar(WORLD_RADIUS * 2.6);
      this.orbit.target.set(0, 0, 0);
      this.orbit.update();
    } else {
      this.snapCamera();
    }
  }

  setTimeScale(s: number) {
    this.timeScale = Math.max(0, Math.min(3600 * 4, s));
  }

  setPaused(p: boolean) {
    this.paused = p;
  }

  /** Testing / screenshots: put the camera somewhere specific. */
  debugView(lat: number, lon: number, aglM: number, headingDeg: number, utcHours?: number) {
    if (utcHours !== undefined) this.utcHours = utcHours;
    this.spawn(lat, lon, headingDeg, aglM);
    this.snapCamera();
  }

  private handleAction(a: ActionKey) {
    if (a === "toggleCamera") this.setCameraMode(this.cameraMode === "chase" ? "orbit" : "chase");
    if (a === "timeFaster") this.setTimeScale(this.timeScale === 0 ? 60 : this.timeScale * 4);
    if (a === "timeSlower") this.setTimeScale(this.timeScale <= 15 ? 0 : this.timeScale / 4);
    if (a === "respawn") {
      this.spawn(this.lastSpawn.lat, this.lastSpawn.lon, this.lastSpawn.headingDeg, this.lastSpawn.aglM);
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
      this.flight.update(dt, this.input.read(dt));
    }
    this.updateSun();
    this.updatePlane(t);
    if (this.cameraMode === "chase") this.updateChaseCamera(dt);
    else this.orbit.update();

    this.terrain.update(this.camera);
    this.sky.update(this.camera.position, this.sun);
    this.landmarks.update(this.camera.position);
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
    this.tickHud(dt);
  };

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
  private updateChaseCamera(dt: number) {
    const f = this.flight;
    const up = this.chaseUp.copy(f.position).normalize();
    const fwd = this.chaseFwd.copy(f.heading).multiplyScalar(Math.cos(f.climb)).addScaledVector(up, Math.sin(f.climb)).normalize();
    const desired = f.position.clone().addScaledVector(fwd, -0.95).addScaledVector(up, 0.26);
    const k = 1 - Math.exp(-dt * 5);
    this.camera.position.lerp(desired, k);
    this.camera.up.copy(up);
    this.camera.lookAt(f.position.clone().addScaledVector(fwd, 0.7).addScaledVector(up, 0.05));
    const targetFov = 58 + (f.speed - 2) * 2.2;
    this.camera.fov += (targetFov - this.camera.fov) * k;
    this.camera.updateProjectionMatrix();
  }

  private snapCamera() {
    if (this.cameraMode !== "chase") return;
    const f = this.flight;
    const up = f.position.clone().normalize();
    this.camera.position.copy(f.position).addScaledVector(f.heading, -0.95).addScaledVector(up, 0.26);
    this.camera.up.copy(up);
    this.camera.lookAt(f.position.clone().addScaledVector(f.heading, 0.7));
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
    const city = nearest(tel, this.assets.cities, (c: City) => c.pop > 150000 || c.capital);
    const local = (this.utcHours + tel.lon / 15 + 48) % 24;
    const hh = Math.floor(local), mm = Math.floor((local - hh) * 60);
    this.opts.onHud({
      telemetry: tel,
      landmark: lm && {
        name: lm.item.name,
        detail: `${lm.item.city}, ${lm.item.country}`,
        distanceKm: lm.distanceKm,
        bearingDeg: lm.bearingDeg,
        relativeDeg: rel(lm.bearingDeg),
      },
      city: city && {
        name: city.item.name,
        detail: city.item.country,
        distanceKm: city.distanceKm,
        bearingDeg: city.bearingDeg,
        relativeDeg: rel(city.bearingDeg),
      },
      localTime: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`,
      timeScale: this.timeScale,
      cameraMode: this.cameraMode,
      fps: this.fps,
      chunks: this.terrain.chunksDrawn,
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
    this.orbit.dispose();
    this.terrain?.dispose();
    this.sky?.dispose();
    this.assets?.heightTexture.dispose();
    this.assets?.surfaceTexture.dispose();
    this.assets?.auxTexture.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labels.domElement.remove();
  }
}
