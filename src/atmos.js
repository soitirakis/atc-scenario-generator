// International Standard Atmosphere, airspeed conversions and the scenario wind field.
// No DOM access. Altitudes are pressure altitudes in feet (FL x 100); speeds in knots.
import { mulberry32 } from './geo.js';

const FT = 0.3048, KT = 0.514444;
const T0 = 288.15, P0 = 101325, L = 0.0065, R = 287.05287, G = 9.80665, GAMMA = 1.4;
const H_TROP = 11000, T_TROP = 216.65, P_TROP = 22632.06;
const A0 = Math.sqrt(GAMMA * R * T0); // m/s at sea level

/** ISA at a pressure altitude in feet: { T (K), p (Pa), a (speed of sound, kt) }. */
export function isa(ft) {
  const h = Math.max(-500, ft) * FT;
  const T = h < H_TROP ? T0 - L * h : T_TROP;
  const p = h < H_TROP ? P0 * Math.pow(T / T0, G / (L * R)) : P_TROP * Math.exp(-G * (h - H_TROP) / (R * T_TROP));
  return { T, p, a: Math.sqrt(GAMMA * R * T) / KT };
}

/** Calibrated airspeed (kt) to Mach at a pressure altitude (compressible flow). */
export function casToMach(cas, ft) {
  const { p } = isa(ft);
  const qc = P0 * (Math.pow(1 + 0.2 * Math.pow(cas * KT / A0, 2), 3.5) - 1);
  return Math.sqrt(5 * (Math.pow(qc / p + 1, 2 / 7) - 1));
}
/** Mach to calibrated airspeed (kt). */
export function machToCas(mach, ft) {
  const { p } = isa(ft);
  const qc = p * (Math.pow(1 + 0.2 * mach * mach, 3.5) - 1);
  return A0 * Math.sqrt(5 * (Math.pow(qc / P0 + 1, 2 / 7) - 1)) / KT;
}
export const machToTas = (mach, ft) => mach * isa(ft).a;
export const tasToMach = (tas, ft) => tas / isa(ft).a;
export const casToTas = (cas, ft) => machToTas(casToMach(cas, ft), ft);

/**
 * Wind field: a list of { fl, dir, kt } (direction the wind blows FROM, degrees true).
 * Between levels the wind vector is interpolated linearly; outside them the nearest level holds.
 * Returns the velocity the air moves with, [east, south] in kt (y south, like the simulation plane).
 */
export function windAt(levels, fl) {
  if (!levels || !levels.length) return [0, 0];
  const vec = w => { const r = w.dir * Math.PI / 180; return [-Math.sin(r) * w.kt, Math.cos(r) * w.kt]; };
  if (fl <= levels[0].fl) return vec(levels[0]);
  for (let i = 1; i < levels.length; i++) {
    if (fl <= levels[i].fl) {
      const a = vec(levels[i - 1]), b = vec(levels[i]), f = (fl - levels[i - 1].fl) / (levels[i].fl - levels[i - 1].fl);
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    }
  }
  return vec(levels[levels.length - 1]);
}

/** Validate and sort an edited wind table. Throws with a message on bad input. */
export function normaliseWind(levels) {
  if (!Array.isArray(levels) || levels.length > 8) throw new Error('Wind: up to 8 levels');
  const out = levels.map(w => ({ fl: Math.round(+w.fl), dir: Math.round(+w.dir) % 360, kt: Math.round(+w.kt) }));
  for (const w of out) {
    if (!(w.fl >= 0 && w.fl <= 450)) throw new Error('Wind: levels FL000–FL450');
    if (!(w.dir >= 0)) throw new Error('Wind: direction 0–359°');
    if (!(w.kt >= 0 && w.kt <= 250)) throw new Error('Wind: speed 0–250 kt');
  }
  out.sort((a, b) => a.fl - b.fl);
  if (new Set(out.map(w => w.fl)).size !== out.length) throw new Error('Wind: one entry per level');
  return out;
}

/**
 * A plausible mid-latitude wind for a scenario, from its seed: westerly, veering and
 * strengthening with height to a jet near FL340. A modelling choice, not a forecast.
 */
export function defaultWind(seed) {
  const rnd = mulberry32(seed * 104729 + 17);
  const base = 240 + Math.round(rnd() * 60), jet = 40 + Math.round(rnd() * 60);
  return [
    { fl: 50, dir: (base - 30 + 360) % 360, kt: 15 + Math.round(rnd() * 10) },
    { fl: 180, dir: (base - 10 + 360) % 360, kt: Math.round(jet * 0.5) },
    { fl: 340, dir: base, kt: jet },
    { fl: 420, dir: (base + 10) % 360, kt: Math.round(jet * 0.8) }
  ];
}
