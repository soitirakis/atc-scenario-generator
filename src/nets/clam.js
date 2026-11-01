// CLAM, Cleared Level Adherence Monitoring: a monitoring aid (EUROCONTROL Specification for
// Monitoring Aids). Compares what the radar sees with the cleared level: the Mode S selected
// level (SFL) and the actual level. DOM-free; works on plain aircraft state.

export const CLAM = {
  /** Actual level this far past the cleared level, or away from it, is a deviation. */
  deviationFt: 300
};

/**
 * Alert for one aircraft, or null.
 * - 'DEV': the actual level is more than deviationFt beyond the cleared level, on the side it is
 *   heading for (a level bust), or moving away from the cleared level.
 * - 'SFL': the Mode S selected level differs from the cleared level, no deviation yet.
 * @param {{fl:number, cfl:number, sfl:number}} a levels in FL
 */
export function clam(a) {
  if (a.sfl === undefined || a.sfl === null) return null;
  const off = (a.fl - a.cfl) * 100, towardSfl = Math.sign(a.sfl - a.fl);
  const past = Math.abs(off) > CLAM.deviationFt && Math.sign(off) === Math.sign(a.sfl - a.cfl);
  const away = Math.abs(off) > CLAM.deviationFt && towardSfl !== 0 && towardSfl === Math.sign(off);
  if (Math.round(a.sfl) !== Math.round(a.cfl) || past || away) {
    if (past || away) return { kind: 'DEV', devFt: Math.round(off), text: `CLAM: FL${fmt(a.fl)}, cleared FL${fmt(a.cfl)}, selected FL${fmt(a.sfl)}` };
    return { kind: 'SFL', devFt: Math.round(off), text: `CLAM: selected FL${fmt(a.sfl)}, cleared FL${fmt(a.cfl)}` };
  }
  return null;
}

const fmt = fl => String(Math.round(fl)).padStart(3, '0');
