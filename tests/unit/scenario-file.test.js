import { describe, it, expect } from 'vitest';
import RO from '../../data/RO/index.js';
import HU from '../../data/HU/index.js';
import { LIBRARY } from '../../data/scenarios/index.js';
import { loadCountry } from '../../src/country.js';
import { Sim, GRADING } from '../../src/sim.js';
import { buildLocalScenario, exportScenario, validateScenarioFile, SCHEMA_VERSION } from '../../src/scenario.js';

const countries = { RO: loadCountry(RO), HU: loadCountry(HU) };
const cfg = { sector: 'ARG', difficulty: 'intermediate', duration: 30, seed: 4127, objective: 'General radar handling.' };
const file = (o = {}) => ({ ...exportScenario(buildLocalScenario(countries.RO, cfg), 'RO'), ...o });
/** A trainee doing only the sector routine: assume on first call, transfer near the exit at the agreed level. */
const routine = sim => {
  for (const a of sim.ac) {
    if (a.ctl === 'pend' || a.noXfer) sim.assume(a.id);
    if (a.ctl !== 'ass' || a.tExit === null) continue;
    if (a.xfl !== null && Math.round(a.cfl) !== a.xfl && a.tExit <= 400) sim.clearLevel(a.id, a.xfl);
    if (a.tExit <= 45) sim.transfer(a.id);
  }
};
const errorsOf = j => { const r = validateScenarioFile(j, countries); expect(r.ok).toBe(false); return r.errors; };

describe('scenario export', () => {
  it('writes the schema version, the country and every field needed to replay the session', () => {
    const j = file();
    expect(j).toMatchObject({ schemaVersion: SCHEMA_VERSION, country: 'RO', sector: 'ARG', difficulty: 'intermediate', duration: 30, seed: 4127 });
    for (const k of ['objective', 'conflicts', 'wind', 'injects', 'criteria']) expect(j, k).toHaveProperty(k);
    expect(j.wind.length).toBeGreaterThan(0);
    for (const i of j.injects) expect(i.objective).toBe(GRADING[i.type].text);
  });

  it('leaves out session state: inject status, results and targets are not exported', () => {
    const scn = buildLocalScenario(countries.RO, cfg), sim = new Sim(countries.RO);
    sim.load(scn);
    for (let i = 0; i < 400; i++) sim.step();
    expect(scn.injects[0].status).toBe('fired');
    expect(Object.keys(exportScenario(scn, 'RO').injects[0]).sort()).toEqual(['min', 'objective', 'text', 'type']);
  });

  it('round trip: an exported file validates back to the same scenario and the same traffic', () => {
    const scn = buildLocalScenario(countries.RO, cfg);
    const r = validateScenarioFile(JSON.parse(JSON.stringify(exportScenario(scn, 'RO'))), countries);
    expect(r.ok).toBe(true);
    expect(r.country).toBe('RO');
    for (const k of ['sector', 'difficulty', 'duration', 'seed', 'objective', 'conflicts', 'wind']) expect(r.scenario[k], k).toEqual(scn[k]);
    expect(r.scenario.injects.map(i => [i.min, i.type])).toEqual(scn.injects.map(i => [i.min, i.type]));
    const a = new Sim(countries.RO), b = new Sim(countries.RO);
    a.load(scn); b.load(r.scenario);
    for (let i = 0; i < 120; i++) { a.step(); b.step(); }
    const pos = s => s.ac.map(x => [x.cs, x.x.toFixed(4), x.y.toFixed(4), x.fl.toFixed(2)]);
    expect(pos(b)).toEqual(pos(a));
  });

  it('import ignores the objectives in the file: grading always uses GRADING', () => {
    const j = file();
    j.injects[0].objective = 'Anything at all';
    const r = validateScenarioFile(j, countries);
    expect(r.ok).toBe(true);
    expect(r.scenario.injects[0]).not.toHaveProperty('objective');
  });
});

