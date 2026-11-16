import { describe, expect, it } from "vitest";
import {
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

  it("spawns at the requested height above ground", () => {
    const f = new FlightModel(() => 1000);
    f.spawn(10, 20, 90, 1500);
    expect(f.telemetry().aglM).toBeCloseTo(1500, 0);
    expect(f.telemetry().headingDeg).toBeCloseTo(90, 3);
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

  it("never goes below the terrain", () => {
    const f = new FlightModel(() => 3000);
    f.spawn(0, 0, 0, 200);
    for (let i = 0; i < 600; i++) f.update(1 / 60, { pitch: -1, turn: 0, boost: false, slow: false });
    expect(f.telemetry().aglM).toBeGreaterThan(0);
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

  it("opens three well-separated destinations away from the player", () => {
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
  });
});
