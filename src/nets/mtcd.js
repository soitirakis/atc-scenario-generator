// MTCD, Medium-Term Conflict Detection: a planning tool (EUROCONTROL Specification for MTCD).
// Compares planned trajectories up to 20 minutes ahead and lists predicted losses of separation.
// DOM-free: the caller supplies trajectories sampled at the same times.

export const MTCD = {
  lookaheadS: 20 * 60,
  /** Spacing of trajectory points the caller should supply (s). */
  stepS: 30,
  lateralNM: 5,
  verticalFt: 1000
};

/**
 * Predicted conflicts, soonest first: [{ a, b, t (s to first loss), tMin (s to closest point),
 * minNM, dvFt (vertical distance at closest point), xy (midpoint at the closest point) }]. Between two samples both flights are taken
 * to move in a straight line, so a pair that passes close between samples is still found.
 * @param flights [{ ac, traj: [{t, xy, fl}] }], every traj sampled at the same t values
 */
export function mtcd(flights) {
  const out = [];
  for (let i = 0; i < flights.length; i++) for (let j = i + 1; j < flights.length; j++) {
    const A = flights[i], B = flights[j], c = closest(A.traj, B.traj);
    if (c) out.push({ a: A.ac, b: B.ac, ...c });
  }
  return out.sort((x, y) => x.t - y.t);
}

/** First loss of separation and closest point between two sampled trajectories, or null. */
export function closest(P, Q) {
  const n = Math.min(P.length, Q.length);
  let first = null, min = null;
  for (let k = 0; k < n; k++) {
    // interval from the previous sample (or the sample itself for k = 0) to this one
    const p0 = P[k > 0 ? k - 1 : k], q0 = Q[k > 0 ? k - 1 : k], p1 = P[k], q1 = Q[k];
    const r0 = [q0.xy[0] - p0.xy[0], q0.xy[1] - p0.xy[1]], r1 = [q1.xy[0] - p1.xy[0], q1.xy[1] - p1.xy[1]];
    const d = [r1[0] - r0[0], r1[1] - r0[1]], dd = d[0] * d[0] + d[1] * d[1];
    const s = dd ? Math.max(0, Math.min(1, -(r0[0] * d[0] + r0[1] * d[1]) / dd)) : 1;
    const mid = f => [(p0.xy[0] + (p1.xy[0] - p0.xy[0]) * f + q0.xy[0] + (q1.xy[0] - q0.xy[0]) * f) / 2, (p0.xy[1] + (p1.xy[1] - p0.xy[1]) * f + q0.xy[1] + (q1.xy[1] - q0.xy[1]) * f) / 2];
    const at = f => ({ dh: Math.hypot(r0[0] + d[0] * f, r0[1] + d[1] * f), dv: Math.abs((q0.fl + (q1.fl - q0.fl) * f) - (p0.fl + (p1.fl - p0.fl) * f)) * 100, t: p0.t + (p1.t - p0.t) * f, xy: mid(f) });
    const m = at(s);
    if (m.dv < MTCD.verticalFt && (!min || m.dh < min.dh)) min = m;
    if (first === null && m.dh < MTCD.lateralNM && m.dv < MTCD.verticalFt) {
      // when the distance first drops below the minimum in this interval: |r0 + d f| = lateralNM
      const a = dd, b = 2 * (r0[0] * d[0] + r0[1] * d[1]), c = r0[0] * r0[0] + r0[1] * r0[1] - MTCD.lateralNM ** 2;
      const f = c <= 0 ? 0 : (-b - Math.sqrt(Math.max(0, b * b - 4 * a * c))) / (2 * a);
      first = Math.round(p0.t + (p1.t - p0.t) * Math.max(0, Math.min(1, f)));
    }
  }
  return first === null ? null : { t: first, tMin: Math.round(min.t), minNM: min.dh, dvFt: Math.round(min.dv), xy: min.xy };
}
