// Progress of one trainee over their stored session records (src/records.js). DOM-free: the
// History tab draws it as tables and inline SVG, and the PDF debrief can add it as a page.
import { TYPES, GRADING } from './sim.js';

/** Sessions in the trend window, and the slope of the met rate per session that counts as a trend. */
export const PROGRESS = { trendWindow: 5, trendMin: 3, trendSlope: 0.1, weakestMin: 2, weakestCount: 3 };

/**
 * Objectives every session has, besides its injects: met in a session when the count is zero.
 * Labels and objectives are what the trainee reads.
 */
export const STANDING = [
  { key: 'los', label: 'Separation', objective: 'no loss of separation', stat: 'losCount' },
  { key: 'assume', label: 'Assume on time', objective: 'every flight assumed before it enters', stat: 'lateAssume' },
  { key: 'transfer', label: 'Transfer on time', objective: 'every flight transferred before it leaves', stat: 'lateXfer' },
  { key: 'xfl', label: 'Agreed exit levels', objective: 'every transfer at the agreed exit level', stat: 'wrongXfl' }
];

/** The key a trainee's records are grouped under: the name, trimmed, in lower case. "" for no name. */
export const traineeKey = name => String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();

/** Trainees in the records, most recent session first: [{ key, name (latest spelling), sessions, last }]. */
export function trainees(records) {
  const by = new Map();
  for (const r of [...records].sort((a, b) => a.savedAt.localeCompare(b.savedAt))) {
    const k = traineeKey(r.trainee), t = by.get(k) || { key: k, name: '', sessions: 0, last: '' };
    t.name = r.trainee.trim() || 'No trainee name'; t.sessions++; t.last = r.savedAt;
    by.set(k, t);
  }
  return [...by.values()].sort((a, b) => b.last.localeCompare(a.last) || a.key.localeCompare(b.key));
}

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Trend of the met rate over the last sessions: the least-squares slope of each session's rate
 * (met / graded, 0..1) against its order. 'improving' or 'declining' when the slope is at least
 * PROGRESS.trendSlope per session, 'steady' otherwise; null with fewer than PROGRESS.trendMin sessions.
 */
export function trendOf(last) {
  if (last.length < PROGRESS.trendMin) return null;
  const ys = last.map(s => s.met / s.graded), n = ys.length, mx = (n - 1) / 2, my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  ys.forEach((y, x) => { num += (x - mx) * (y - my); den += (x - mx) ** 2; });
  const slope = num / den;
  return slope >= PROGRESS.trendSlope ? 'improving' : slope <= -PROGRESS.trendSlope ? 'declining' : 'steady';
}

const pct = r => `${Math.round(r * 100)}%`;
const TREND_WORDS = { improving: 'improving', declining: 'getting worse', steady: 'no clear change' };

/**
 * One trainee's progress from their records (any order; others are ignored).
 * @returns {
 *   trainee, sessions, from, to,
 *   series:   per session, oldest first: { id, savedAt, title, sectorName, completed, los, losSec, minSep, lateAssume, lateXfer, wrongXfl },
 *   injects:  per inject type seen: { type, label, objective, seen (sessions it fired in), graded, met, rate, medianS, last, trend },
 *   standing: the STANDING objectives, same shape with sessions instead of seen,
 *   weakest:  up to PROGRESS.weakestCount objectives, weakest first: { label, objective, rate, text }
 * }
 * `last` is the trend window: [{ savedAt, met, graded }] for the last sessions with a graded result.
 */
