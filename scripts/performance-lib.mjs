// Pure helpers for scripts/openap-wrap.mjs (unit tested against a fixture).

const MS_TO_KT = 1.943844, MS_TO_FPM = 196.8504, KM_TO_FT = 3280.84;

/** Parse a WRAP table ("variable  flight phase  name  opt  min  max  model  parameters") into { variable: { opt, min, max } }. */
export function parseWrapTable(text) {
  const rows = {};
  for (const line of text.split('\n').slice(1)) {
    const c = line.trim().split(/\s{2,}/);
    if (c.length < 6) continue;
    const [opt, min, max] = c.slice(3, 6).map(Number);
    if ([opt, min, max].some(Number.isNaN)) continue;
    rows[c[0]] = { opt, min, max };
  }
  return rows;
}

const conv = (r, f, abs = false) => {
  const v = [r.opt, r.min, r.max].map(x => (abs ? Math.abs(x) : x) * f);
  const [opt, a, b] = v;
  return { opt: round(opt), min: round(Math.min(a, b)), max: round(Math.max(a, b)) };
};
const round = x => (Math.abs(x) < 5 ? Math.round(x * 1000) / 1000 : Math.round(x));

/** The en-route part of a WRAP model, in kt, Mach, ft/min and ft. */
export function parseWrap(text) {
  const r = parseWrapTable(text);
  const need = ['cl_v_cas_const', 'cl_v_mach_const', 'cl_h_cas_const', 'cl_h_mach_const', 'cl_vs_avg_pre_cas', 'cl_vs_avg_cas_const', 'cl_vs_avg_mach_const',
    'cr_v_cas_mean', 'cr_v_mach_mean', 'cr_v_mach_max', 'cr_h_max',
    'de_v_mach_const', 'de_v_cas_const', 'de_h_mach_const', 'de_h_cas_const', 'de_vs_avg_mach_const', 'de_vs_avg_cas_const', 'de_vs_avg_after_cas'];
  const gone = need.filter(k => !r[k]);
  if (gone.length) throw new Error(`WRAP table is missing ${gone.join(', ')}`);
  return {
    climb: {
      casKt: conv(r.cl_v_cas_const, MS_TO_KT), mach: conv(r.cl_v_mach_const, 1),
      casFromFt: conv(r.cl_h_cas_const, KM_TO_FT), machFromFt: conv(r.cl_h_mach_const, KM_TO_FT),
      fpm: { belowCas: conv(r.cl_vs_avg_pre_cas, MS_TO_FPM), cas: conv(r.cl_vs_avg_cas_const, MS_TO_FPM), mach: conv(r.cl_vs_avg_mach_const, MS_TO_FPM) }
    },
    cruise: { casKt: conv(r.cr_v_cas_mean, MS_TO_KT), mach: conv(r.cr_v_mach_mean, 1), maxMach: conv(r.cr_v_mach_max, 1), maxFt: conv(r.cr_h_max, KM_TO_FT) },
    descent: {
      mach: conv(r.de_v_mach_const, 1), casKt: conv(r.de_v_cas_const, MS_TO_KT),
      machAboveFt: conv(r.de_h_mach_const, KM_TO_FT), casAboveFt: conv(r.de_h_cas_const, KM_TO_FT),
      fpm: { mach: conv(r.de_vs_avg_mach_const, MS_TO_FPM, true), cas: conv(r.de_vs_avg_cas_const, MS_TO_FPM, true), belowCas: conv(r.de_vs_avg_after_cas, MS_TO_FPM, true) }
    }
  };
}
