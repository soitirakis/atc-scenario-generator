import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import RO from '../../data/RO/index.js';
import { loadCountry } from '../../src/country.js';
import { TYPES, DIFF } from '../../src/sim.js';
import { validateScenarioFile, DURATIONS } from '../../src/scenario.js';
import { mulberry32 } from '../../src/geo.js';
import { suggestScenario, sessionRate, difficultyStep, sectorNotRecent, overlapStats, placeInjects, RECOMMEND } from '../../src/recommend.js';

const C = loadCountry(RO), countries = { RO: C };
const fixture = JSON.parse(fs.readFileSync(new URL('../fixtures/progress-records.json', import.meta.url), 'utf8'));
const OK = { losCount: 0, lateAssume: 0, lateXfer: 0, wrongXfl: 0 }, BAD = { losCount: 1, lateAssume: 1, lateXfer: 1, wrongXfl: 1 };
/** A session record for these tests, from the fixture's first record. injects: [[type, firedAt, 'met' | 'not met' | null]]. */
function mk(day, o = {}) {
  const r = structuredClone(fixture[0]);
  Object.assign(r, { id: `t-${day}`, savedAt: `2026-11-${String(day).padStart(2, '0')}T10:00:00.000Z`, trainee: o.trainee ?? 'Ana Pop', sector: o.sector ?? 'ARG', country: o.country ?? 'RO' });
  r.scenario = { ...r.scenario, difficulty: o.difficulty ?? 'intermediate', duration: o.duration ?? 30, sector: r.sector, country: r.country };
  r.injects = (o.injects ?? [['LEVEL_BUST', 300, 'met']]).map(([type, firedAt, state]) => ({ min: Math.max(1, Math.round(firedAt / 60)), type, label: TYPES[type], target: 'X', status: 'fired', firedAt, objective: `${TYPES[type]} objective`, result: state ? { state, t: 30, reason: state } : null }));
  r.stats = { ...r.stats, ...(o.stats ?? OK) };
  return r;
}
const rules = s => s.reasons.map(r => r.rule);
const texts = (s, rule) => s.reasons.filter(r => r.rule === rule).map(r => r.text);

describe('every suggestion', () => {
  it('is a scenario file that loads, with the trainee in the title and a reason for each rule', () => {
    const s = suggestScenario(fixture, 'Ana Pop', countries);
    expect(s.ok).toBe(true);
    expect(validateScenarioFile(s.file, countries).ok).toBe(true);
    expect(s.file).toMatchObject({ schemaVersion: 1, country: 'RO', title: 'Suggested for ANA POP: BACAU, intermediate' });
    expect(rules(s)).toEqual(['repeat', 'repeat', 'repeat', 'difficulty', 'sector']);
    expect(suggestScenario([...fixture].reverse(), 'ana pop', countries)).toEqual(s); // order and case do not matter
  });
});

describe('rule 1: repeat the weakest objectives', () => {
  const s = suggestScenario(fixture, 'Ana Pop', countries);
  it('their injects are in the scenario, their objectives in the criteria, each with its reason', () => {
    // weakest for Ana: assume on time, transfer on time, level bust (tests/unit/progress.test.js)
    const types = s.file.injects.map(i => i.type);
    expect(types).toContain('LATE_TRANSFER'); // trains assume on time
    expect(types).toContain('LEVEL_BUST');
    expect(texts(s, 'repeat')[0]).toMatch(/^Assume on time: every flight assumed before it enters\. Met 2 of 6 sessions \(33%\).* Trained by an inbound flight that is not transferred/);
    expect(texts(s, 'repeat')[2]).toMatch(/^Level bust: /);
    expect(s.file.criteria).toEqual(expect.arrayContaining(['Assume on time: every flight assumed before it enters', 'Transfer on time: every flight transferred before it leaves']));
    expect(s.file.objective).toBe('Repeat the weakest objectives: Assume on time, Transfer on time, Level bust.');
  });
  it('separation as the weakness adds a built-in conflict; agreed exit levels adds an exit level change', () => {
    const rs = [1, 2, 3].map(d => mk(d, { stats: { ...OK, losCount: 1, wrongXfl: d < 3 ? 1 : 0 } }));
    const t = suggestScenario(rs, 'Ana Pop', countries);
    expect(texts(t, 'repeat')[0]).toMatch(/^Separation: no loss of separation\. Met 0 of 3 sessions.* Trained by one more built-in conflict/);
    expect(t.file.conflicts).toBe(DIFF.intermediate.conflicts + 1);
    expect(t.file.injects.map(i => i.type)).toContain('COORD_REQUEST');
  });
  it('no weak objective yet: the standard injects, and it says why', () => {
    expect(texts(suggestScenario([mk(1)], 'Ana Pop', countries), 'repeat')).toEqual([expect.stringMatching(/^No weak objective yet: each needs at least two sessions/)]);
    expect(texts(suggestScenario([], 'New Trainee', countries), 'repeat')).toEqual(['No sessions yet: the standard injects for the traffic level.']);
  });
  it('an inject the country has no data for is left out, with the reason', () => {
    const raw = structuredClone(RO); delete raw.military;
    const noMil = { RO: loadCountry(raw) };
    const rs = [1, 2].map(d => mk(d, { injects: [['COMLOSS', 300, 'not met']] }));
    const t = suggestScenario(rs, 'Ana Pop', noMil);
    expect(t.file.injects.map(i => i.type)).not.toContain('COMLOSS');
    expect(texts(t, 'repeat')[0]).toBe('COMLOSS and QRA scramble is weak, but Romania has no data for it, so it is left out.');
    expect(validateScenarioFile(t.file, noMil).ok).toBe(true);
  });
});

