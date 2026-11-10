// Session records: what a finished session leaves for the history and the debrief. DOM-free like
// sim.js: built from a Sim, checked by validateRecord, stored by src/store.js, rendered by main.js.
import { exportScenario, validateScenarioFile } from './scenario.js';
import { TYPES } from './sim.js';

export const SCHEMA_VERSION = 1;
export const KIND = 'atc-session-record';
export const BUNDLE_KIND = 'atc-session-records';
export const NAME_MAX = 60;
/** Debrief statistics kept in a record (the ones the debrief shows). null where nothing was measured. */
export const STAT_KEYS = ['losCount', 'losSec', 'minSep', 'reqs', 'reqAnswered', 'reqMissed', 'avgResponse', 'selfDev', 'tsaInf', 'emgAckT', 'lateAssume', 'lateXfer', 'wrongXfl', 'cmds', 'injectsFired', 'injectsTotal'];
const NULLABLE = new Set(['minSep', 'avgResponse', 'emgAckT']);
export const CLEARANCE_RESULTS = ['ok', 'blocked', 'no reply', 'unable', 'say again'];
const RESULT_STATES = ['pending', 'met', 'not met'];

const name = s => String(s || '').trim().replace(/\s+/g, ' ').slice(0, NAME_MAX);

/**
 * The record of a session, from the Sim that ran it.
 * @param sim  a Sim with a loaded scenario (usually ended)
 * @param o    { country, trainee, instructor, savedAt (ISO, default now), id (default from savedAt and seed) }
 */
export function buildRecord(sim, o) {
  const scn = sim.scenario, d = sim.debrief(), savedAt = o.savedAt || new Date().toISOString();
  const injects = d.injects.map(i => ({ min: i.min, type: i.type, label: i.label, target: i.target || null, status: i.status, firedAt: i.firedAt, objective: i.objective, result: i.result ? { state: i.result.state, t: i.result.t, reason: i.result.reason } : null }));
  return {
    schemaVersion: SCHEMA_VERSION, kind: KIND,
    id: o.id || `${savedAt}-${scn.seed}`, savedAt,
    trainee: name(o.trainee), instructor: name(o.instructor),
    country: o.country, sector: scn.sector, sectorName: sim.sector.name, seed: scn.seed,
    completed: !!sim.ended, elapsedS: sim.t,
    scenario: exportScenario(scn, o.country),
    stats: Object.fromEntries(STAT_KEYS.map(k => [k, d[k] ?? null])),
    injects,
    timeline: d.timeline.map(e => ({ t: e.t, text: e.text, cls: e.cls || '' })),
    clearances: sim.clearances.map(c => ({ t: c.t, cs: c.cs, text: c.text, result: c.result }))
  };
}

/** Objectives met and graded, and losses of separation: the line in the history list. */
export function summary(r) {
  const graded = r.injects.filter(i => i.result && i.result.state !== 'pending').length;
  const met = r.injects.filter(i => i.result && i.result.state === 'met').length;
  const los = r.stats.losCount;
  return {
    met, graded, los,
    text: `${graded ? `${met}/${graded} objectives met` : 'no graded injects'} · ${los ? `${los} loss${los > 1 ? 'es' : ''} of separation` : 'no loss of separation'}${r.completed ? '' : ' · ended early'}`
  };
}

/** The debrief view of a record: the shape Sim.debrief() returns. */
export const debriefOf = r => ({ ...r.stats, injects: r.injects, timeline: r.timeline });

/** Several records in one file (Export all). */
export const bundle = records => ({ schemaVersion: SCHEMA_VERSION, kind: BUNDLE_KIND, records });

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isStr = v => typeof v === 'string';

/**
 * Check a session record. Pure: `countries` maps a country code to its loaded data (loadCountry);
 * the embedded scenario must load, so Replay works. Returns { ok: true, record } or { ok: false, errors }.
 */