export function progressOf(records, trainee) {
  const key = traineeKey(trainee);
  const rs = records.filter(r => traineeKey(r.trainee) === key).sort((a, b) => a.savedAt.localeCompare(b.savedAt) || a.id.localeCompare(b.id));
  const series = rs.map(r => ({
    id: r.id, savedAt: r.savedAt, title: r.scenario.title, sectorName: r.sectorName, completed: r.completed,
    los: r.stats.losCount, losSec: r.stats.losSec, minSep: r.stats.minSep, lateAssume: r.stats.lateAssume, lateXfer: r.stats.lateXfer, wrongXfl: r.stats.wrongXfl
  }));

  const injects = Object.keys(TYPES).map(type => {
    const per = [], times = [];
    let seen = 0, objective = GRADING[type].text;
    for (const r of rs) {
      const mine = r.injects.filter(i => i.type === type);
      if (mine.some(i => i.status === 'fired')) seen++;
      const done = mine.filter(i => i.result && i.result.state !== 'pending');
      if (!done.length) continue;
      objective = done[0].objective || objective;
      per.push({ savedAt: r.savedAt, met: done.filter(i => i.result.state === 'met').length, graded: done.length });
      for (const i of done) if (i.result.t !== null) times.push(i.result.t);
    }
    if (!seen) return null;
    const graded = per.reduce((s, p) => s + p.graded, 0), met = per.reduce((s, p) => s + p.met, 0), last = per.slice(-PROGRESS.trendWindow);
    return { type, label: TYPES[type], objective, seen, graded, met, rate: graded ? met / graded : null, medianS: median(times), last, trend: trendOf(last) };
  }).filter(Boolean);

  const standing = STANDING.map(s => {
    const per = rs.map(r => ({ savedAt: r.savedAt, met: r.stats[s.stat] === 0 ? 1 : 0, graded: 1 })), last = per.slice(-PROGRESS.trendWindow);
    const met = per.reduce((a, p) => a + p.met, 0);
    return { key: s.key, label: s.label, objective: s.objective, sessions: rs.length, graded: rs.length, met, rate: rs.length ? met / rs.length : null, last, trend: trendOf(last) };
  });

  return { trainee: rs.length ? rs[rs.length - 1].trainee.trim() : String(trainee || '').trim(), sessions: rs.length, from: rs.length ? rs[0].savedAt : null, to: rs.length ? rs[rs.length - 1].savedAt : null, series, injects, standing, weakest: weakest(injects, standing) };
}

/**
 * The weakest objectives, in plain words: those graded in at least PROGRESS.weakestMin sessions,
 * lowest met rate first; on a tie, the one getting worse, then the one missed in its last session,
 * then the one graded more often. Objectives met every time are not weak and are left out.
 */
export function weakest(injects, standing) {
  const ORDER = { declining: 0, steady: 1, null: 2, improving: 3 };
  const cand = [...injects.map(i => ({ ...i, kind: 'inject' })), ...standing.map(s => ({ ...s, kind: 'standing' }))]
    .filter(o => o.last.length >= PROGRESS.weakestMin && o.graded && o.rate < 1);
  cand.sort((a, b) => a.rate - b.rate || ORDER[a.trend] - ORDER[b.trend]
    || (b.last[b.last.length - 1].met < b.last[b.last.length - 1].graded) - (a.last[a.last.length - 1].met < a.last[a.last.length - 1].graded)
    || b.graded - a.graded || a.label.localeCompare(b.label));
  return cand.slice(0, PROGRESS.weakestCount).map(o => {
    const unit = o.kind === 'inject' ? 'time' : 'session';
    const lastMiss = o.last[o.last.length - 1].met < o.last[o.last.length - 1].graded;
    const parts = [
      `${o.label}: ${o.objective}.`,
      `Met ${o.met} of ${o.graded} ${unit}${o.graded > 1 ? 's' : ''} (${pct(o.rate)})${o.trend ? `, ${TREND_WORDS[o.trend]} over the last ${o.last.length} sessions` : ''}.`,
      lastMiss ? 'Not met in the last session.' : '',
      o.medianS !== null && o.medianS !== undefined ? `Median measured time ${Math.round(o.medianS)} s.` : ''
    ];
    return { label: o.label, objective: o.objective, rate: o.rate, trend: o.trend, text: parts.filter(Boolean).join(' ') };
  });
}
