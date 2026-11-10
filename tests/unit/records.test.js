import { describe, it, expect } from 'vitest';
import RO from '../../data/RO/index.js';
import HU from '../../data/HU/index.js';
import { loadCountry } from '../../src/country.js';
import { Sim } from '../../src/sim.js';
import { buildLocalScenario, exportScenario, validateScenarioFile } from '../../src/scenario.js';
import { SCHEMA_VERSION, KIND, NAME_MAX, STAT_KEYS, buildRecord, validateRecord, readImport, summary, debriefOf, bundle, recordFileName } from '../../src/records.js';
import { openRecords } from '../../src/store.js';

const C = loadCountry(RO), countries = { RO: C, HU: loadCountry(HU) };
const run = (sim, s) => { for (let i = 0; i < s; i++) sim.step(); };
const free = sim => { for (let i = 0; i < 30 && sim.freqBusy(); i++) sim.step(); };
const SAVED = '2026-11-10T14:32:05.000Z';

/** A whole 20-minute session with a level bust and some clearances, ended. */
function finished() {
  const scn = buildLocalScenario(C, { sector: 'ARG', difficulty: 'intermediate', duration: 20, seed: 4127, objective: 'Records test.' });
  scn.injects = [{ min: 2, type: 'LEVEL_BUST', text: '' }];
  const sim = new Sim(C); sim.load(scn);
  run(sim, 30);
  const a = sim.ac.find(x => x.ctl === 'ass');
  expect(sim.clearLevel(a.id, a.cfl - 20).ok).toBe(true);
  expect(sim.turn(a.id, 90)).toMatchObject({ ok: false }); // the frequency is still busy with the readback
  free(sim);
  while (!sim.ended) sim.step();
  return { sim, a };
}
const base = (() => { const { sim, a } = finished(); return { sim, a, rec: buildRecord(sim, { country: 'RO', trainee: '  Ana   Pop ', instructor: 'I. Ionescu', savedAt: SAVED }) }; })();
const copy = () => structuredClone(base.rec);

