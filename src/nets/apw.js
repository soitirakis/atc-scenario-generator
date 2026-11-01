// APW, Area Proximity Warning: a ground-based safety net (EUROCONTROL Specification for APW).
// Warns when a flight is inside an active restricted area, or is predicted to enter one within
// the look-ahead time. DOM-free: the caller supplies the predicted trajectory.
import { pip } from '../geo.js';

export const APW = {
  /** Look-ahead time (s). */
  lookaheadS: 120,
  /** Spacing of trajectory points the caller should supply (s). */
  stepS: 5
};

/** Inside an area: laterally, and within its vertical limits (inclusive). */
export const inside = (xy, fl, z) => fl >= z.lower && fl <= z.upper && pip(xy, z.poly);

/**
 * Alert for one flight, or null: { level: 'VIOLATION' | 'PREDICTED', area, tt (s to entry, 0 if inside) }.
 * @param now {xy, fl} current position
 * @param traj [{t, xy, fl}] predicted points, t in s from now, ascending
 * @param areas active areas { id, poly, lower, upper }
 */
export function apw(now, traj, areas) {
  for (const z of areas) if (inside(now.xy, now.fl, z)) return { level: 'VIOLATION', area: z, tt: 0 };
  let best = null;
  for (const z of areas) {
    const hit = traj.find(p => p.t <= APW.lookaheadS && inside(p.xy, p.fl, z));
    if (hit && (!best || hit.t < best.tt)) best = { level: 'PREDICTED', area: z, tt: hit.t };
  }
  return best;
}
