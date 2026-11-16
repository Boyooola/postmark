import { describe, expect, it } from "vitest";
import {
  Places,
  gmstDeg,
  julianDate,
  moonIllumination,
  moonRaDec,
  subPoint,
  sunRaDec,
  FLIGHT,
  FlightModel,
  HeightField,
  TerrainHeights,
  Deliveries,
  DELIVERY,
  mulberry32,
  WORLD_RADIUS,
  bearingDeg,
  distanceKm,
  elevationToUnits,
  headingOf,
  latLonToDirection,
  latLonToVector,
  unitsToElevation,
  vectorToLatLon,
  type City,
} from "./index";

describe("geo", () => {
  it("round-trips lat/lon through vectors", () => {
    for (const [lat, lon] of [[0, 0], [48.8584, 2.2945], [-33.86, 151.21], [64.1, -21.9], [-89, 179]]) {
      const v = latLonToVector(lat, lon, WORLD_RADIUS);
      const r = vectorToLatLon(v);
      expect(r.lat).toBeCloseTo(lat, 6);
      expect(r.lon).toBeCloseTo(lon, 6);
    }
  });

  it("puts lon 0 on +Z and east on +X", () => {
    const d = latLonToDirection(0, 90);
    expect(d.x).toBeCloseTo(1);
    expect(latLonToDirection(90, 0).y).toBeCloseTo(1);
  });

  it("measures real distances", () => {
    // Paris -> London is about 344 km
    expect(distanceKm({ lat: 48.8566, lon: 2.3522 }, { lat: 51.5074, lon: -0.1278 })).toBeGreaterThan(335);
    expect(distanceKm({ lat: 48.8566, lon: 2.3522 }, { lat: 51.5074, lon: -0.1278 })).toBeLessThan(350);
    expect(bearingDeg({ lat: 0, lon: 0 }, { lat: 10, lon: 0 })).toBeCloseTo(0);
    expect(bearingDeg({ lat: 0, lon: 0 }, { lat: 0, lon: 10 })).toBeCloseTo(90);
  });

  it("computes compass headings", () => {
    const up = latLonToDirection(0, 0);
    expect(headingOf(latLonToDirection(90, 0), up)).toBeCloseTo(0); // towards the north pole
  });

  it("converts elevations both ways", () => {
    expect(unitsToElevation(elevationToUnits(8849))).toBeCloseTo(8849, 6);
  });
});

describe("HeightField", () => {
  it("decodes Terrarium pixels", () => {
    // 1 pixel = 1234 m: 1234 + 32768 = 34002 = 132*256 + 210
    const hf = HeightField.fromTerrarium(new Uint8Array([132, 210, 0, 255]), 1, 1);
    expect(hf.data[0]).toBeCloseTo(1234);
  });

  it("samples bilinearly and clamps the sea surface to 0", () => {
    const hf = new HeightField(4, 2, new Float32Array([100, 100, -50, -50, 100, 100, -50, -50]));
    expect(hf.sample(45, -135)).toBeCloseTo(100);
    expect(hf.surface(45, 135)).toBe(0);
  });
});

describe("FlightModel", () => {
  const flat = () => 0;

  it("spawns at the requested altitude, clamped to the altitude band", () => {
    const f = new FlightModel(() => 1000);
    f.spawn(10, 20, 90, 15000);
    expect(f.telemetry().altitudeM).toBeCloseTo(15000, 0);
    expect(f.telemetry().headingDeg).toBeCloseTo(90, 3);
    f.spawn(10, 20, 90, 1500);
    expect(f.telemetry().altitudeM).toBeCloseTo(FLIGHT.floorM, 0);
    f.spawn(10, 20, 90, 90000);
    expect(f.telemetry().altitudeM).toBeCloseTo(FLIGHT.ceilingM, 0);
  });

  it("stays inside the altitude band however hard you dive or climb", () => {
    const f = new FlightModel(() => 0);
    f.spawn(0, 0, 0);
    for (let i = 0; i < 1200; i++) f.update(1 / 60, { pitch: -1, turn: 0, boost: true, slow: false });
    expect(f.telemetry().altitudeM).toBeGreaterThan(FLIGHT.floorM - 1);
    for (let i = 0; i < 2400; i++) f.update(1 / 60, { pitch: 1, turn: 0, boost: true, slow: false });
    expect(f.telemetry().altitudeM).toBeLessThan(FLIGHT.ceilingM + 1);
  });

  it("flies level along the sphere at cruise speed", () => {
    const f = new FlightModel(flat);
    f.spawn(0, 0, 90, 2000);
    const r0 = f.position.length();
    for (let i = 0; i < 600; i++) f.update(1 / 60, { pitch: 0, turn: 0, boost: false, slow: false });
    const t = f.telemetry();
    expect(Math.abs(f.position.length() - r0)).toBeLessThan(0.05);
    expect(t.lon).toBeGreaterThan(0.5); // moved east
    expect(Math.abs(t.lat)).toBeLessThan(0.01);
    expect(t.airspeedKmh).toBeCloseTo(FLIGHT.cruiseSpeed * FLIGHT.displayKmhPerUnit);
  });

  it("keeps its clearance over high mountains", () => {
    const f = new FlightModel(() => 9500);
    f.spawn(0, 0, 0, 200);
    for (let i = 0; i < 600; i++) f.update(1 / 60, { pitch: -1, turn: 0, boost: false, slow: false });
    expect(f.telemetry().aglM).toBeGreaterThan(FLIGHT.clearanceM - 1);
  });

  it("turns right with positive turn input", () => {
    const f = new FlightModel(flat);
    f.spawn(0, 0, 0, 2000);
    for (let i = 0; i < 60; i++) f.update(1 / 60, { pitch: 0, turn: 1, boost: false, slow: false });
    const h = f.telemetry().headingDeg;
    expect(h).toBeGreaterThan(20);
    expect(h).toBeLessThan(180);
  });
});