describe('building a session record', () => {
  it('carries the scenario file, seed, country and sector, names and the session state', () => {
    const r = base.rec;
    expect(r).toMatchObject({ schemaVersion: SCHEMA_VERSION, kind: KIND, id: `${SAVED}-4127`, savedAt: SAVED, trainee: 'Ana Pop', instructor: 'I. Ionescu', country: 'RO', sector: 'ARG', sectorName: 'ARGES', seed: 4127, completed: true, elapsedS: 1200 });
    expect(r.scenario).toEqual(exportScenario(base.sim.scenario, 'RO'));
  });
  it('keeps the debrief stats, per-inject results and the timeline as the debrief shows them', () => {
    const r = base.rec, d = base.sim.debrief();
    expect(Object.keys(r.stats)).toEqual(STAT_KEYS);
    for (const k of STAT_KEYS) expect(r.stats[k], k).toEqual(d[k] ?? null);
    expect(r.injects).toHaveLength(1);
    expect(r.injects[0]).toMatchObject({ type: 'LEVEL_BUST', status: 'fired', result: { state: expect.stringMatching(/^(met|not met)$/) } });
    expect(r.timeline).toEqual(d.timeline);
    expect(debriefOf(r)).toMatchObject({ losCount: d.losCount, cmds: d.cmds, injects: r.injects, timeline: r.timeline });
  });
  it('keeps the whole clearance log with how each transmission ended (the on-screen log is trimmed)', () => {
    const { a, rec } = base;
    expect(rec.clearances[0]).toMatchObject({ cs: a.cs, text: expect.stringMatching(/^descend FL/), result: 'ok' });
    expect(rec.clearances[1]).toMatchObject({ cs: a.cs, text: 'turn heading 090', result: 'blocked' });
    expect(rec.clearances.length).toBeGreaterThanOrEqual(2);
    expect(rec.stats.cmds).toBe(rec.clearances.filter(c => c.result === 'ok' && !/^(assume|emergency|acknowledged|military)/.test(c.text)).length);
  });
  it('records a radio failure and the routine actions', () => {
    const sim = new Sim(C);
    sim.load(buildLocalScenario(C, { sector: 'ARG', difficulty: 'intermediate', duration: 20, seed: 9, objective: 'x' }));
    run(sim, 5);
    const a = sim.ac.find(x => x.ctl === 'ass');
    a.rcf = sim.t + 600;
    sim.clearLevel(a.id, 300);
    const b = sim.ac.find(x => x.ctl === 'ass' && x !== a);
    sim.transfer(b.id);
    expect(sim.clearances.map(c => [c.cs, c.result])).toEqual([[a.cs, 'no reply'], [b.cs, 'ok']]);
    expect(sim.clearances[1].text).toMatch(/^transfer at FL\d{3}$/);
  });
  it('names are trimmed and cut to NAME_MAX; missing names are empty', () => {
    const r = buildRecord(base.sim, { country: 'RO', trainee: 'x'.repeat(100), savedAt: SAVED, id: 'r1' });
    expect([r.trainee.length, r.instructor, r.id]).toEqual([NAME_MAX, '', 'r1']);
    expect(buildRecord(base.sim, { country: 'RO' }).savedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  });
  it('a session ended early is marked so', () => {
    const sim = new Sim(C);
    sim.load(buildLocalScenario(C, { sector: 'ARG', difficulty: 'foundational', duration: 20, seed: 3, objective: 'x' }));
    run(sim, 60);
    const r = buildRecord(sim, { country: 'RO', savedAt: SAVED });
    expect([r.completed, r.elapsedS]).toEqual([false, 60]);
    expect(summary(r).text).toMatch(/ended early$/);
  });
});

describe('summary and file names', () => {
  it('objectives met out of graded, and losses of separation', () => {
    const r = copy();
    r.injects = [{ ...r.injects[0], result: { state: 'met', t: 40, reason: 'x' } }, { ...r.injects[0], result: { state: 'not met', t: null, reason: 'y' } }, { ...r.injects[0], result: null }];
    r.stats.losCount = 2;
    expect(summary(r)).toEqual({ met: 1, graded: 2, los: 2, text: '1/2 objectives met · 2 losses of separation' });
    r.injects = []; r.stats.losCount = 0;
    expect(summary(r).text).toBe('no graded injects · no loss of separation');
  });
  it('file name from country, sector, seed and save time', () => {
    expect(recordFileName(base.rec)).toBe('session-ro-arg-4127-2026-11-10-1432.json');
  });
});

describe('validating a record', () => {
  it('a built record is valid, also after a JSON round trip', () => {
    expect(validateRecord(base.rec, countries)).toEqual({ ok: true, record: base.rec });
    expect(validateRecord(JSON.parse(JSON.stringify(base.rec)), countries).ok).toBe(true);
  });
  it('rejects what is not a record, another kind, or another schema version', () => {
    expect(validateRecord([], countries).errors).toEqual(['This is not a session record: expected a JSON object.']);
    expect(validateRecord(base.rec.scenario, countries).errors[0]).toMatch(/This is not a session record: kind is undefined/);
    expect(validateRecord({ ...copy(), schemaVersion: 2 }, countries).errors).toEqual([`Record schema version 2 is not supported. This simulator reads schemaVersion ${SCHEMA_VERSION}.`]);
  });
  it('lists every problem in plain words', () => {
    const r = copy();
    Object.assign(r, { id: '', savedAt: 'yesterday', trainee: 'x'.repeat(NAME_MAX + 1), seed: 1.5, completed: 'yes', elapsedS: -1 });
    r.stats.losCount = '0'; r.stats.minSep = undefined;
    r.injects = [{ type: 'ENGINE_FIRE' }, { ...base.rec.injects[0], status: 'done', min: 'x', firedAt: 'x', result: { state: 'passed', t: 1, reason: '' } }];
    r.timeline = [{ t: 'x' }];
    r.clearances = [{ t: 1, cs: 'A', text: 'b', result: 'maybe' }];
    const e = validateRecord(r, countries).errors;
    for (const m of [/^id must be/, /^savedAt must be a date and time, not "yesterday"/, /^trainee must be text of at most 60/, /^seed must be a whole number/, /^completed must be true or false/, /^elapsedS must be/,
      /^stats.losCount must be a number\.$/, /^stats.minSep must be a number or null/, /^Inject 1: unknown type "ENGINE_FIRE"/, /^Inject 2: min must be/, /^Inject 2: status must be/, /^Inject 2: firedAt must be/, /^Inject 2: result must be null or/,
      /^timeline must be a list/, /^clearances must be a list of .*result: ok \| blocked/]) expect(e.some(x => m.test(x)), String(m)).toBe(true);
  });
  it('the embedded scenario must load (so Replay works) and match the record', () => {
    expect(validateRecord({ ...copy(), scenario: { ...base.rec.scenario, sector: 'ZZZ' } }, countries).errors.join('\n')).toMatch(/^Scenario: Unknown sector "ZZZ"/);
    expect(validateRecord({ ...copy(), seed: 1 }, countries).errors).toEqual(['Scenario: its country, sector and seed must match the record.']);
    expect(validateRecord(copy(), { HU: countries.HU }).errors[0]).toMatch(/^Scenario: Unknown country "RO"/);
    expect(validateRecord({ ...copy(), stats: null }, countries).errors).toContain('stats must be an object.');
    expect(validateRecord({ ...copy(), injects: 'none' }, countries).errors).toContain('injects must be a list.');
    expect(validateRecord({ ...copy(), country: 1 }, countries).errors).toContain('country, sector and sectorName must be text.');
  });
  it('Replay: the record\'s scenario reproduces the same traffic', () => {
    const v = validateScenarioFile(JSON.parse(JSON.stringify(base.rec.scenario)), countries);
    expect(v.ok).toBe(true);
    const s1 = new Sim(C), s2 = new Sim(C);
    s1.load(buildLocalScenario(C, { sector: 'ARG', difficulty: 'intermediate', duration: 20, seed: 4127, objective: 'Records test.' }));
    s1.scenario.injects = []; s2.load(v.scenario); s2.scenario.injects = [];
    run(s1, 300); run(s2, 300);
    expect(s2.ac.map(a => [a.cs, a.x.toFixed(4), a.fl.toFixed(2)])).toEqual(s1.ac.map(a => [a.cs, a.x.toFixed(4), a.fl.toFixed(2)]));
  });
});

describe('importing', () => {
  it('one record, or a bundle from Export all with each record checked on its own', () => {
    expect(readImport(base.rec, countries)).toEqual({ records: [base.rec], errors: [] });
    const bad = { ...copy(), seed: 'x' };
    const r = readImport(JSON.parse(JSON.stringify(bundle([base.rec, bad]))), countries);
    expect(r.records).toHaveLength(1);
    expect(r.errors.every(e => e.startsWith('Record 2: '))).toBe(true);
  });
  it('rejects an unsupported bundle, or a file that is no record', () => {
    expect(readImport({ kind: 'atc-session-records', schemaVersion: 9, records: [] }, countries).errors[0]).toMatch(/This records file is not supported/);
    expect(readImport({ hello: 1 }, countries)).toEqual({ records: [], errors: [expect.stringMatching(/This is not a session record/)] });
  });
});

describe('storage unavailable', () => {
  it('without IndexedDB: a memory store that says why; save, list, get and delete still work', async () => {
    const s = await openRecords(null);
    expect(s.available).toBe(false);
    expect(s.reason).toMatch(/no IndexedDB/);
    await s.put({ ...copy(), id: 'a', savedAt: '2026-01-01T00:00:00Z' });
    await s.put({ ...copy(), id: 'b', savedAt: '2026-02-01T00:00:00Z' });
    expect((await s.list()).map(r => r.id)).toEqual(['b', 'a']); // newest first
    expect((await s.get('a')).id).toBe('a');
    await s.remove('a');
    expect([await s.get('a'), (await s.list()).length]).toEqual([null, 1]);
  });
  it('when the browser refuses to open the database (private mode)', async () => {
    const idb = { open: () => { const r = {}; setTimeout(() => { r.error = { name: 'SecurityError' }; r.onerror(); }); return r; } };
    const s = await openRecords(idb);
    expect(s.available).toBe(false);
    expect(s.reason).toMatch(/refused storage \(SecurityError\)/);
  });
});
