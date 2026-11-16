import { Vector3 } from "three";
import { EARTH_RADIUS_M } from "./constants";

/**
 * Coordinate conventions (shared with the shaders in @postmark/globe):
 *   +Y = north pole, lon 0 / lat 0 on +Z, lon +90 (east) on +X.
 *   Equirectangular texture: u = (lon + 180) / 360, v = (90 - lat) / 180 (v = 0 at the top).
 */
export const DEG = Math.PI / 180;

export interface LatLon {
  lat: number;
  lon: number;
}

export function latLonToDirection(lat: number, lon: number, out = new Vector3()): Vector3 {
  const la = lat * DEG;
  const lo = lon * DEG;
  const c = Math.cos(la);
  return out.set(c * Math.sin(lo), Math.sin(la), c * Math.cos(lo));
}

export function latLonToVector(lat: number, lon: number, radius: number, out = new Vector3()): Vector3 {
  return latLonToDirection(lat, lon, out).multiplyScalar(radius);
}

export function vectorToLatLon(v: Vector3): LatLon {
  const r = v.length();
  const lat = Math.asin(Math.max(-1, Math.min(1, v.y / r))) / DEG;
  const lon = Math.atan2(v.x, v.z) / DEG;
  return { lat, lon };
}

export function latLonToUV(lat: number, lon: number): [number, number] {
  return [(lon + 180) / 360, (90 - lat) / 180];
}

/** Local tangent frame at a direction: east, north, up (unit vectors). */
export function tangentFrame(up: Vector3, east = new Vector3(), north = new Vector3()) {
  north.set(0, 1, 0).addScaledVector(up, -up.y);
  if (north.lengthSq() < 1e-10) north.set(0, 0, up.y > 0 ? -1 : 1); // at a pole
  north.normalize();
  east.crossVectors(north, up).normalize();
  return { east, north };
}

/** Compass heading in degrees (0 = north, 90 = east) of a direction at a point. */
export function headingOf(forward: Vector3, up: Vector3): number {
  const { east, north } = tangentFrame(up);
  const h = Math.atan2(forward.dot(east), forward.dot(north)) / DEG;
  return (h + 360) % 360;
}

/** Great-circle distance in kilometres (haversine). */
export function distanceKm(a: LatLon, b: LatLon): number {
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLon / 2) ** 2;
  return (2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)))) / 1000;
}

/** Initial great-circle bearing from a to b, degrees (0 = north). */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const la1 = a.lat * DEG;
  const la2 = b.lat * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const y = Math.sin(dLon) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  return ((Math.atan2(y, x) / DEG) + 360) % 360;
}

export function formatLatLon({ lat, lon }: LatLon): string {
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(2)}°${ns} ${Math.abs(lon).toFixed(2)}°${ew}`;
}
