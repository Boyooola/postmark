/**
 * Low-precision astronomy for the sky: where the sun, moon and stars are for a
 * given moment. Accurate to well under a degree for the sun and about a degree
 * for the moon over 1950-2100, plenty for a game sky.
 *
 * World frame: Earth-fixed (lon 0 on +Z, +Y north). A body at right ascension
 * RA and declination Dec sits over the point lat = Dec, lon = RA - GMST.
 */

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const wrap360 = (x: number) => ((x % 360) + 360) % 360;

export interface RaDec {
  raDeg: number;
  decDeg: number;
}

/** Julian date from a JS time (ms since the Unix epoch, UTC). */
export function julianDate(ms: number): number {
  return ms / 86_400_000 + 2_440_587.5;
}

/** Greenwich mean sidereal time, degrees 0..360. */
export function gmstDeg(jd: number): number {
  const d = jd - 2_451_545.0;
  const t = d / 36525;
  return wrap360(280.46061837 + 360.98564736629 * d + 0.000387933 * t * t);
}

function eclipticToRaDec(lambdaDeg: number, betaDeg: number, jd: number): RaDec {
  const t = (jd - 2_451_545.0) / 36525;
  const eps = (23.439291 - 0.0130042 * t) * D2R;
  const l = lambdaDeg * D2R, b = betaDeg * D2R;
  const ra = Math.atan2(Math.sin(l) * Math.cos(eps) - Math.tan(b) * Math.sin(eps), Math.cos(l));
  const dec = Math.asin(Math.sin(b) * Math.cos(eps) + Math.cos(b) * Math.sin(eps) * Math.sin(l));
  return { raDeg: wrap360(ra * R2D), decDeg: dec * R2D };
}

/** Apparent sun position (NOAA / Meeus low-precision). */
export function sunRaDec(jd: number): RaDec & { lambdaDeg: number } {
  const t = (jd - 2_451_545.0) / 36525;
  const L0 = wrap360(280.46646 + 36000.76983 * t);
  const M = (357.52911 + 35999.05029 * t) * D2R;
  const C = (1.914602 - 0.004817 * t) * Math.sin(M) + 0.019993 * Math.sin(2 * M) + 0.000289 * Math.sin(3 * M);
  const lambda = L0 + C;
  return { ...eclipticToRaDec(lambda, 0, jd), lambdaDeg: wrap360(lambda) };
}

/** Moon position (main periodic terms of Meeus ch. 47, ~1 degree). */
export function moonRaDec(jd: number): RaDec & { lambdaDeg: number } {
  const d = jd - 2_451_545.0;
  const Lp = 218.316 + 13.176396 * d; // mean longitude
  const D = (297.850 + 12.190749 * d) * D2R; // mean elongation
  const M = (357.529 + 0.98560028 * d) * D2R; // sun mean anomaly
  const Mp = (134.963 + 13.064993 * d) * D2R; // moon mean anomaly
  const F = (93.272 + 13.229350 * d) * D2R; // argument of latitude
  const lambda =
    Lp +
    6.289 * Math.sin(Mp) +
    1.274 * Math.sin(2 * D - Mp) +
    0.658 * Math.sin(2 * D) +
    0.214 * Math.sin(2 * Mp) -
    0.186 * Math.sin(M) -
    0.114 * Math.sin(2 * F);
  const beta = 5.128 * Math.sin(F) + 0.281 * Math.sin(Mp + F) + 0.278 * Math.sin(Mp - F) + 0.173 * Math.sin(2 * D - F);
  return { ...eclipticToRaDec(lambda, beta, jd), lambdaDeg: wrap360(lambda) };
}

/** Illuminated fraction of the moon's disc, 0 (new) .. 1 (full). */
export function moonIllumination(jd: number): number {
  const s = sunRaDec(jd), m = moonRaDec(jd);
  const toVec = (p: RaDec) => {
    const ra = p.raDeg * D2R, dec = p.decDeg * D2R;
    return [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
  };
  const a = toVec(s), b = toVec(m);
  const cosElong = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return (1 - cosElong) / 2;
}

/** Sub-point (lat, lon) of a body: where it is straight overhead. */
export function subPoint(p: RaDec, jd: number): { lat: number; lon: number } {
  const lon = wrap360(p.raDeg - gmstDeg(jd) + 180) - 180;
  return { lat: p.decDeg, lon };
}
