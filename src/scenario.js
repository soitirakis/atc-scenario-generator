// Scenario building: a deterministic local builder, plus the prompt and
// validator used when Claude writes the scenario. Both produce the same shape:
// { title, difficulty, sector, duration, seed, objective, conflicts,
//   challenges[], criteria[], injects[{min, type, text}], wind[{fl, dir, kt}], source }
import { TYPES, DIFF, GRADING } from './sim.js';
import { inSector } from './country.js';
import { defaultWind, normaliseWind } from './atmos.js';

const KEYWORDS = [
  [/weather|\bcb\b|storm|deviat|turbul/i, 'WEATHER_CELL'],
  [/emergenc|7700|pressur|medical|mayday/i, 'EMERGENCY_DESCENT'],
  [/radio|comm|7600|rcf|frequency/i, 'RADIO_FAILURE'],
  [/milit|tsa|\btra\b|fua|segregat/i, 'MILITARY_TSA'],
  [/coordinat|exit level|\bxfl\b|\bloa\b/i, 'COORD_REQUEST'],
  [/late transfer|not transferred|transfer of control|hand.?over/i, 'LATE_TRANSFER'],
  [/bust|level|vertical/i, 'LEVEL_BUST'],
  [/request|workload|busy|load/i, 'CLIMB_REQUEST'],
  [/unplanned|pop.?up|unexpected|late/i, 'POPUP_TRAFFIC']
];

const BASE = {
  foundational: ['CLIMB_REQUEST', 'LEVEL_BUST', 'WEATHER_CELL'],
  intermediate: ['CLIMB_REQUEST', 'WEATHER_CELL', 'LEVEL_BUST', 'RADIO_FAILURE', 'POPUP_TRAFFIC', 'COORD_REQUEST', 'LATE_TRANSFER'],
  advanced: ['WEATHER_CELL', 'LEVEL_BUST', 'RADIO_FAILURE', 'MILITARY_TSA', 'EMERGENCY_DESCENT', 'POPUP_TRAFFIC', 'CLIMB_REQUEST', 'COORD_REQUEST', 'LATE_TRANSFER']
};

export const INJECT_TEXT = {
  CLIMB_REQUEST: 'An aircraft in sector requests a higher cruising level.',
  LEVEL_BUST: 'An aircraft passes its cleared level. Mode S selected level disagrees with the clearance.',
  WEATHER_CELL: 'A CB cell builds on a main flow. Aircraft ask for deviations.',
  RADIO_FAILURE: 'An aircraft in sector stops answering and squawks 7600.',
  EMERGENCY_DESCENT: 'Pressurisation failure: emergency descent to FL100, squawk 7700.',
  MILITARY_TSA: 'A temporary segregated area activates in sector, FL195 and above. Clear traffic out of it.',
  POPUP_TRAFFIC: 'An aircraft enters the sector without prior coordination.',
  COORD_REQUEST: 'The next sector asks for a different exit level for an aircraft about to leave. Accept or refuse.',
  LATE_TRANSFER: 'An inbound aircraft reaches the sector without having been transferred. Coordinate and assume it.'
};

const FOCUS = {
  WEATHER_CELL: 'weather deviations', LEVEL_BUST: 'vertical discipline', RADIO_FAILURE: 'communication failure',
  EMERGENCY_DESCENT: 'emergency handling', MILITARY_TSA: 'civil-military coordination',
  CLIMB_REQUEST: 'request handling under load', POPUP_TRAFFIC: 'unplanned traffic',
  COORD_REQUEST: 'exit level coordination', LATE_TRANSFER: 'transfer of control'
};

