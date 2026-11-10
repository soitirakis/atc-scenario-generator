// "Suggest next scenario": from a trainee's session records, a scenario file for their next session,
// with a written reason for every choice. DOM-free and deterministic (no Math.random): the same
// records give the same suggestion. The file always passes validateScenarioFile.
import { TYPES, DIFF } from './sim.js';
import { buildLocalScenario, exportScenario, validateScenarioFile, DURATIONS, INJECT_TEXT } from './scenario.js';
import { progressOf, traineeKey } from './progress.js';

export const RECOMMEND = {
  upRate: 0.8, upSessions: 3,      // step up after 3 sessions meeting at least 80% of their objectives
  downRate: 0.5, downSessions: 2,  // step down after 2 sessions meeting under 50%
  overlapS: 180,                   // injects fired within 3 minutes of another one count as overlapping
  overlapMin: 2, overlapWeak: 0.5, overlapGap: 0.2, // prioritisation is weak: overlapping injects met at most 50%, and 20 points below the others
  window: 5,                       // sessions looked at for prioritisation
  repeat: 3                        // weakest objectives repeated
};
const LEVELS = Object.keys(DIFF); // foundational, intermediate, advanced
// standing objectives (src/progress.js STANDING) and what trains them in a scenario
const STANDING_TRAINS = {
  los: { conflicts: 1, text: 'one more built-in conflict, to be solved before STCA' },
  assume: { inject: 'LATE_TRANSFER', text: 'an inbound flight that is not transferred, to be assumed on time' },
  transfer: { text: 'its criterion; the full traffic load keeps transfers coming' },
  xfl: { inject: 'COORD_REQUEST', text: 'an exit level change requested by the next sector' }
};
// injects that need data the country module may not have
const NEEDS = { OAT_FORMATION: C => C.military, COMLOSS: C => C.military && C.military.qra.length, MILITARY_TSA: C => C.areas.length, TSA_EXTENSION: C => C.areas.length };
const OVERLAP_SET = ['EMERGENCY_DESCENT', 'CLIMB_REQUEST']; // a priority item and a routine request

const pct = r => `${Math.round(r * 100)}%`;
const day = iso => iso.slice(0, 10);

/** Share of a session's objectives met: its graded inject results plus the four standing ones. */
export function sessionRate(r) {
  const done = r.injects.filter(i => i.result && i.result.state !== 'pending');
  const stand = ['losCount', 'lateAssume', 'lateXfer', 'wrongXfl'].map(k => (r.stats[k] === 0 ? 1 : 0));
  return (done.filter(i => i.result.state === 'met').length + stand.reduce((a, b) => a + b, 0)) / (done.length + stand.length);
}

/** Traffic level for the next session from the last one: one step up, one step down, or the same, with the reason. */
export function difficultyStep(rs) {
  if (!rs.length) return { difficulty: 'foundational', reason: 'First session for this trainee: foundational traffic.' };
  const cur = rs[rs.length - 1].scenario.difficulty, i = Math.max(0, LEVELS.indexOf(cur));
  const lastN = n => rs.slice(-n).map(sessionRate), list = rates => rates.map(pct).join(', ');
  const up = lastN(RECOMMEND.upSessions), down = lastN(RECOMMEND.downSessions);
  if (up.length === RECOMMEND.upSessions && up.every(x => x >= RECOMMEND.upRate)) {
    return i < LEVELS.length - 1
      ? { difficulty: LEVELS[i + 1], reason: `Step up to ${LEVELS[i + 1]} traffic: the last ${RECOMMEND.upSessions} sessions met at least ${pct(RECOMMEND.upRate)} of their objectives (${list(up)}).` }
      : { difficulty: cur, reason: `Stay at ${cur} traffic, the highest level: the last ${RECOMMEND.upSessions} sessions met at least ${pct(RECOMMEND.upRate)} of their objectives (${list(up)}).` };
  }
  if (down.length === RECOMMEND.downSessions && down.every(x => x < RECOMMEND.downRate)) {
    return i > 0
      ? { difficulty: LEVELS[i - 1], reason: `Step down to ${LEVELS[i - 1]} traffic: the last ${RECOMMEND.downSessions} sessions met under ${pct(RECOMMEND.downRate)} of their objectives (${list(down)}).` }
      : { difficulty: cur, reason: `Stay at ${cur} traffic, the lowest level: the last ${RECOMMEND.downSessions} sessions met under ${pct(RECOMMEND.downRate)} of their objectives (${list(down)}).` };
  }
  return { difficulty: cur, reason: `Stay at ${cur} traffic: the last sessions met ${list(lastN(RECOMMEND.upSessions))} of their objectives, which is neither ${RECOMMEND.upSessions} in a row at ${pct(RECOMMEND.upRate)} or more nor ${RECOMMEND.downSessions} in a row under ${pct(RECOMMEND.downRate)}.` };
}

