import { describe, it, expect } from 'vitest';
import RO from '../../data/RO/index.js';
import { loadCountry } from '../../src/country.js';
import { Sim, GRADING, RADIO } from '../../src/sim.js';
import { buildLocalScenario } from '../../src/scenario.js';
import { pip } from '../../src/geo.js';

const C = loadCountry(RO);
const cfg = { sector: 'ARG', difficulty: 'intermediate', duration: 30, seed: 4127, objective: 'General radar handling.' };
const run = (sim, s) => { for (let i = 0; i < s; i++) sim.step(); };

/** Fire one inject of `type` at minute 1 and return the sim, the inject and the aircraft it acted on. */
const fired = type => {
  const scn = buildLocalScenario(C, cfg);
  scn.injects = [{ min: 1, type, text: '' }];
  const sim = new Sim(C);
  sim.load(scn);
  run(sim, 61);
  const inj = sim.scenario.injects[0];
  expect(inj.status).toBe('fired');
  expect(inj.result, `${type} should be graded`).toMatchObject({ state: 'pending' });
  return { sim, inj, a: inj.g.ac };
};
/** Leave only the given aircraft and stop new traffic, so the case is not decided by other flights. */
const only = (sim, ...keep) => { sim.ac = keep; sim.target = 0; };
/** A second aircraft placed `nm` east of `a`, `ft` above it. */
const intruder = (sim, a, nm, ft = 0) => {
  const b = sim.initKinematics(sim.makeAircraft({ cs: 'INT1', type: 'A320', x: a.x + nm, y: a.y, fl: a.fl + ft / 100, cfl: a.fl + ft / 100, sfl: a.fl + ft / 100, route: [{ id: 'FAR', xy: [a.x + nm, a.y - 2000] }], entry: 'X', exit: 'Y' }));
  sim.ac.push(b);
  return b;
};
/** The point deepest inside an area polygon (farthest from its edges), on a 1 NM grid. */
const insideOf = z => {
  const xs = z.poly.map(p => p[0]), ys = z.poly.map(p => p[1]);
  const edge = ([x, y]) => Math.min(...z.poly.map((p, i) => {
    const q = z.poly[(i + 1) % z.poly.length], dx = q[0] - p[0], dy = q[1] - p[1], L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((x - p[0]) * dx + (y - p[1]) * dy) / L2)) : 0;
    return Math.hypot(x - p[0] - t * dx, y - p[1] - t * dy);
  }));
  let best = null, depth = 0;
  for (let y = Math.min(...ys); y < Math.max(...ys); y++) for (let x = Math.min(...xs); x < Math.max(...xs); x++) {
    if (pip([x, y], z.poly) && edge([x, y]) > depth) { depth = edge([x, y]); best = { x, y }; }
  }
  if (depth < 5) throw new Error(`${z.id}: no point 5 NM inside`);
  return best;
};
/** Step until the inject has a final result (or `max` seconds pass). */
const settle = (sim, inj, max = 1200) => { for (let i = 0; i < max && inj.result.state === 'pending'; i++) sim.step(); return inj.result; };

