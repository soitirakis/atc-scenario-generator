// Geometry helpers. All simulation maths happens in a flat nautical-mile plane
// (x east, y south) produced by an equirectangular projection around the
// country's centre. Good to well under 1 % across a single FIR.

export const D2R = Math.PI / 180;

/** Parse AIP coordinates such as "462314N 0253920E" or "442627N0260924E". */
export function dms(str) {
  const m = String(str).match(/(\d{2})(\d{2})(\d{2}(?:\.\d+)?)([NS])\s*(\d{3})(\d{2})(\d{2}(?:\.\d+)?)([EW])/);
  if (!m) throw new Error(`Bad AIP coordinate: ${str}`);
  let lat = +m[1] + m[2] / 60 + m[3] / 3600;
  if (m[4] === 'S') lat = -lat;
  let lon = +m[5] + m[6] / 60 + m[7] / 3600;
  if (m[8] === 'W') lon = -lon;
  return [lat, lon];
}

export function makeProjection(lat0, lon0) {
  const k = Math.cos(lat0 * D2R);
  return {
    lat0, lon0,
    toNM: (lat, lon) => [(lon - lon0) * 60 * k, (lat0 - lat) * 60],
    fromNM: (x, y) => [lat0 - y / 60, lon0 + x / (60 * k)]
  };
}

export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** True bearing (deg) from a to b in the NM plane. */
export const brg = (from, to) => ((Math.atan2(to[0] - from[0], -(to[1] - from[1])) / D2R) + 360) % 360;

/** Signed smallest difference b - a in degrees, range [-180, 180). */
export const angDiff = (a, b) => (b - a + 540) % 360 - 180;

export const moveToward = (v, target, d) => (v < target ? Math.min(target, v + d) : Math.max(target, v - d));

/** Point in polygon (ray casting). */
export function pip(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (((yi > p[1]) !== (yj > p[1])) && (p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

/** Segment intersection; returns [x, y, t, u] or null. */
export function segInt(a, b, c, d) {
  const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
  const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [a[0] + t * r[0], a[1] + t * r[1], t, u];
}

export function centroid(poly) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const f = poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
    a += f; cx += (poly[j][0] + poly[i][0]) * f; cy += (poly[j][1] + poly[i][1]) * f;
  }
  a *= 0.5;
  return [cx / (6 * a), cy / (6 * a)];
}

/** Small seeded PRNG so a seed always reproduces the same session. */
export function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export const fmtFL = fl => String(Math.round(fl)).padStart(3, '0');
export const fmtT = s => { s = Math.max(0, Math.floor(s)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