export function buildLocalScenario(C, cfg) {
  const types = BASE[cfg.difficulty].slice();
  const hits = KEYWORDS.filter(k => k[0].test(cfg.objective)).map(k => k[1]);
  for (const h of hits.reverse()) { const i = types.indexOf(h); if (i >= 0) types.splice(i, 1); types.unshift(h); }
  const n = Math.min(types.length, cfg.duration <= 20 ? 3 : cfg.duration <= 30 ? (cfg.difficulty === 'foundational' ? 3 : 5) : types.length);
  const chosen = types.slice(0, n);
  const span = cfg.duration - 6;
  const injects = chosen.map((t, i) => ({ min: Math.round(3 + (i * span) / Math.max(1, n - 1)), type: t, text: INJECT_TEXT[t] }));
  const sec = C.sectors[cfg.sector];
  const conflicts = DIFF[cfg.difficulty].conflicts + (/conflict|separat|stca/i.test(cfg.objective) ? 1 : 0);
  return {
    title: `${sec.name}: ${FOCUS[chosen[0]]} with ${DIFF[cfg.difficulty].label.toLowerCase()} traffic`,
    difficulty: cfg.difficulty, sector: cfg.sector, duration: cfg.duration, seed: cfg.seed, objective: cfg.objective, conflicts,
    challenges: [
      `${conflicts} built-in crossing conflict${conflicts > 1 ? 's' : ''} inside ${sec.name} that must be solved before STCA triggers`,
      `${TYPES[chosen[0]]} while normal traffic keeps calling`,
      chosen[1] ? `${TYPES[chosen[1]]} overlapping with the first event` : 'Keeping the overall sector picture'
    ],
    criteria: ['No loss of separation (5 NM / 1000 ft)', 'Every request answered within 60 s', 'Correct priority order: emergencies and STCA before routine requests', 'Every flight assumed before it enters and transferred at its agreed exit level'],
    injects, wind: defaultWind(cfg.seed), source: 'local'
  };
}

export function buildClaudePrompt(C, cfg) {
  const sec = C.sectors[cfg.sector];
  const near = C.pointList.filter(p => inSector(p.xy, sec)).slice(0, 40).map(p => p.id).join(', ');
  const count = cfg.difficulty === 'foundational' ? '2-3' : cfg.difficulty === 'intermediate' ? '3-5' : '5-7';
  return `You design air traffic control simulator scenarios for en-route radar training in ${C.meta.firName} (${C.meta.fir}), ${C.meta.name}.
Training sector: ${sec.name} (${sec.rad}). Significant points in it: ${near}.
Traffic level: ${cfg.difficulty}. Session length: ${cfg.duration} minutes.
Instructor's training objective: "${cfg.objective}"

The simulator can execute ONLY these inject types:
${Object.keys(TYPES).join(', ')}.
Choose ${count} injects that serve the objective, ordered in time between minute 2 and minute ${cfg.duration - 3}. Overlap events when the objective is about workload or prioritisation.

Reply with only this JSON:
{"title": string (max 70 chars), "objective": string (one sentence), "conflicts": integer 0-5 (crossing conflicts to build into the traffic), "challenges": [3 strings], "criteria": [3 strings, observable and measurable], "injects": [{"min": integer, "type": one of the types above, "text": string (what the instructor sees, max 120 chars, name real points from the list where useful)}]}`;
}

/** Validate Claude's JSON into a runnable scenario. Throws if nothing usable. */
export function parseClaudeScenario(j, cfg) {
  if (!j || typeof j !== 'object') throw new Error('Not an object');
  const injects = (Array.isArray(j.injects) ? j.injects : [])
    .filter(i => i && TYPES[i.type])
    .map(i => ({
      min: Math.max(1, Math.min(cfg.duration - 2, Math.round(+i.min || 3))),
      type: i.type,
      text: String(i.text || INJECT_TEXT[i.type]).slice(0, 160)
    }))
    .sort((a, b) => a.min - b.min);
  if (!injects.length) throw new Error('No valid injects');
  const strs = (arr, fallback) => (Array.isArray(arr) && arr.length ? arr.slice(0, 4).map(String) : fallback);
  return {
    title: String(j.title || 'Generated scenario').slice(0, 90),
    difficulty: cfg.difficulty, sector: cfg.sector, duration: cfg.duration, seed: cfg.seed,
    objective: String(j.objective || cfg.objective),
    conflicts: Math.max(0, Math.min(5, Math.round(Number.isFinite(+j.conflicts) ? +j.conflicts : DIFF[cfg.difficulty].conflicts))),
    challenges: strs(j.challenges, []),
    criteria: strs(j.criteria, ['No loss of separation (5 NM / 1000 ft)']),
    injects, wind: defaultWind(cfg.seed), source: 'claude'
  };
}

/* ---------- scenario files: export, import, library ---------- */
export const SCHEMA_VERSION = 1;
export const DURATIONS = [20, 30, 45];

/**
 * The file written by Export: everything needed to replay the session exactly (same seed,
 * sector, traffic level, conflicts and wind give the same traffic), plus each inject's
 * objective for the reader. Import ignores those objectives: grading always uses GRADING.
 */