describe('inject grading', () => {
  it('every inject type has an objective and limits in GRADING', () => {
    for (const t of ['LEVEL_BUST', 'RADIO_FAILURE', 'EMERGENCY_DESCENT', 'WEATHER_CELL', 'MILITARY_TSA', 'POPUP_TRAFFIC', 'CLIMB_REQUEST', 'COORD_REQUEST', 'LATE_TRANSFER', 'READBACK_ERROR', 'SIMILAR_CALLSIGN']) {
      expect(GRADING[t], t).toBeTruthy();
      expect(GRADING[t].text, t).toMatch(/\w/);
    }
  });

  it('LEVEL_BUST met: level re-cleared within 60 s', () => {
    const { sim, inj, a } = fired('LEVEL_BUST');
    run(sim, 20);
    sim.clearLevel(a.id, a.cfl);
    const r = settle(sim, inj);
    expect(r.state).toBe('met');
    expect(r.t).toBeLessThanOrEqual(GRADING.LEVEL_BUST.reclearS);
  });
  it('LEVEL_BUST not met: no re-clearance within 60 s', () => {
    const { sim, inj } = fired('LEVEL_BUST');
    const r = settle(sim, inj);
    expect(r.state).toBe('not met');
    expect(r.reason).toMatch(/not re-cleared within 60 s/);
  });

  it('RADIO_FAILURE met: nobody within 5 NM / 1000 ft while it is silent', () => {
    const { sim, inj, a } = fired('RADIO_FAILURE');
    only(sim, a);
    const r = settle(sim, inj);
    expect(a.rcf).toBe(0);
    expect(r.state).toBe('met');
    expect(r.reason).toMatch(/no traffic within 5 NM/);
  });
  it('RADIO_FAILURE not met: another aircraft inside 5 NM / 1000 ft of the 7600 track', () => {
    const { sim, inj, a } = fired('RADIO_FAILURE');
    only(sim, a);
    intruder(sim, a, 3, 500);
    const r = settle(sim, inj, 5);
    expect(r.state).toBe('not met');
    expect(r.reason).toMatch(/INT1 within \d\.\d NM \/ 500 ft/);
  });

  it('EMERGENCY_DESCENT met: acknowledged within 30 s, no STCA in the descent', () => {
    const { sim, inj, a } = fired('EMERGENCY_DESCENT');
    only(sim, a);
    run(sim, 10);
    sim.ackEmergency(a.id);
    const r = settle(sim, inj);
    expect(r.state).toBe('met');
    expect(r.t).toBe(11);
    // ends when it reaches FL100, or earlier if it diverts out of the sector
    expect(a.fl <= GRADING.EMERGENCY_DESCENT.untilFL + 0.5 || !sim.get(a.id)).toBe(true);
    expect(r.reason).toMatch(/no STCA (in the descent|until it left at FL\d+)/);
  });
  it('EMERGENCY_DESCENT not met: acknowledged too late', () => {
    const { sim, inj, a } = fired('EMERGENCY_DESCENT');
    only(sim, a);
    run(sim, 40);
    const r = inj.result;
    expect(r.state).toBe('not met');
    expect(r.reason).toMatch(/not acknowledged within 30 s/);
    sim.ackEmergency(a.id); // a later acknowledgement does not change the result
    run(sim, 2);
    expect(inj.result.state).toBe('not met');
  });
  it('EMERGENCY_DESCENT not met: STCA with it during the descent', () => {
    const { sim, inj, a } = fired('EMERGENCY_DESCENT');
    only(sim, a);
    sim.ackEmergency(a.id);
    intruder(sim, a, 2, -1500);
    const r = settle(sim, inj, 30);
    expect(r.state).toBe('not met');
    expect(r.reason).toMatch(/STCA with INT1/);
  });

  it('WEATHER_CELL met: every deviation request answered before a self-deviation', () => {
    const { sim, inj } = fired('WEATHER_CELL');
    let asked = 0;
    for (let i = 0; i < GRADING.WEATHER_CELL.windowS + 5 && inj.result.state === 'pending'; i++) {
      for (const x of sim.ac) if (x.req && x.req.kind === 'wx') { sim.answer(x.id, true); asked++; }
      sim.step();
    }
    expect(asked).toBeGreaterThan(0);
    expect(inj.result.state).toBe('met');
    expect(inj.result.reason).toMatch(/answered, slowest 0 s/);
  });
  it('WEATHER_CELL not met: an aircraft deviates with its request unanswered', () => {
    const { sim, inj } = fired('WEATHER_CELL');
    const r = settle(sim, inj, GRADING.WEATHER_CELL.windowS);
    expect(r.state).toBe('not met');
    expect(r.reason).toMatch(/deviat|not answered/);
  });

  it('MILITARY_TSA activates a real ENR 5.2 area reaching cruise levels over the sector', () => {
    const { sim, inj } = fired('MILITARY_TSA');
    const z = inj.g.zone;
    expect(sim.C.areas.map(a => a.id)).toContain(z.id);
    expect(inj.target).toBe(z.id);
    expect(z.upper).toBeGreaterThan(245);
    expect(z.lower).toBeLessThan(410);
    expect(z.at - sim.t).toBe(300 - 1); // active five minutes after the inject fired
  });
  it('MILITARY_TSA met: none of your aircraft inside for 10 min after activation', () => {
    const { sim, inj } = fired('MILITARY_TSA');
    only(sim);
    const r = settle(sim, inj);
    expect(r.state).toBe('met');
    expect(r.t).toBe(GRADING.MILITARY_TSA.windowS);
  });
  it('MILITARY_TSA not met: one of your aircraft inside the active area within its limits', () => {
    const { sim, inj } = fired('MILITARY_TSA');
    only(sim);
    const z = inj.g.zone, fl = Math.min(z.upper, 410) - 10;
    run(sim, z.at - sim.t);
    intruder(sim, { ...insideOf(z), fl }, 0).ctl = 'ass';
    const r = settle(sim, inj, 3);
    expect(r.state).toBe('not met');
    expect(r.reason).toMatch(new RegExp(`INT1 inside ${z.id} at FL${fl}`));
  });
  it('MILITARY_TSA: an aircraft outside the vertical limits does not count', () => {
    const { sim, inj } = fired('MILITARY_TSA');
    only(sim);
    const z = inj.g.zone;
    run(sim, z.at - sim.t);
    intruder(sim, { ...insideOf(z), fl: z.lower - 20 }, 0).ctl = 'ass';
    run(sim, 5);
    expect(inj.result.state).toBe('pending');
  });
  it('MILITARY_TSA: an aircraft that is not yours (not assumed or pending) does not count', () => {
    const { sim, inj } = fired('MILITARY_TSA');
    only(sim);
    const z = inj.g.zone;
    run(sim, z.at - sim.t);
    intruder(sim, { ...insideOf(z), fl: Math.min(z.upper, 410) - 10 }, 0).ctl = 'none';
    run(sim, 5);
    expect(inj.result.state).toBe('pending');
  });

  it('POPUP_TRAFFIC met: no STCA with it in its first 3 min', () => {
    const { sim, inj, a } = fired('POPUP_TRAFFIC');
    only(sim, a);
    const r = settle(sim, inj);
    expect(r.state).toBe('met');
    expect(r.t).toBe(GRADING.POPUP_TRAFFIC.windowS);
  });
  it('POPUP_TRAFFIC not met: STCA involving it', () => {
    const { sim, inj, a } = fired('POPUP_TRAFFIC');
    only(sim, a);
    intruder(sim, a, 2);
    const r = settle(sim, inj, 30);
    expect(r.state).toBe('not met');
    expect(r.reason).toMatch(/STCA with INT1/);
  });

  it('CLIMB_REQUEST met: answered within 60 s', () => {
    const { sim, inj, a } = fired('CLIMB_REQUEST');
    run(sim, 15);
    sim.answer(a.id, true);
    const r = settle(sim, inj);
    expect(r.state).toBe('met');
    expect(r.t).toBe(16);
  });
  it('CLIMB_REQUEST not met: no answer within 60 s', () => {
    const { sim, inj } = fired('CLIMB_REQUEST');
    const r = settle(sim, inj);
    expect(r.state).toBe('not met');
    expect(r.reason).toMatch(/not answered within 60 s/);
  });

  it('COORD_REQUEST met: answered in time and the aircraft leaves at the agreed level', () => {
    const { sim, inj, a } = fired('COORD_REQUEST');
    run(sim, 5);
    sim.answer(a.id, true);
    sim.step();
    expect(inj.result.state).toBe('pending'); // still waiting for it to leave
    sim.clearLevel(a.id, a.xfl);
    sim.transfer(a.id);
    const r = settle(sim, inj, 2);
    expect(r.state).toBe('met');
    expect(r.reason).toMatch(/left at the agreed FL/);
  });
  it('COORD_REQUEST not met: the aircraft leaves at another level', () => {
    const { sim, inj, a } = fired('COORD_REQUEST');
    sim.answer(a.id, true);
    sim.clearLevel(a.id, a.xfl + 20);
    sim.transfer(a.id);
    const r = settle(sim, inj, 2);
    expect(r.state).toBe('not met');
    expect(r.reason).toMatch(/left at FL\d+, agreed FL\d+/);
  });
  it('COORD_REQUEST not met: not answered within 60 s', () => {
    const { sim, inj } = fired('COORD_REQUEST');
    const r = settle(sim, inj);
    expect(r.state).toBe('not met');
    expect(r.reason).toMatch(/not answered within 60 s/);
  });

  it('LATE_TRANSFER met: assumed within 30 s of its first call', () => {
    const { sim, inj, a } = fired('LATE_TRANSFER');
    for (let i = 0; i < 300 && !a.lastIn; i++) sim.step();
    run(sim, 10);
    sim.assume(a.id);
    const r = settle(sim, inj, 2);
    expect(r.state).toBe('met');
    expect(r.t).toBeLessThanOrEqual(GRADING.LATE_TRANSFER.assumeS);
  });
  it('LATE_TRANSFER not met: not assumed within 30 s', () => {
    const { sim, inj, a } = fired('LATE_TRANSFER');
    for (let i = 0; i < 300 && !a.lastIn; i++) sim.step();
    const r = settle(sim, inj, 40);
    expect(r.state).toBe('not met');
    expect(r.reason).toMatch(/not assumed within 30 s/);
  });

  /* readback error: the next level or heading clearance is read back wrong */
  const free = sim => { for (let i = 0; i < 30 && sim.freqBusy(); i++) sim.step(); };
  const wrongReadback = () => {
    const { sim, inj } = fired('READBACK_ERROR');
    const a = sim.ac.find(x => x.ctl === 'ass' && !x.rcf && !x.emg), from = Math.round(a.cfl), fl = from + 20;
    free(sim);
    sim.clearLevel(a.id, fl);
    expect(a.cfl).toBe(from); // the aircraft does nothing yet: it will act on its readback
    for (let i = 0; i < 20 && inj.g.rbAt === undefined; i++) sim.step();
    const rb = sim.logs.find(l => l.cls === 'p');
    expect(rb.text).toMatch(new RegExp(`^climb FL(${fl - 10}|${fl + 10}), ${a.cs}$`)); // read back 1000 ft off
    return { sim, inj, a, fl, wrong: +rb.text.match(/FL(\d+)/)[1] };
  };
  it('READBACK_ERROR met: the wrong readback is corrected before the aircraft acts on it', () => {
    const { sim, inj, a, fl } = wrongReadback();
    free(sim);
    sim.clearLevel(a.id, fl); // "negative, climb FL..." : the correction
    const r = settle(sim, inj, 5);
    expect(r.state).toBe('met');
    expect(r.reason).toMatch(/corrected \d+ s after the readback/);
    run(sim, RADIO.actS + 5);
    expect([a.cfl, a.sfl]).toEqual([fl, fl]); // it never set the wrong level
  });
  it('READBACK_ERROR not met: nobody corrects it and the aircraft sets the wrong level', () => {
    const { sim, inj, a, fl, wrong } = wrongReadback();
    const r = settle(sim, inj, RADIO.actS + 2);
    expect(r.state).toBe('not met');
    expect(r.t).toBe(RADIO.actS);
    expect(r.reason).toMatch(new RegExp(`${a.cs} acted on the wrong readback`));
    expect([a.cfl, a.sfl]).toEqual([fl, wrong]); // cleared level as given, selected level as read back
    sim.step();
    expect(sim.nets.clam.get(a.id).kind).toBe('SFL'); // CLAM sees the mismatch
  });
  it('READBACK_ERROR: not graded when no level or heading clearance comes in its window', () => {
    const { sim, inj } = fired('READBACK_ERROR');
    run(sim, GRADING.READBACK_ERROR.windowS + 2);
    expect(inj.result).toBeNull();
    expect(sim.timeline.some(e => /Readback error: not graded/.test(e.text))).toBe(true);
  });

  /* similar callsigns: one takes the other's clearance */
  const takenClearance = () => {
    const { sim, inj } = fired('SIMILAR_CALLSIGN');
    const [a, b] = inj.g.pair;
    expect(b.cs).not.toBe(a.cs);
    expect(b.cs.slice(0, 3)).toBe(a.cs.slice(0, 3));
    expect(b.ctl).toBe('pend'); // calling on frequency
    sim.assume(b.id);
    free(sim);
    const fl = Math.round(a.cfl) + 20, bFrom = Math.round(b.cfl);
    sim.clearLevel(a.id, fl);
    for (let i = 0; i < 20 && inj.g.rbAt === undefined; i++) sim.step();
    expect(sim.logs.find(l => l.cls === 'p').text).toBe(`climb FL${fl}, ${b.cs}`); // the wrong one reads back
    return { sim, inj, a, b, fl, bFrom };
  };
  it('SIMILAR_CALLSIGN met: the wrong aircraft is stopped before it acts on the clearance', () => {
    const { sim, inj, b, bFrom } = takenClearance();
    free(sim);
    sim.clearLevel(b.id, bFrom); // "negative, maintain FL..."
    const r = settle(sim, inj, 5);
    expect(r.state).toBe('met');
    run(sim, RADIO.actS + 5);
    expect(b.cfl).toBe(bFrom);
  });
  it('SIMILAR_CALLSIGN not met: the wrong aircraft takes the clearance and nobody stops it', () => {
    const { sim, inj, a, b, fl } = takenClearance();
    const aFrom = a.cfl;
    const r = settle(sim, inj, RADIO.actS + 2);
    expect(r.state).toBe('not met');
    expect(r.reason).toMatch(new RegExp(`${b.cs} acted on ${b.cs} taking ${a.cs}'s clearance`));
    expect(b.cfl).toBe(fl); // the other flight climbs
    expect(a.cfl).toBe(aFrom); // the one it was meant for does not
  });

  it('the debrief lists each inject with its result, and a timeline of key events', () => {
    const { sim, a } = fired('LEVEL_BUST');
    sim.clearLevel(a.id, a.cfl);
    sim.step();
    const d = sim.debrief();
    expect(d.injects).toHaveLength(1);
    expect(d.injects[0]).toMatchObject({ type: 'LEVEL_BUST', target: a.cs, result: { state: 'met' } });
    expect(d.timeline.map(e => e.text)).toEqual(expect.arrayContaining([expect.stringMatching(/fired$/), expect.stringMatching(/: met \(re-cleared after/)]));
  });

  it('grading does not change the seeded session', () => {
    const go = () => { const s = new Sim(C), scn = buildLocalScenario(C, cfg); s.load(scn); run(s, 900); return s.debrief(); };
    expect(go()).toEqual(go());
  });
});
