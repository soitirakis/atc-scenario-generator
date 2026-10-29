import { describe, it, expect } from 'vitest';
import RO from '../../data/RO/index.js';
import { loadCountry, inSector } from '../../src/country.js';
import { Sim, DIFF, TYPES } from '../../src/sim.js';
import { buildLocalScenario } from '../../src/scenario.js';

const C = loadCountry(RO);
const cfg = (o = {}) => ({ sector: 'ARG', difficulty: 'intermediate', duration: 30, seed: 4127, objective: 'General radar handling.', ...o });
const fresh = (o, injects) => {
  const scn = buildLocalScenario(C, cfg(o));
  if (injects) scn.injects = injects;
  const sim = new Sim(C);
  sim.load(scn);
  return sim;
};
const run = (sim, s) => { for (let i = 0; i < s; i++) sim.step(); };

describe('session loading', () => {
  it('loads the traffic count for each difficulty', () => {
    for (const d of Object.keys(DIFF)) expect(fresh({ difficulty: d }).ac.length).toBe(DIFF[d].count);
  });

  it('the same seed reproduces the same session exactly', () => {
    const a = fresh(), b = fresh();
    run(a, 600); run(b, 600);
    expect(a.ac.map(x => [x.cs, x.x.toFixed(3), x.y.toFixed(3), x.fl.toFixed(2)])).toEqual(b.ac.map(x => [x.cs, x.x.toFixed(3), x.y.toFixed(3), x.fl.toFixed(2)]));
    expect(a.logs.map(l => l.text)).toEqual(b.logs.map(l => l.text));
  });

  it('a different seed produces different traffic', () => {
    expect(fresh({ seed: 1 }).ac.map(a => a.cs)).not.toEqual(fresh({ seed: 2 }).ac.map(a => a.cs));
  });

  it('most traffic is relevant to the training sector', () => {
    const sim = fresh();
    sim.computeInbound();
    const relevant = sim.ac.filter(a => a.lastIn || a.inbound || sim.routeCrosses([a.x, a.y], a.route.slice(a.ri), sim.sector)).length;
    expect(relevant / sim.ac.length).toBeGreaterThan(0.6);
  });

  it('cruising transits use semicircular levels', () => {
    const sim = fresh({ difficulty: 'advanced' });
    for (const a of sim.ac.filter(x => x.cat === 'transit' && !x.conflict)) {
      const eastbound = a.hdg < 180;
      expect(Math.round(a.cfl / 10) % 2, a.cs).toBe(eastbound ? 1 : 0);
    }
  });
});

describe('built-in conflicts', () => {
  it('are detected by STCA before they become a loss of separation', () => {
    const sim = fresh({ difficulty: 'foundational' }, []);
    const pair = sim.ac.filter(a => a.conflict).map(a => a.id);
    expect(pair).toHaveLength(2);
    let predictedAt = null, losAt = null;
    for (let i = 0; i < 600 && losAt === null; i++) {
      sim.step();
      const hit = sim.stca.find(c => pair.includes(c.a.id) && pair.includes(c.b.id));
      if (hit && hit.level === 'pred' && predictedAt === null) predictedAt = sim.t;
      if (hit && hit.level === 'los') losAt = sim.t;
    }
    expect(predictedAt).not.toBeNull();
    expect(losAt).not.toBeNull();
    expect(losAt - predictedAt).toBeGreaterThanOrEqual(60);
    expect(sim.stats.losCount).toBeGreaterThanOrEqual(1);
  });

  it('can be solved with a level change', () => {
    const sim = fresh({ difficulty: 'foundational' }, []);
    const [a] = sim.ac.filter(x => x.conflict);
    expect(sim.clearLevel(a.id, a.fl - 20).ok).toBe(true);
    run(sim, 600);
    expect(sim.stats.losCount).toBe(0);
  });
});

