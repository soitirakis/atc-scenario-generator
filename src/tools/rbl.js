// Range and bearing line between two ends, each a fixed point or a track. DOM-free.
import { dist, brg } from '../geo.js';

/** Where an end is now: a track's position (if it is still there), or the fixed point. */
export function endXY(end, getAc) {
  if (end.ac === undefined) return end.xy;
  const a = getAc(end.ac);
  return a ? [a.x, a.y] : null;
}

/** { nm, brg } from p to q in the NM plane; bearing in degrees true, 001-360. */
export function rangeBearing(p, q) {
  return { nm: dist(p, q), brg: Math.round(brg(p, q)) % 360 || 360 };
}

/** Label for a line: "045° 23.4 NM". */
export const rblText = r => `${String(r.brg).padStart(3, '0')}° ${r.nm.toFixed(1)} NM`;