describe("TerrainHeights", () => {
  // Base: flat 100 m everywhere. Detail window: 10°x10° at 500 m, centred on (5, 5).
  const base = new HeightField(4, 2, new Float32Array(8).fill(100));
  const make = () => {
    const t = new TerrainHeights(base);
    t.detail = { data: new Float32Array(64 * 64).fill(500), size: 64, lon0: 0, lat0: 10, spanDeg: 10 };
    return t;
  };

  it("uses the detail window inside it and the base map outside", () => {
    const t = make();
    expect(t.sample(5, 5)).toBeCloseTo(500);
    expect(t.sample(-20, 40)).toBeCloseTo(100);
  });

  it("blends smoothly at the window edge", () => {
    const t = make();
    const nearEdge = t.sample(5, 0.2); // 2% in from the west edge, inside the fade band
    expect(nearEdge).toBeGreaterThan(100);
    expect(nearEdge).toBeLessThan(500);
  });

  it("handles windows that cross the antimeridian", () => {
    const t = new TerrainHeights(base);
    t.detail = { data: new Float32Array(16 * 16).fill(700), size: 16, lon0: 175, lat0: 10, spanDeg: 10 };
    expect(t.sample(5, -180)).toBeCloseTo(700);
    expect(t.sample(5, 179)).toBeCloseTo(700);
    expect(t.sample(5, -170)).toBeCloseTo(100);
  });
});

describe("Boost", () => {
  it("drains while boosting and refills afterwards", () => {
    const f = new FlightModel(() => 0);
    f.spawn(0, 0, 0);
    for (let i = 0; i < 120; i++) f.update(1 / 60, { pitch: 0, turn: 0, boost: true, slow: false });
    const drained = f.boostEnergy;
    expect(drained).toBeLessThan(0.8);
    expect(f.speed).toBeGreaterThan(FLIGHT.cruiseSpeed);
    for (let i = 0; i < 120; i++) f.update(1 / 60, { pitch: 0, turn: 0, boost: false, slow: false });
    expect(f.boostEnergy).toBeGreaterThan(drained);
  });

  it("stops boosting when empty", () => {
    const f = new FlightModel(() => 0);
    f.spawn(0, 0, 0);
    for (let i = 0; i < 60 * 8; i++) f.update(1 / 60, { pitch: 0, turn: 0, boost: true, slow: false });
    expect(f.boostEnergy).toBeLessThan(0.02);
    expect(f.telemetry().boosting).toBe(false);
  });
});

describe("Deliveries", () => {
  const city = (name: string, country: string, lat: number, lon: number, pop = 5_000_000): City => ({
    name, country, lat, lon, pop, capital: false, elevationM: 0,
  });
  const cities: City[] = [
    city("Paris", "France", 48.86, 2.35),
    city("Cairo", "Egypt", 30.04, 31.24),
    city("Moscow", "Russia", 55.76, 37.62),
    city("Lagos", "Nigeria", 6.52, 3.38),
    city("Mumbai", "India", 19.08, 72.88),
    city("Tinyville", "Nowhere", 10, 10, 2000), // too small to be a destination
  ];

  it("opens destinations away from the player", () => {
    const d = new Deliveries(cities, mulberry32(1));
    expect(d.poolSize).toBe(5);
    d.start({ lat: 48.86, lon: 2.35 }); // from Paris
    expect(d.targets).toHaveLength(DELIVERY.activeTargets);
    expect(d.targets.find((t) => t.city === "Paris")).toBeUndefined();
  });

  it("counts a parcel that lands close to a destination and replaces it", () => {
    const d = new Deliveries(cities, mulberry32(2));
    d.start({ lat: 48.86, lon: 2.35 });
    const t = d.targets[0];
    const r = d.resolveDrop({ lat: t.lat + 0.3, lon: t.lon })!; // ~33 km north
    expect(r.hit).toBe(true);
    expect(r.distanceKm).toBeLessThan(40);
    expect(d.delivered).toBe(1);
    expect(d.targets.find((x) => x.id === t.id)).toBeUndefined();
  });

  it("reports a miss with the distance", () => {
    const d = new Deliveries(cities, mulberry32(3));
    d.start({ lat: 48.86, lon: 2.35 });
    const t = d.targets[0];
    const r = d.resolveDrop({ lat: t.lat + 3, lon: t.lon })!;
    expect(r.hit).toBe(false);
    expect(r.distanceKm).toBeGreaterThan(300);
    expect(d.delivered).toBe(0);
  });
});