export function exportScenario(scn, country) {
  return {
    schemaVersion: SCHEMA_VERSION,
    title: scn.title, country, sector: scn.sector, difficulty: scn.difficulty, duration: scn.duration,
    seed: scn.seed, objective: scn.objective, conflicts: scn.conflicts,
    challenges: scn.challenges || [], criteria: scn.criteria || [],
    wind: (scn.wind || []).map(w => ({ fl: w.fl, dir: w.dir, kt: w.kt })),
    injects: scn.injects.map(i => ({ min: i.min, type: i.type, text: i.text, objective: GRADING[i.type].text }))
  };
}

/**
 * Check a scenario file before loading it. Pure: `countries` maps a country code to its
 * loaded data (loadCountry). Returns { ok: true, country, scenario } or { ok: false, errors }
 * with every problem found, in plain words.
 */
export function validateScenarioFile(j, countries) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { ok: false, errors: ['This is not a scenario file: expected a JSON object.'] };
  if (j.schemaVersion !== SCHEMA_VERSION) {
    return { ok: false, errors: [j.schemaVersion === undefined
      ? `This is not a scenario file: it has no schemaVersion. Files from this simulator have schemaVersion ${SCHEMA_VERSION}.`
      : `Schema version ${JSON.stringify(j.schemaVersion)} is not supported. This simulator reads schemaVersion ${SCHEMA_VERSION}.`] };
  }
  const errors = [];
  const C = countries[j.country];
  if (!C) errors.push(`Unknown country ${JSON.stringify(j.country)}. Available: ${Object.keys(countries).join(', ')}.`);
  else if (!C.sectors[j.sector]) errors.push(`Unknown sector ${JSON.stringify(j.sector)} for ${C.meta.name}. Available: ${Object.keys(C.sectors).join(', ')}.`);
  if (!DIFF[j.difficulty]) errors.push(`Unknown traffic level ${JSON.stringify(j.difficulty)}. Use ${Object.keys(DIFF).join(', ')}.`);
  const dur = j.duration;
  if (!DURATIONS.includes(dur)) errors.push(`Session length must be ${DURATIONS.join(', ')} minutes, not ${JSON.stringify(dur)}.`);
  if (!Number.isInteger(j.seed) || j.seed < 1) errors.push(`Seed must be a whole number of 1 or more, not ${JSON.stringify(j.seed)}.`);
  if (!Number.isInteger(j.conflicts) || j.conflicts < 0 || j.conflicts > 5) errors.push(`Built-in conflicts must be 0 to 5, not ${JSON.stringify(j.conflicts)}.`);
  let wind = [];
  try { wind = normaliseWind(j.wind === undefined ? [] : j.wind); } catch (e) { errors.push(`${e.message}.`); }
  if (!Array.isArray(j.injects)) errors.push('Injects must be a list.');
  else j.injects.forEach((i, k) => {
    const n = `Inject ${k + 1}`;
    if (!i || !TYPES[i.type]) errors.push(`${n}: unknown type ${JSON.stringify(i && i.type)}. Known types: ${Object.keys(TYPES).join(', ')}.`);
    if (!i || !Number.isInteger(i.min)) errors.push(`${n}: minute must be a whole number, not ${JSON.stringify(i && i.min)}.`);
    else if (DURATIONS.includes(dur) && (i.min < 1 || i.min > dur - 1)) errors.push(`${n} at minute ${i.min} is outside the ${dur}-minute session. Use minute 1 to ${dur - 1}.`);
  });
  if (errors.length) return { ok: false, errors };
  const strs = a => (Array.isArray(a) ? a.map(String) : []);
  return {
    ok: true, country: j.country,
    scenario: {
      title: String(j.title || 'Imported scenario').slice(0, 90),
      difficulty: j.difficulty, sector: j.sector, duration: dur, seed: j.seed,
      objective: String(j.objective || 'General radar handling.'), conflicts: j.conflicts,
      challenges: strs(j.challenges), criteria: strs(j.criteria),
      injects: j.injects.map(i => ({ min: i.min, type: i.type, text: String(i.text || INJECT_TEXT[i.type]).slice(0, 160) })).sort((a, b) => a.min - b.min),
      wind, source: 'file'
    }
  };
}
