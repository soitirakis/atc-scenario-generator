// Scenario building: a deterministic local builder, plus the prompt and
// validator used when Claude writes the scenario. Both produce the same shape:
// { title, difficulty, sector, duration, seed, objective, conflicts,
//   challenges[], criteria[], injects[{min, type, text}], source }
import { TYPES, DIFF } from './sim.js';
import { inSector } from './country.js';

const KEYWORDS = [
  [/weather|\bcb\b|storm|deviat|turbul/i, 'WEATHER_CELL'],
  [/emergenc|7700|pressur|medical|mayday/i, 'EMERGENCY_DESCENT'],
  [/radio|comm|7600|rcf|frequency/i, 'RADIO_FAILURE'],
  [/milit|tsa|\btra\b|fua|segregat/i, 'MILITARY_TSA'],
  [/bust|level|vertical/i, 'LEVEL_BUST'],
  [/request|workload|busy|load/i, 'CLIMB_REQUEST'],
  [/unplanned|pop.?up|unexpected|late/i, 'POPUP_TRAFFIC']
];

const BASE = {
  foundational: ['CLIMB_REQUEST', 'LEVEL_BUST', 'WEATHER_CELL'],
  intermediate: ['CLIMB_REQUEST', 'WEATHER_CELL', 'LEVEL_BUST', 'RADIO_FAILURE', 'POPUP_TRAFFIC'],
  advanced: ['WEATHER_CELL', 'LEVEL_BUST', 'RADIO_FAILURE', 'MILITARY_TSA', 'EMERGENCY_DESCENT', 'POPUP_TRAFFIC', 'CLIMB_REQUEST']
};

export const INJECT_TEXT = {
  CLIMB_REQUEST: 'An aircraft in sector requests a higher cruising level.',
  LEVEL_BUST: 'An aircraft passes its cleared level. Mode S selected level disagrees with the clearance.',
  WEATHER_CELL: 'A CB cell builds on a main flow. Aircraft ask for deviations.',
  RADIO_FAILURE: 'An aircraft in sector stops answering and squawks 7600.',
  EMERGENCY_DESCENT: 'Pressurisation failure: emergency descent to FL100, squawk 7700.',
  MILITARY_TSA: 'A temporary segregated area activates in sector, FL195 and above. Clear traffic out of it.',
  POPUP_TRAFFIC: 'An aircraft enters the sector without prior coordination.'
};

const FOCUS = {
  WEATHER_CELL: 'weather deviations', LEVEL_BUST: 'vertical discipline', RADIO_FAILURE: 'communication failure',
  EMERGENCY_DESCENT: 'emergency handling', MILITARY_TSA: 'civil-military coordination',
  CLIMB_REQUEST: 'request handling under load', POPUP_TRAFFIC: 'unplanned traffic'
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
    criteria: ['No loss of separation (5 NM / 1000 ft)', 'Every request answered within 60 s', 'Correct priority order: emergencies and STCA before routine requests'],
    injects, source: 'local'
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
    injects, source: 'claude'
  };
}