describe("TerrainHeights fine window", () => {
  const base = new HeightField(4, 2, new Float32Array(8).fill(100));
  it("layers base -> detail -> fine", () => {
    const t = new TerrainHeights(base);
    t.detail = { data: new Float32Array(64 * 64).fill(500), size: 64, lon0: 0, lat0: 20, spanDeg: 20 };
    t.fine = { data: new Float32Array(32 * 32).fill(900), size: 32, lon0: 5, lat0: 15, spanDeg: 10 };
    expect(t.sample(10, 10)).toBeCloseTo(900); // inside fine
    expect(t.sample(10, 10, 1)).toBeCloseTo(500); // fine excluded
    expect(t.sample(18, 2)).toBeCloseTo(500); // detail only
    expect(t.sample(-30, -60)).toBeCloseTo(100); // base only
    t.sharp = { data: new Float32Array(16 * 16).fill(1500), size: 16, lon0: 8, lat0: 12, spanDeg: 4 };
    expect(t.sample(10, 10)).toBeCloseTo(1500); // inside sharp
    expect(t.sample(10, 10, 2)).toBeCloseTo(900); // sharp excluded
  });
});

describe("Places", () => {
  // 4 x 2 map: west half = country 1 ("Westland"), east-north = sea 1 ("North Sea"), east-south = nothing.
  const rgba = new Uint8Array(4 * 2 * 4);
  const put = (x: number, y: number, c: number, s: number) => {
    const v = (c << 9) | s;
    rgba.set([v >> 16, (v >> 8) & 255, v & 255, 255], (y * 4 + x) * 4);
  };
  put(0, 0, 1, 0); put(1, 0, 1, 1); put(0, 1, 1, 0); put(1, 1, 1, 0);
  put(2, 0, 0, 1); put(3, 0, 0, 1);
  const p = new Places({ width: 4, height: 2, rgba, countries: ["Westland"], seas: ["North Sea"] });

  it("prefers the country, then the sea", () => {
    expect(p.at({ lat: 45, lon: -100 })).toBe("Westland");
    expect(p.at({ lat: 45, lon: -10 })).toBe("Westland"); // both: country wins
    expect(p.at({ lat: 45, lon: 100 })).toBe("North Sea");
    expect(p.at({ lat: -45, lon: 100 })).toBeNull();
  });

  it("wraps longitude and clamps the poles", () => {
    expect(p.at({ lat: 90, lon: 460 })).toBe("North Sea"); // 460 = 100 E
    expect(p.at({ lat: -90, lon: -180 })).toBe("Westland");
  });
});

describe("astro", () => {
  const jd = (iso: string) => julianDate(Date.parse(iso));

  it("puts the sun at the solstice and equinox declinations", () => {
    expect(sunRaDec(jd("2024-06-20T20:51:00Z")).decDeg).toBeCloseTo(23.44, 1);
    expect(Math.abs(sunRaDec(jd("2024-03-20T03:06:00Z")).decDeg)).toBeLessThan(0.05);
  });

  it("puts noon over Greenwich (allowing for the equation of time)", () => {
    // March 20: the sun crosses Greenwich ~7.5 min after 12:00 UTC, so at 12:00 it is ~1.9 deg east.
    const j = jd("2024-03-20T12:00:00Z");
    expect(subPoint(sunRaDec(j), j).lon).toBeCloseTo(1.9, 0);
  });

  it("knows new and full moons", () => {
    expect(moonIllumination(jd("2024-04-23T23:49:00Z"))).toBeGreaterThan(0.99);
    const j = jd("2024-04-08T18:21:00Z"); // new moon (total solar eclipse)
    expect(moonIllumination(j)).toBeLessThan(0.01);
    expect(Math.abs(moonRaDec(j).raDeg - sunRaDec(j).raDeg)).toBeLessThan(1.5);
  });

  it("computes sidereal time", () => {
    expect(gmstDeg(2_451_545.0)).toBeCloseTo(280.46, 2);
  });
});
