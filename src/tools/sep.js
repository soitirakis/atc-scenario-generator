// SEP: the closest point of approach of two tracks if both keep their present track and ground
// speed (straight lines), like the separation tool on an en-route display. DOM-free.
import { D2R } from '../geo.js';

export const SEP = { maxS: 30 * 60 };

/**
 * @param a, b {x, y, trk, gs}
 * @returns { nowNM, minNM, tMin (s from now, 0 if they are diverging), pa, pb (positions then) }
 */
export function sep(a, b) {
  const va = [Math.sin(a.trk * D2R) * a.gs / 3600, -Math.cos(a.trk * D2R) * a.gs / 3600];
  const vb = [Math.sin(b.trk * D2R) * b.gs / 3600, -Math.cos(b.trk * D2R) * b.gs / 3600];
  const r = [b.x - a.x, b.y - a.y], v = [vb[0] - va[0], vb[1] - va[1]], vv = v[0] * v[0] + v[1] * v[1];
  const tMin = vv ? Math.max(0, Math.min(SEP.maxS, -(r[0] * v[0] + r[1] * v[1]) / vv)) : 0;
  const pa = [a.x + va[0] * tMin, a.y + va[1] * tMin], pb = [b.x + vb[0] * tMin, b.y + vb[1] * tMin];
  return { nowNM: Math.hypot(r[0], r[1]), minNM: Math.hypot(pb[0] - pa[0], pb[1] - pa[1]), tMin: Math.round(tMin), pa, pb };
}