describe('rule 2: traffic level', () => {
  const met = [['LEVEL_BUST', 300, 'met'], ['CLIMB_REQUEST', 900, 'met']], missed = [['LEVEL_BUST', 300, 'not met'], ['CLIMB_REQUEST', 900, 'not met']];
  it('a session meets the share of its graded injects and the four standing objectives', () => {
    expect(sessionRate(mk(1, { injects: met }))).toBe(1);
    expect(sessionRate(mk(1, { injects: missed, stats: BAD }))).toBe(0);
    expect(sessionRate(mk(1, { injects: [...met.slice(0, 1), ...missed.slice(1), ['WEATHER_CELL', 1200, null]], stats: { ...OK, lateXfer: 2 } }))).toBeCloseTo(4 / 6); // ungraded inject not counted
  });
  it('up one level after 3 sessions meeting at least 80%; not after 2', () => {
    const rs = [1, 2, 3].map(d => mk(d, { injects: met }));
    expect(difficultyStep(rs)).toEqual({ difficulty: 'advanced', reason: 'Step up to advanced traffic: the last 3 sessions met at least 80% of their objectives (100%, 100%, 100%).' });
    expect(difficultyStep(rs.slice(1)).difficulty).toBe('intermediate');
    expect(suggestScenario(rs, 'Ana Pop', countries).file.difficulty).toBe('advanced');
  });
  it('down one level after 2 sessions under 50%', () => {
    const rs = [mk(1, { injects: met }), mk(2, { injects: missed, stats: BAD }), mk(3, { injects: missed, stats: BAD })];
    expect(difficultyStep(rs)).toEqual({ difficulty: 'foundational', reason: 'Step down to foundational traffic: the last 2 sessions met under 50% of their objectives (0%, 0%).' });
  });
  it('no step past the ends, and the same level otherwise', () => {
    expect(difficultyStep([1, 2, 3].map(d => mk(d, { injects: met, difficulty: 'advanced' }))).reason).toMatch(/^Stay at advanced traffic, the highest level/);
    expect(difficultyStep([1, 2].map(d => mk(d, { injects: missed, stats: BAD, difficulty: 'foundational' }))).reason).toMatch(/^Stay at foundational traffic, the lowest level/);
    expect(difficultyStep([mk(1, { injects: met }), mk(2, { injects: missed, stats: BAD }), mk(3, { injects: met })])).toMatchObject({ difficulty: 'intermediate' });
    expect(difficultyStep([])).toEqual({ difficulty: 'foundational', reason: 'First session for this trainee: foundational traffic.' });
    expect([RECOMMEND.upRate, RECOMMEND.upSessions, RECOMMEND.downRate, RECOMMEND.downSessions]).toEqual([0.8, 3, 0.5, 2]);
  });
});

describe('rule 3: a sector not flown recently', () => {
  it('a sector never flown, in the module\'s order, not the last one', () => {
    expect(sectorNotRecent([mk(1, { sector: 'ARG' })], C)).toEqual({ sector: 'BAC', reason: 'BACAU: not flown yet; the last session was in ARGES.' });
    expect(sectorNotRecent([], C).sector).toBe(C.sectorList[0].id);
  });
  it('when every sector has been flown, the one flown longest ago', () => {
    const ids = C.sectorList.map(s => s.id), rs = ids.map((id, k) => mk(k + 1, { sector: id }));
    rs.push(mk(ids.length + 1, { sector: 'ARG' })); // ARG again, last: BAC is now the oldest
    expect(sectorNotRecent(rs, C)).toEqual({ sector: 'BAC', reason: 'BACAU: last flown 2026-11-02, the longest ago.' });
  });
  it('the suggestion uses it', () => {
    expect(suggestScenario([mk(1, { sector: 'ARG' })], 'Ana Pop', countries).file.sector).toBe('BAC');
  });
});