describe('scenario file validation errors', () => {
  it('wrong schema version', () => {
    expect(errorsOf(file({ schemaVersion: 2 }))).toEqual(['Schema version 2 is not supported. This simulator reads schemaVersion 1.']);
  });
  it('missing schema version: not a scenario file', () => {
    const { schemaVersion, ...rest } = file();
    expect(errorsOf(rest)[0]).toMatch(/^This is not a scenario file: it has no schemaVersion/);
    expect(errorsOf([])[0]).toMatch(/^This is not a scenario file/);
    expect(errorsOf(null)[0]).toMatch(/^This is not a scenario file/);
  });
  it('unknown country', () => {
    expect(errorsOf(file({ country: 'BG' }))).toEqual(['Unknown country "BG". Available: RO, HU.']);
  });
  it('unknown sector for the country', () => {
    const e = errorsOf(file({ country: 'HU', sector: 'ARG' }));
    expect(e).toHaveLength(1);
    expect(e[0]).toMatch(/^Unknown sector "ARG" for Hungary\. Available: WEST, NORTH, EAST, SOUTH, FIR\.$/);
  });
  it('unknown inject type', () => {
    const j = file();
    j.injects[1].type = 'ENGINE_FIRE';
    expect(errorsOf(j)).toEqual([expect.stringMatching(/^Inject 2: unknown type "ENGINE_FIRE"\. Known types: LEVEL_BUST|^Inject 2: unknown type "ENGINE_FIRE"\. Known types: /)]);
  });
  it('inject outside the session length', () => {
    const j = file();
    j.injects[0].min = 30;
    j.injects[1].min = 0;
    expect(errorsOf(j)).toEqual([
      'Inject 1 at minute 30 is outside the 30-minute session. Use minute 1 to 29.',
      'Inject 2 at minute 0 is outside the 30-minute session. Use minute 1 to 29.'
    ]);
  });
  it('other fields are checked too, and every problem is listed at once', () => {
    const e = errorsOf(file({ difficulty: 'expert', duration: 25, seed: 0, conflicts: 9, wind: [{ fl: 600, dir: 0, kt: 10 }] }));
    expect(e).toEqual([
      'Unknown traffic level "expert". Use foundational, intermediate, advanced.',
      'Session length must be 20, 30, 45 minutes, not 25.',
      'Seed must be a whole number of 1 or more, not 0.',
      'Built-in conflicts must be 0 to 5, not 9.',
      'Wind: levels FL000–FL450.'
    ]);
  });
});

describe('scenario library', () => {
  it('has the six scenarios', () => {
    expect(LIBRARY.map(l => [l.file.country, l.file.sector, l.file.difficulty])).toEqual([
      ['RO', 'ARG', 'foundational'], ['RO', 'DIN', 'intermediate'], ['RO', 'KOM', 'advanced'],
      ['RO', 'NER', 'intermediate'], ['HU', 'EAST', 'intermediate'], ['HU', 'FIR', 'advanced']
    ]);
  });

  for (const l of LIBRARY) describe(l.id, () => {
    it('passes validation, with an objective, success criteria and injects', () => {
      const r = validateScenarioFile(l.file, countries);
      expect(r.errors).toBeUndefined();
      expect(r.ok).toBe(true);
      expect(l.file.objective.length).toBeGreaterThan(20);
      expect(l.file.criteria.length).toBeGreaterThanOrEqual(3);
      expect(l.file.injects.length).toBeGreaterThanOrEqual(3);
    });

    it('stores each inject objective exactly as GRADING has it', () => {
      for (const i of l.file.injects) expect(i.objective, i.type).toBe(GRADING[i.type].text);
    });

    it('every inject finds an aircraft or area to act on, so all of them are graded', () => {
      const r = validateScenarioFile(l.file, countries), sim = new Sim(countries[r.country]);
      sim.load(r.scenario);
      while (!sim.ended) { routine(sim); sim.step(); }
      for (const i of sim.scenario.injects) {
        expect(i.status, `${i.type} at ${i.min}`).toBe('fired');
        expect(i.result, `${i.type} at ${i.min}: no suitable aircraft`).not.toBeNull();
      }
    });
  });
});
