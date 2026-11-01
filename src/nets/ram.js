// RAM, Route Adherence Monitoring: a monitoring aid (EUROCONTROL Specification for Monitoring
// Aids). Warns when a flight is off its cleared route while it is not on a heading from ATC.
// DOM-free.

export const RAM = {
  /** Cross-track distance from the cleared leg that raises the alert (NM). */
  lateralNM: 3
};

/** Distance (NM) from point p to the segment a-b. */
export function crossTrack(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/**
 * Alert for one flight, or null: { xtk } in NM.
 * @param f {xy, legFrom, legTo, atcHeading} position, the cleared leg (from, to), and whether the
 *   flight is on a heading issued by ATC (then it is not expected on the route)
 */
export function ram(f) {
  if (f.atcHeading || !f.legFrom || !f.legTo) return null;
  const xtk = crossTrack(f.xy, f.legFrom, f.legTo);
  return xtk > RAM.lateralNM ? { xtk } : null;
}