/** The sector flown longest ago (never flown first, in the module's order), other than the last one. */
export function sectorNotRecent(rs, C) {
  const ids = C.sectorList.map(s => s.id), lastFlown = new Map();
  for (const r of rs) if (r.country === C.meta.code) lastFlown.set(r.sector, r.savedAt);
  const prev = rs.length && rs[rs.length - 1].country === C.meta.code ? rs[rs.length - 1].sector : null;
  const cand = ids.filter(id => id !== prev || ids.length === 1);
  const never = cand.find(id => !lastFlown.has(id));
  if (never) return { sector: never, reason: `${C.sectors[never].name}: not flown yet${prev ? `; the last session was in ${C.sectors[prev] ? C.sectors[prev].name : prev}` : ''}.` };
  const oldest = cand.reduce((a, b) => (lastFlown.get(b) < lastFlown.get(a) ? b : a));
  return { sector: oldest, reason: `${C.sectors[oldest].name}: last flown ${day(lastFlown.get(oldest))}, the longest ago.` };
}

/**
 * Prioritisation: injects that fired within RECOMMEND.overlapS of another one in the same session,
 * against those that fired on their own, over the last RECOMMEND.window sessions.
 */
export function overlapStats(rs) {
  const o = { overlapMet: 0, overlapGraded: 0, aloneMet: 0, aloneGraded: 0 };
  for (const r of rs.slice(-RECOMMEND.window)) {
    const fired = r.injects.filter(i => i.status === 'fired' && i.firedAt !== null);
    for (const i of fired) {
      if (!i.result || i.result.state === 'pending') continue;
      const near = fired.some(j => j !== i && Math.abs(j.firedAt - i.firedAt) <= RECOMMEND.overlapS), met = i.result.state === 'met' ? 1 : 0;
      if (near) { o.overlapGraded++; o.overlapMet += met; } else { o.aloneGraded++; o.aloneMet += met; }
    }
  }
  const ov = o.overlapGraded ? o.overlapMet / o.overlapGraded : null, al = o.aloneGraded ? o.aloneMet / o.aloneGraded : null;
  o.weak = o.overlapGraded >= RECOMMEND.overlapMin && ov <= RECOMMEND.overlapWeak && (al === null || ov <= al - RECOMMEND.overlapGap);
  o.reason = o.weak
    ? `Prioritisation: injects that came within ${RECOMMEND.overlapS / 60} minutes of another were met ${o.overlapMet} of ${o.overlapGraded} times (${pct(ov)})${al === null ? '' : `, against ${o.aloneMet} of ${o.aloneGraded} (${pct(al)}) on their own`}.`
    : null;
  return o;
}

/** Inject minutes: evenly spread from minute 3 to 3 before the end; an overlap cluster one minute apart near 40% of the session, the others kept 3 minutes clear of it. */
export function placeInjects(types, duration, cluster = []) {
  const last = duration - 3, first = 3;
  const spread = n => Array.from({ length: n }, (_, k) => Math.round(first + (k * (last - first)) / Math.max(1, n - 1)));
  if (!cluster.length) return types.map((type, k) => ({ type, min: spread(types.length)[k] }));
  const c0 = Math.max(first, Math.round(duration * 0.4)), cl = cluster.map((type, k) => ({ type, min: c0 + k }));
  const lo = c0 - 3, hi = c0 + cluster.length - 1 + 3, rest = types.filter(t => !cluster.includes(t));
  const slots = [];
  for (let m = first; m <= last; m++) if (m < lo || m > hi) slots.push(m);
  const pick = rest.map((type, k) => ({ type, min: slots.length ? slots[Math.round((k * (slots.length - 1)) / Math.max(1, rest.length - 1))] : last }));
  return [...cl, ...pick].sort((a, b) => a.min - b.min);
}

const hashSeed = s => { let h = 2166136261; for (const ch of s) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); } return 1000 + ((h >>> 0) % 9000); };

/**
 * Suggest the next scenario for a trainee.
 * @param records   all stored session records (any trainees, any order)
 * @param trainee   the trainee's name or key (case and spacing ignored)
 * @param countries code -> loaded country (loadCountry); the trainee's last country, else the first one
 * @returns { ok: true, file (a scenario file), reasons: [{ rule, text }] } or { ok: false, reasons } with no country
 */
