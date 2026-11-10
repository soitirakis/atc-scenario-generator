import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import RO from '../../data/RO/index.js';
import { loadCountry } from '../../src/country.js';
import { validateRecord } from '../../src/records.js';
import { progressOf, trainees, traineeKey, trendOf, median, weakest, PROGRESS, STANDING } from '../../src/progress.js';

// Eight records derived from the session fixture, with outcomes chosen so the expected numbers can
// be worked out by hand. Ana Pop has six sessions (2026-11-01 to 11-06; the sixth saved as "ANA POP"):
//
//   session  CB cell   level bust  level request  LoS (closest)  late assume  late transfer  wrong XFL
//   11-01    no 122 s  no          no             2 (0.08 NM)    7            5              2
//   11-02    no  90 s  yes 45 s    no             1 (3.2)        4            3              1
//   11-03    yes 30 s  yes 50 s    yes 40 s       1 (4.1)        2            2              1
//   11-04    yes 25 s  no          no             0              1            1              0
//   11-05    yes 20 s  yes 40 s    yes 30 s       0              0            0              0
//   11-06    yes 15 s  no          yes 25 s       0              0            0              0
//
// plus one session for Ion Rusu (11-03) and one with no trainee name (11-02).
const records = JSON.parse(fs.readFileSync(new URL('../fixtures/progress-records.json', import.meta.url), 'utf8'));
const by = (list, k, v) => list.find(x => x[k] === v);

describe('the fixture records', () => {
  it('are valid session records', () => {
    const countries = { RO: loadCountry(RO) };
    for (const r of records) expect(validateRecord(r, countries).ok, r.id).toBe(true);
  });
});

describe('trainees', () => {
  it('grouped by name regardless of case and spaces, most recent first, latest spelling shown', () => {
    expect(trainees(records)).toEqual([
      { key: 'ana pop', name: 'ANA POP', sessions: 6, last: '2026-11-06T10:00:00.000Z' },
      { key: 'ion rusu', name: 'Ion Rusu', sessions: 1, last: '2026-11-03T10:00:00.000Z' },
      { key: '', name: 'No trainee name', sessions: 1, last: '2026-11-02T10:00:00.000Z' }
    ]);
    expect(traineeKey('  Ana   POP ')).toBe('ana pop');
  });
});