export function validateRecord(j, countries) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { ok: false, errors: ['This is not a session record: expected a JSON object.'] };
  if (j.kind !== KIND) return { ok: false, errors: [`This is not a session record: kind is ${JSON.stringify(j.kind)}, expected "${KIND}".`] };
  if (j.schemaVersion !== SCHEMA_VERSION) return { ok: false, errors: [`Record schema version ${JSON.stringify(j.schemaVersion)} is not supported. This simulator reads schemaVersion ${SCHEMA_VERSION}.`] };
  const errors = [];
  if (!isStr(j.id) || !j.id) errors.push('id must be a non-empty string.');
  if (!isStr(j.savedAt) || Number.isNaN(Date.parse(j.savedAt))) errors.push(`savedAt must be a date and time, not ${JSON.stringify(j.savedAt)}.`);
  for (const k of ['trainee', 'instructor']) if (!isStr(j[k]) || j[k].length > NAME_MAX) errors.push(`${k} must be text of at most ${NAME_MAX} characters.`);
  if (!isStr(j.country) || !isStr(j.sector) || !isStr(j.sectorName)) errors.push('country, sector and sectorName must be text.');
  if (!Number.isInteger(j.seed)) errors.push(`seed must be a whole number, not ${JSON.stringify(j.seed)}.`);
  if (typeof j.completed !== 'boolean') errors.push('completed must be true or false.');
  if (!isNum(j.elapsedS) || j.elapsedS < 0) errors.push('elapsedS must be a number of seconds.');

  const s = validateScenarioFile(j.scenario, countries);
  if (!s.ok) errors.push(...s.errors.map(e => `Scenario: ${e}`));
  else if (j.scenario.country !== j.country || j.scenario.sector !== j.sector || j.scenario.seed !== j.seed) errors.push('Scenario: its country, sector and seed must match the record.');

  if (!j.stats || typeof j.stats !== 'object') errors.push('stats must be an object.');
  else for (const k of STAT_KEYS) if (!(isNum(j.stats[k]) || (NULLABLE.has(k) && j.stats[k] === null))) errors.push(`stats.${k} must be a number${NULLABLE.has(k) ? ' or null' : ''}.`);

  if (!Array.isArray(j.injects)) errors.push('injects must be a list.');
  else j.injects.forEach((i, k) => {
    const n = `Inject ${k + 1}`;
    if (!i || !TYPES[i.type]) { errors.push(`${n}: unknown type ${JSON.stringify(i && i.type)}.`); return; }
    if (!Number.isInteger(i.min)) errors.push(`${n}: min must be a whole number.`);
    if (!['pending', 'fired'].includes(i.status)) errors.push(`${n}: status must be pending or fired.`);
    if (i.firedAt !== null && !isNum(i.firedAt)) errors.push(`${n}: firedAt must be a number or null.`);
    const r = i.result;
    if (r !== null && (!r || !RESULT_STATES.includes(r.state) || !(r.t === null || isNum(r.t)) || !isStr(r.reason))) errors.push(`${n}: result must be null or { state: ${RESULT_STATES.join(' | ')}, t, reason }.`);
  });
  if (!Array.isArray(j.timeline) || j.timeline.some(e => !e || !isNum(e.t) || !isStr(e.text) || !isStr(e.cls))) errors.push('timeline must be a list of { t, text, cls }.');
  if (!Array.isArray(j.clearances) || j.clearances.some(c => !c || !isNum(c.t) || !isStr(c.cs) || !isStr(c.text) || !CLEARANCE_RESULTS.includes(c.result))) errors.push(`clearances must be a list of { t, cs, text, result: ${CLEARANCE_RESULTS.join(' | ')} }.`);
  return errors.length ? { ok: false, errors } : { ok: true, record: j };
}

/**
 * Records from an imported file: one record, or a bundle from Export all. Each record is checked
 * on its own, so one bad record does not block the others.
 * Returns { records: [valid], errors: [lines] }.
 */
export function readImport(j, countries) {
  if (j && j.kind === BUNDLE_KIND) {
    if (j.schemaVersion !== SCHEMA_VERSION || !Array.isArray(j.records)) return { records: [], errors: [`This records file is not supported: expected schemaVersion ${SCHEMA_VERSION} and a list of records.`] };
    const records = [], errors = [];
    j.records.forEach((r, k) => {
      const v = validateRecord(r, countries);
      if (v.ok) records.push(v.record); else errors.push(...v.errors.map(e => `Record ${k + 1}: ${e}`));
    });
    return { records, errors };
  }
  const v = validateRecord(j, countries);
  return v.ok ? { records: [v.record], errors: [] } : { records: [], errors: v.errors };
}

/** File name for an exported record, e.g. session-ro-arg-4127-2026-11-10-1432.json. */
export const recordFileName = r => `session-${r.country}-${r.sector}-${r.seed}-${r.savedAt.slice(0, 16).replace('T', '-').replace(':', '')}.json`.toLowerCase();
