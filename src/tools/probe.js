// What-if level probe: if the selected flight were cleared to a level, which flights would it
// conflict with in the next 20 minutes, and which military areas would it enter? DOM-free:
// the caller supplies trajectories (the probed one already flying to the probe level).
import { closest } from '../nets/mtcd.js';
import { inside } from '../nets/apw.js';

/**
 * @param traj  [{t, xy, fl}] the probed flight, as if cleared to the level
 * @param others [{ cs, traj }] the other flights, sampled at the same times
 * @param areas [{ id, poly, lower, upper, from }] military areas; from = s until active (0 if active)
 * @returns { conflicts: [{ cs, t (s to loss), tMin (s to closest point), minNM, dvFt }], areas: [{ id, tt }] } soonest first
 */
export function levelProbe(traj, others, areas) {
  const conflicts = [];
  for (const o of others) {
    const c = closest(traj, o.traj);
    if (c) conflicts.push({ cs: o.cs, t: c.t, tMin: c.tMin, minNM: c.minNM, dvFt: c.dvFt });
  }
  const hits = [];
  for (const z of areas) {
    const p = traj.find(q => q.t >= z.from && inside(q.xy, q.fl, z));
    if (p) hits.push({ id: z.id, tt: p.t });
  }
  return { conflicts: conflicts.sort((x, y) => x.t - y.t), areas: hits.sort((x, y) => x.tt - y.tt) };
}