describe('rule 4: overlapping injects when prioritisation is the weakness', () => {
  // in each session two injects fire 2 minutes apart and are missed; one on its own is met
  const weak = [1, 2].map(d => mk(d, { injects: [['WEATHER_CELL', 600, 'not met'], ['RADIO_FAILURE', 720, 'not met'], ['CLIMB_REQUEST', 1500, 'met']] }));
  it('overlapping injects met at most 50%, and 20 points below those on their own, is a weakness', () => {
    expect(overlapStats(weak)).toMatchObject({ overlapMet: 0, overlapGraded: 4, aloneMet: 2, aloneGraded: 2, weak: true });
    const fine = [1, 2].map(d => mk(d, { injects: [['WEATHER_CELL', 600, 'met'], ['RADIO_FAILURE', 720, 'met']] }));
    expect(overlapStats(fine).weak).toBe(false);
    expect(overlapStats([weak[0]]).weak).toBe(true); // 2 overlapping in one session are enough
    expect(overlapStats([mk(1, { injects: [['WEATHER_CELL', 600, 'not met'], ['RADIO_FAILURE', 1200, 'not met']] })]).weak).toBe(false); // 10 minutes apart: not overlapping
  });
  it('the suggestion puts an emergency, a routine request and the weak inject within 2 minutes, with the reason', () => {
    const s = suggestScenario(weak, 'Ana Pop', countries), inj = s.file.injects;
    const cl = ['EMERGENCY_DESCENT', 'CLIMB_REQUEST'].map(t => inj.find(i => i.type === t).min);
    expect(Math.max(...cl) - Math.min(...cl)).toBeLessThanOrEqual(2);
    expect(texts(s, 'overlap')[0]).toMatch(/^Prioritisation: injects that came within 3 minutes of another were met 0 of 4 times \(0%\), against 2 of 2 \(100%\) on their own\. This scenario puts Emergency descent \(7700\), Level request, .+ within 2 minutes of each other\.$/);
    expect(s.file.objective).toMatch(/Prioritise when events overlap\.$/);
  });
  it('places a cluster one minute apart and keeps the others at least 3 minutes away', () => {
    const p = placeInjects(['LEVEL_BUST', 'EMERGENCY_DESCENT', 'CLIMB_REQUEST', 'WEATHER_CELL', 'RADIO_FAILURE'], 30, ['EMERGENCY_DESCENT', 'CLIMB_REQUEST', 'WEATHER_CELL']);
    const cl = p.filter(i => ['EMERGENCY_DESCENT', 'CLIMB_REQUEST', 'WEATHER_CELL'].includes(i.type)).map(i => i.min);
    expect(cl).toEqual([12, 13, 14]);
    for (const i of p.filter(x => !cl.includes(x.min))) expect(Math.min(...cl.map(m => Math.abs(m - i.min))), i.type).toBeGreaterThanOrEqual(4);
    expect(placeInjects(['A', 'B', 'C'], 20).map(i => i.min)).toEqual([3, 10, 17]);
  });
});

describe('other cases', () => {
  it('the last country is not available: the first one, with the reason', () => {
    const s = suggestScenario([mk(1, { country: 'HU', sector: 'EAST' })], 'Ana Pop', countries);
    expect(s.file.country).toBe('RO');
    expect(texts(s, 'country')).toEqual(['Romania: the last session\'s country (HU) is not available.']);
    expect(suggestScenario([], 'x', {})).toEqual({ ok: false, reasons: [{ rule: 'country', text: 'No country module is available.' }] });
  });
});

describe('never suggests an invalid scenario', () => {
  // 400 generated histories: any sector (layers, collapsed, the whole FIR), traffic level, length,
  // inject type (with and without the military data they need), timing, result and routine counts
  const raw = structuredClone(RO); delete raw.military;
  const variants = [countries, { RO: loadCountry(raw) }];
  const sectors = [...C.sectorList.map(s => s.id), 'FIR'], types = Object.keys(TYPES), levels = Object.keys(DIFF), names = ['Ana Pop', 'ion rusu', '', 'Ștefan'];
  it('over many histories, every suggestion validates, without the fallback, and is deterministic', () => {
    const rnd = mulberry32(2026), pick = a => a[Math.floor(rnd() * a.length)];
    for (let h = 0; h < 400; h++) {
      const recs = Array.from({ length: Math.floor(rnd() * 9) }, (_, k) => {
        const duration = pick(DURATIONS);
        return mk(k + 1, {
          trainee: pick(names), sector: pick(sectors), difficulty: pick(levels), duration,
          injects: Array.from({ length: Math.floor(rnd() * 6) }, () => [pick(types), Math.floor(rnd() * duration * 60), pick(['met', 'not met', null])]),
          stats: { losCount: Math.floor(rnd() * 3), lateAssume: Math.floor(rnd() * 3), lateXfer: Math.floor(rnd() * 3), wrongXfl: Math.floor(rnd() * 2) }
        });
      });
      const cs = variants[h % 2], who = pick(names), s = suggestScenario(recs, who, cs), v = validateScenarioFile(s.file, cs);
      expect(v.errors, `history ${h}`).toBeUndefined();
      expect(rules(s), `history ${h}`).not.toContain('fallback');
      expect(s.file.injects.length, `history ${h}`).toBeGreaterThan(0);
      for (const i of s.file.injects) expect(i.min >= 1 && i.min <= s.file.duration - 1, `history ${h}`).toBe(true);
      if (cs === variants[1]) for (const t of ['COMLOSS', 'OAT_FORMATION']) expect(s.file.injects.map(i => i.type), `history ${h}`).not.toContain(t);
      expect(suggestScenario(recs, who, cs)).toEqual(s);
    }
  });
});