describe('injects', () => {
  const at = (type, min = 1) => [{ min, type, text: '' }];

  it('LEVEL_BUST makes the selected level disagree with the clearance, and re-clearing fixes it', () => {
    const sim = fresh({}, at('LEVEL_BUST'));
    run(sim, 61);
    const a = sim.ac.find(x => x.bust);
    expect(a).toBeTruthy();
    expect(a.sfl).not.toBe(a.cfl);
    expect(sim.priorities().some(p => p.h.includes('level bust'))).toBe(true);
    sim.clearLevel(a.id, a.cfl);
    expect(a.bust).toBe(false);
    expect(a.sfl).toBe(a.cfl);
  });

  it('RADIO_FAILURE squawks 7600 and clearances get no reply until contact returns', () => {
    const sim = fresh({}, at('RADIO_FAILURE'));
    run(sim, 61);
    const a = sim.ac.find(x => x.rcf);
    expect(a.sq).toBe('7600');
    const r = sim.turn(a.id, 90);
    expect(r.ok).toBe(false);
    expect(r.msg).toMatch(/no reply/);
    run(sim, 500);
    if (sim.get(a.id)) { expect(a.rcf).toBe(0); expect(sim.turn(a.id, 90).ok).toBe(true); }
  });

  it('EMERGENCY_DESCENT squawks 7700, descends fast and diverts to the nearest aerodrome', () => {
    const sim = fresh({}, at('EMERGENCY_DESCENT'));
    run(sim, 61);
    const a = sim.ac.find(x => x.emg);
    expect(a.sq).toBe('7700');
    expect(a.cfl).toBe(100);
    expect(C.airports[a.route[0].id]).toBeTruthy();
    const fl0 = a.fl;
    run(sim, 60);
    expect(fl0 - a.fl).toBeGreaterThan(35); // ~4000 ft/min
    expect(sim.ackEmergency(a.id).ok).toBe(true);
  });

  it('WEATHER_CELL creates a cell and aircraft ask to deviate; approval turns them', () => {
    const sim = fresh({}, at('WEATHER_CELL'));
    let req = null;
    for (let i = 0; i < 900 && !req; i++) { sim.step(); req = sim.ac.find(a => a.req && a.req.kind === 'wx'); }
    expect(sim.wx).toHaveLength(1);
    expect(req).toBeTruthy();
    const before = req.hdg;
    sim.answer(req.id, true);
    expect(req.mode).toBe('hdg');
    expect(Math.abs(((req.thdg - before + 540) % 360) - 180)).toBe(25);
  });

  it('MILITARY_TSA warns five minutes before it activates', () => {
    const sim = fresh({}, at('MILITARY_TSA'));
    run(sim, 61);
    expect(sim.tsa).toHaveLength(1);
    expect(sim.tsa[0].active).toBe(false);
    run(sim, 300);
    expect(sim.tsa[0].active).toBe(true);
    expect(inSector([sim.tsa[0].x, sim.tsa[0].y], sim.sector)).toBe(true);
  });

  it('POPUP_TRAFFIC appears at the sector boundary flagged as uncoordinated', () => {
    const sim = fresh({}, at('POPUP_TRAFFIC'));
    const n = sim.ac.length;
    run(sim, 61);
    const p = sim.ac.find(a => a.popupUntil > sim.t);
    expect(p).toBeTruthy();
    expect(sim.ac.length).toBeGreaterThanOrEqual(n);
  });

  it('CLIMB_REQUEST is answered through approve and counted in the stats', () => {
    const sim = fresh({}, at('CLIMB_REQUEST'));
    run(sim, 61);
    const a = sim.ac.find(x => x.req && x.req.kind === 'climb');
    const target = a.req.value;
    run(sim, 10);
    sim.answer(a.id, true);
    expect(a.cfl).toBe(target);
    expect(sim.stats.reqAnswered).toBe(1);
    expect(sim.debrief().avgResponse).toBeGreaterThanOrEqual(10);
  });

  it('instructor can fire an inject early', () => {
    const sim = fresh({}, at('RADIO_FAILURE', 20));
    run(sim, 30);
    expect(sim.fireNow(0)).toBe(true);
    expect(sim.scenario.injects[0].status).toBe('fired');
    expect(sim.fireNow(0)).toBe(false);
  });
});

describe('clearances', () => {
  it('direct-to accepts AIP points and rejects unknown names', () => {
    const sim = fresh({}, []);
    const a = sim.ac[0];
    expect(sim.direct(a.id, 'zzzzz').ok).toBe(false);
    expect(sim.direct(a.id, 'NERDI').ok).toBe(true);
    expect(a.route[0].id).toBe('NERDI');
  });
  it('speed is clamped to a sane en-route range', () => {
    const sim = fresh({}, []);
    const a = sim.ac[0];
    sim.speed(a.id, 900);
    expect(a.tgs).toBe(520);
  });
});

describe('countries without a main airport', () => {
  it('run transit-only traffic', () => {
    const { mainAirports, ...rest } = RO.traffic;
    const traffic = { ...rest, flows: rest.flows.filter(f => rest.gates[f[0]] && rest.gates[f[1]]) };
    const C0 = loadCountry({ ...RO, traffic });
    expect(C0.mainAirports).toEqual({});
    const scn = buildLocalScenario(C0, cfg({ difficulty: 'advanced' }));
    scn.injects = Object.keys(TYPES).map((type, i) => ({ min: 1 + i * 2, type, text: '' }));
    const sim = new Sim(C0);
    sim.load(scn);
    const seen = new Set(sim.ac.map(a => a.cs));
    for (let i = 0; i < 1800; i++) {
      sim.step();
      for (const a of sim.ac) { expect(a.cat, a.cs).toBe('transit'); seen.add(a.cs); }
    }
    expect(seen.size).toBeGreaterThan(DIFF.advanced.count); // new traffic kept spawning
  });
});

describe('session end', () => {
  it('ends exactly at the scenario duration', () => {
    const sim = fresh({ duration: 20 }, []);
    run(sim, 20 * 60 + 50);
    expect(sim.ended).toBe(true);
    expect(sim.t).toBe(1200);
  });
});