describe('progress of one trainee', () => {
  const p = progressOf(records, 'ana pop');

  it('counts only that trainee\'s sessions, oldest first', () => {
    expect([p.trainee, p.sessions, p.from, p.to]).toEqual(['ANA POP', 6, '2026-11-01T10:00:00.000Z', '2026-11-06T10:00:00.000Z']);
    expect(p.series.map(s => s.id)).toEqual(['progress-1', 'progress-2', 'progress-3', 'progress-4', 'progress-5', 'progress-6']);
    // records in any order give the same result
    expect(progressOf([...records].reverse(), 'Ana Pop')).toEqual(p);
  });

  it('per inject type: sessions seen, met rate, median measured time and trend over the last 5', () => {
    const wx = by(p.injects, 'type', 'WEATHER_CELL'), lb = by(p.injects, 'type', 'LEVEL_BUST'), cr = by(p.injects, 'type', 'CLIMB_REQUEST');
    expect(p.injects.map(i => i.type)).toEqual(['CLIMB_REQUEST', 'LEVEL_BUST', 'WEATHER_CELL']); // TYPES order, only types seen
    expect(wx).toMatchObject({ label: 'CB cell and deviations', seen: 6, graded: 6, met: 4, medianS: 27.5, trend: 'improving' });
    expect(wx.rate).toBeCloseTo(4 / 6);
    expect(wx.last.map(s => s.met)).toEqual([0, 1, 1, 1, 1]); // 11-02 to 11-06
    expect(lb).toMatchObject({ seen: 6, graded: 6, met: 3, rate: 0.5, medianS: 45, trend: 'declining' }); // 1 1 0 1 0
    expect(cr).toMatchObject({ seen: 6, graded: 6, met: 3, rate: 0.5, medianS: 30, trend: 'improving' }); // 0 1 0 1 1
    expect(lb.objective).toBe(records[0].injects[1].objective);
  });

  it('separation: losses of separation and the closest pair per session', () => {
    expect(p.series.map(s => s.los)).toEqual([2, 1, 1, 0, 0, 0]);
    expect(p.series.map(s => s.minSep)).toEqual([0.08, 3.2, 4.1, null, null, null]); // measured only when separation was lost
    expect(by(p.standing, 'key', 'los')).toMatchObject({ sessions: 6, met: 3, rate: 0.5, trend: 'improving' });
  });

  it('sector routine: late assumes, late transfers and wrong exit levels per session', () => {
    expect(p.series.map(s => [s.lateAssume, s.lateXfer, s.wrongXfl])).toEqual([[7, 5, 2], [4, 3, 1], [2, 2, 1], [1, 1, 0], [0, 0, 0], [0, 0, 0]]);
    expect(p.standing.map(s => [s.key, s.met])).toEqual([['los', 3], ['assume', 2], ['transfer', 2], ['xfl', 3]]);
    expect(STANDING.map(s => s.stat)).toEqual(['losCount', 'lateAssume', 'lateXfer', 'wrongXfl']);
  });

  it('the three weakest objectives, weakest first, in plain words', () => {
    // 2 of 6 for assume and transfer; then at 3 of 6, the level bust is the one getting worse
    expect(p.weakest.map(w => w.label)).toEqual(['Assume on time', 'Transfer on time', 'Level bust']);
    expect(p.weakest[0].text).toBe('Assume on time: every flight assumed before it enters. Met 2 of 6 sessions (33%), improving over the last 5 sessions.');
    expect(p.weakest[2].text).toBe(`Level bust: ${records[0].injects[1].objective}. Met 3 of 6 times (50%), getting worse over the last 5 sessions. Not met in the last session. Median measured time 45 s.`);
  });

  it('a trainee with one session: no trends and no weakest objectives yet', () => {
    const q = progressOf(records, 'Ion Rusu');
    expect([q.sessions, q.weakest]).toEqual([1, []]);
    expect(q.injects.every(i => i.trend === null && i.rate === 1)).toBe(true);
  });

  it('no trainee name is a trainee of its own; an unknown name has no sessions', () => {
    expect(progressOf(records, '').series.map(s => s.id)).toEqual(['progress-8']);
    expect(progressOf(records, 'Nobody')).toMatchObject({ trainee: 'Nobody', sessions: 0, from: null, to: null, series: [], injects: [], weakest: [] });
  });
});

describe('building blocks', () => {
  it('median', () => {
    expect([median([]), median([3]), median([5, 1, 3]), median([4, 1, 3, 2])]).toEqual([null, 3, 3, 2.5]);
  });
  it('trend: least-squares slope of the per-session met rate, needs at least 3 sessions', () => {
    const s = ms => ms.map(m => ({ met: m, graded: 1 }));
    expect(trendOf(s([0, 1]))).toBeNull();
    expect(trendOf(s([0, 0, 1]))).toBe('improving');
    expect(trendOf(s([1, 1, 0]))).toBe('declining');
    expect(trendOf(s([1, 0, 1]))).toBe('steady');
    expect(trendOf([{ met: 1, graded: 2 }, { met: 1, graded: 2 }, { met: 2, graded: 2 }])).toBe('improving'); // 0.5 0.5 1: slope 0.25
    expect(PROGRESS.trendWindow).toBe(5);
  });
  it('weakest leaves out objectives always met or seen in fewer than 2 sessions', () => {
    const o = (label, met, graded, n) => ({ label, objective: 'x', met, graded, rate: met / graded, medianS: null, trend: null, last: Array.from({ length: n }, () => ({ met: met / n, graded: graded / n })) });
    expect(weakest([o('Always', 2, 2, 2), o('Once', 0, 1, 1), o('Weak', 1, 2, 2)], []).map(w => w.label)).toEqual(['Weak']);
  });
  it('an inject that fired but was never graded is seen, with no rate', () => {
    const r = structuredClone(records[0]);
    r.injects = [{ ...r.injects[0], result: null }];
    const q = progressOf([r], 'Ana Pop');
    expect(q.injects).toEqual([expect.objectContaining({ type: 'WEATHER_CELL', seen: 1, graded: 0, met: 0, rate: null, medianS: null, last: [], trend: null })]);
  });
});