export function suggestScenario(records, trainee, countries) {
  const key = traineeKey(trainee), rs = records.filter(r => traineeKey(r.trainee) === key).sort((a, b) => a.savedAt.localeCompare(b.savedAt) || a.id.localeCompare(b.id));
  const reasons = [], last = rs[rs.length - 1];
  const code = last && countries[last.country] ? last.country : Object.keys(countries)[0];
  if (!code) return { ok: false, reasons: [{ rule: 'country', text: 'No country module is available.' }] };
  const C = countries[code];
  if (last && code !== last.country) reasons.push({ rule: 'country', text: `${C.meta.name}: the last session's country (${last.country}) is not available.` });

  const p = progressOf(rs, key), step = difficultyStep(rs), sec = sectorNotRecent(rs, C), ov = overlapStats(rs);
  const duration = last && DURATIONS.includes(last.scenario.duration) ? last.scenario.duration : 30;
  const usable = t => TYPES[t] && (!NEEDS[t] || NEEDS[t](C));

  // 1. the weakest objectives, repeated
  const chosen = [], add = t => { if (usable(t) && !chosen.includes(t)) chosen.push(t); };
  let extraConflicts = 0;
  const weakest = p.weakest.slice(0, RECOMMEND.repeat);
  for (const w of weakest) {
    const inj = p.injects.find(i => i.label === w.label), st = p.standing.find(s => s.label === w.label);
    if (inj) {
      if (usable(inj.type)) { add(inj.type); reasons.push({ rule: 'repeat', text: w.text }); }
      else reasons.push({ rule: 'repeat', text: `${w.label} is weak, but ${C.meta.name} has no data for it, so it is left out.` });
    } else if (st) {
      const how = STANDING_TRAINS[st.key];
      if (how.inject) add(how.inject);
      if (how.conflicts) extraConflicts += how.conflicts;
      reasons.push({ rule: 'repeat', text: `${w.text} Trained by ${how.text}.` });
    }
  }
  if (!weakest.length) reasons.push({ rule: 'repeat', text: rs.length ? 'No weak objective yet: each needs at least two sessions, and those met every time are not weak. The injects are the standard set for the traffic level.' : 'No sessions yet: the standard injects for the traffic level.' });

  // 2. overlapping injects when prioritisation is the weakness
  let cluster = [];
  if (ov.weak) {
    const focus = chosen.find(t => !OVERLAP_SET.includes(t)) || 'WEATHER_CELL';
    cluster = [...OVERLAP_SET, focus].filter(usable);
    for (const t of cluster) add(t);
    reasons.push({ rule: 'overlap', text: `${ov.reason} This scenario puts ${cluster.map(t => TYPES[t]).join(', ')} within ${cluster.length - 1} minutes of each other.` });
  }

  // 3. the rest of the session from the local builder's set for that traffic level
  const base = buildLocalScenario(C, { sector: sec.sector, difficulty: step.difficulty, duration, seed: hashSeed(`${key}|${rs.length}`), objective: 'x' });
  const n = Math.max(base.injects.length, chosen.length);
  for (const i of base.injects) if (chosen.length < n) add(i.type);
  const injects = placeInjects(chosen.slice(0, Math.max(n, cluster.length)), duration, cluster).map(i => ({ min: Math.min(duration - 1, Math.max(1, i.min)), type: i.type, text: INJECT_TEXT[i.type] }));

  reasons.push({ rule: 'difficulty', text: step.reason }, { rule: 'sector', text: sec.reason });
  const name = rs.length ? p.trainee : String(trainee || '').trim(), focusWords = weakest.map(w => w.label);
  const scn = {
    ...base,
    title: `Suggested${name ? ` for ${name}` : ''}: ${C.sectors[sec.sector].name}, ${step.difficulty}`.slice(0, 90),
    objective: focusWords.length ? `Repeat the weakest objectives: ${focusWords.join(', ')}.${ov.weak ? ' Prioritise when events overlap.' : ''}` : `General radar handling in ${C.sectors[sec.sector].name}.`,
    conflicts: Math.min(5, base.conflicts + extraConflicts),
    // the challenges follow the injects actually chosen, not the base set
    challenges: [
      `${Math.min(5, base.conflicts + extraConflicts)} built-in crossing conflict${Math.min(5, base.conflicts + extraConflicts) === 1 ? '' : 's'} inside ${C.sectors[sec.sector].name}, to be solved before STCA triggers`,
      ...(ov.weak ? [`${cluster.map(t => TYPES[t]).join(', ')} within ${cluster.length - 1} minutes: work them in priority order`] : []),
      ...chosen.filter(t => !cluster.includes(t)).slice(0, ov.weak ? 1 : 2).map(t => `${TYPES[t]} while normal traffic keeps calling`)
    ],
    criteria: [...base.criteria, ...weakest.map(w => `${w.label}: ${w.objective}`)].slice(0, 7),
    injects
  };
  let file = exportScenario(scn, code);
  const v = validateScenarioFile(file, countries);
  if (!v.ok) {
    // never hand back a file that does not load: fall back to the plain local scenario
    file = exportScenario(buildLocalScenario(C, { sector: C.meta.defaultSector || C.sectorList[0].id, difficulty: 'foundational', duration: 30, seed: hashSeed(key), objective: 'General radar handling.' }), code);
    reasons.push({ rule: 'fallback', text: `The suggestion did not validate (${v.errors.join(' ')}), so this is a standard foundational scenario instead.` });
  }
  return { ok: true, file, reasons };
}
