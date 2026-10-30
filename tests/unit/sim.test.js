import { describe, it, expect } from 'vitest';
import RO from '../../data/RO/index.js';
import HU from '../../data/HU/index.js';
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
    if (sim.get(a.id)) { // contact is back; it may meanwhile have left the sector and be on the next frequency
      expect(a.rcf).toBe(0);
      const r = sim.turn(a.id, 90);
      expect(r.ok || /not on your frequency/.test(r.msg), r.msg).toBe(true);
    }
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
    const a = sim.ac.find(x => x.ctl === 'ass');
    expect(sim.direct(a.id, 'zzzzz').ok).toBe(false);
    expect(sim.direct(a.id, 'NERDI').ok).toBe(true);
    expect(a.route[0].id).toBe('NERDI');
  });
  it('speed is clamped to a sane en-route range', () => {
    const sim = fresh({}, []);
    const a = sim.ac.find(x => x.ctl === 'ass');
    sim.speed(a.id, 900);
    expect(a.tgs).toBe(520);
  });
});

describe('sector routine: assume and transfer', () => {
  // a trainee who assumes on transfer, re-clears to the agreed exit level and transfers before the boundary
  const disciplined = sim => {
    for (const a of sim.ac) {
      if (a.ctl === 'pend' || a.noXfer) sim.assume(a.id);
      if (a.ctl !== 'ass' || a.tExit === null) continue;
      if (a.xfl !== null && Math.round(a.cfl) !== a.xfl && a.tExit <= 400) sim.clearLevel(a.id, a.xfl);
      if (a.tExit <= 45) sim.transfer(a.id);
    }
  };

  it('starts with traffic in the sector assumed, inbound traffic pending and the rest not concerned', () => {
    const sim = fresh({}, []);
    for (const a of sim.ac) expect(a.ctl, a.cs).toBe(a.lastIn ? 'ass' : a.inbound ? 'pend' : 'none');
    expect(sim.ac.some(a => a.ctl === 'ass')).toBe(true);
    expect(sim.ac.some(a => a.ctl === 'pend')).toBe(true);
  });

  it('gives every flight the agreed exit level of its exit gate, or the APP level for arrivals', () => {
    const sim = fresh({ difficulty: 'advanced' }, []), X = RO.traffic.exitLevels;
    for (const a of sim.ac) {
      if (a.cat === 'arr') expect(a.xfl, a.cs).toBe(inSector(sim.endPoint(a), sim.sector) ? X.app.LROP : X.arrivals.LROP);
      else expect(a.xfl, a.cs).toBe(X.gates[C.gateOf[a.exit]]);
    }
  });

  it('arrivals far from the airport leave at the arrival level, not the APP level', () => {
    const X = RO.traffic.exitLevels;
    for (const [sector, want] of [['NAP', X.arrivals.LROP], ['ARG', X.app.LROP]]) { // NAPOC is far north of LROP; ARGES holds it
      const sim = fresh({ sector }, []);
      let a = null;
      for (let i = 0; i < 200 && !a; i++) { const p = sim.planFlight(); if (p && p.cat === 'arr' && p.entry !== undefined && p.route[0].id === RO.traffic.mainAirports[0].arr.MD) a = sim.spawnFromPlan(p, 0); }
      expect(a, sector).toBeTruthy();
      expect(a.xfl, sector).toBe(want);
    }
  });

  it('plans part of the traffic at its exit level, so not every flight needs a level change', () => {
    let at = 0, n = 0;
    for (const seed of [1, 2, 3, 4, 5]) for (const a of fresh({ seed, difficulty: 'advanced' }, []).ac) if (a.cat === 'transit' && !a.conflict) { n++; if (a.cfl === a.xfl) at++; }
    expect(at / n).toBeGreaterThan(0.25);
    expect(at / n).toBeLessThan(0.9);
  });

  it('a pending flight that enters without being assumed is a late assume, counted once per flight', () => {
    const sim = fresh({}, []), late = new Set();
    for (let i = 0; i < 900; i++) { sim.step(); for (const a of sim.ac) if (a.lateA) late.add(a.id); }
    expect(late.size).toBeGreaterThan(0);
    expect(sim.stats.lateAssume).toBe(late.size);
    expect(sim.logs.some(l => /in ARGES and not assumed/.test(l.text))).toBe(true);
  });

  it('a flight that leaves while still assumed is a late transfer', () => {
    const sim = fresh({}, []);
    run(sim, 900);
    expect(sim.stats.lateXfer).toBeGreaterThan(0);
    expect(sim.logs.some(l => /without transfer/.test(l.text))).toBe(true);
  });

  it('transfer at the agreed exit level is clean; at any other cleared level it is a coordination error', () => {
    const sim = fresh({}, []);
    const [a, b] = sim.ac.filter(x => x.ctl === 'ass' && x.xfl !== null && x.cat === 'transit');
    sim.clearLevel(a.id, a.xfl);
    expect(sim.transfer(a.id).ok).toBe(true);
    expect(a.ctl).toBe('xfer');
    expect(sim.stats.wrongXfl).toBe(0);
    sim.clearLevel(b.id, b.xfl + 20);
    expect(sim.transfer(b.id).ok).toBe(true);
    expect(sim.stats.wrongXfl).toBe(1);
    expect(sim.logs.some(l => l.text === `${b.cs} transferred at FL${b.xfl + 20}, agreed exit FL${b.xfl}` && l.cls === 'w')).toBe(true);
  });

  it('clearances need the flight on frequency: pending or assumed, not other or transferred', () => {
    const sim = fresh({}, []);
    const other = sim.ac.find(x => x.ctl === 'none'), mine = sim.ac.find(x => x.ctl === 'ass');
    expect(sim.clearLevel(other.id, 300).msg).toMatch(/not on your frequency/);
    expect(sim.assume(other.id).ok).toBe(false);
    sim.transfer(mine.id);
    expect(sim.turn(mine.id, 90).msg).toMatch(/not on your frequency \(transferred\)/);
    expect(sim.transfer(mine.id).ok).toBe(false);
  });

  it('a disciplined trainee finishes with no late assumes, late transfers or wrong exit levels, in every sector', () => {
    // seed 4 includes gate points on the border that a new flight briefly wobbles across (Hungary NORTH)
    for (const raw of [RO, HU]) {
      const K = loadCountry(raw);
      for (const sector of [...K.sectorList.map(s => s.id), 'FIR']) {
        const sim = new Sim(K);
        sim.load(buildLocalScenario(K, cfg({ sector, difficulty: 'advanced', seed: 4 })));
        sim.scenario.injects = [];
        for (let i = 0; i < 1500; i++) { disciplined(sim); sim.step(); }
        const d = sim.debrief();
        expect([raw.meta.code, sector, d.lateAssume, d.lateXfer, d.wrongXfl]).toEqual([raw.meta.code, sector, 0, 0, 0]);
      }
    }
  });

  it('only flights on frequency raise requests', () => {
    const sim = fresh({ difficulty: 'advanced' }, []);
    for (let i = 0; i < 900; i++) { sim.step(); for (const a of sim.ac) if (a.req) expect(['ass', 'pend'], a.cs).toContain(a.ctl); }
  });
});

describe('sector routine injects', () => {
  const at = (type, min = 1) => [{ min, type, text: '' }];

  it('COORD_REQUEST: the next sector proposes another exit level; accepting changes it', () => {
    const sim = fresh({}, at('COORD_REQUEST'));
    run(sim, 61);
    const a = sim.ac.find(x => x.req && x.req.kind === 'coord');
    expect(a).toBeTruthy();
    const old = a.xfl, want = a.req.value;
    expect(Math.abs(want - old)).toBe(20);
    expect(sim.priorities().some(p => p.ac === a && p.act === 'req')).toBe(true);
    expect(sim.answer(a.id, true).ok).toBe(true);
    expect(a.xfl).toBe(want);
    expect(a.cfl).not.toBe(want); // agreeing the level is not a clearance
    expect(sim.stats.reqAnswered).toBe(1);
  });

  it('COORD_REQUEST: refusing keeps the agreed level', () => {
    const sim = fresh({}, at('COORD_REQUEST'));
    run(sim, 61);
    const a = sim.ac.find(x => x.req && x.req.kind === 'coord'), old = a.xfl;
    sim.answer(a.id, false);
    expect(a.xfl).toBe(old);
    expect(sim.logs[0].text).toMatch(/exit level change refused/);
  });

  it('LATE_TRANSFER: an inbound flight reaches the sector without transfer; it must be assumed', () => {
    const sim = fresh({}, at('LATE_TRANSFER'));
    run(sim, 61);
    const a = sim.ac.find(x => x.noXfer);
    expect(a).toBeTruthy();
    expect(a.ctl).toBe('none');
    for (let i = 0; i < 200 && !a.lastIn; i++) sim.step();
    expect(a.lastIn).toBe(true);
    expect(sim.priorities().find(p => p.ac === a).h).toMatch(/in sector without transfer/);
    expect(sim.clearLevel(a.id, 300).msg).toMatch(/not transferred to you yet/);
    expect(sim.assume(a.id).ok).toBe(true);
    expect(a.ctl).toBe('ass');
    expect(a.noXfer).toBe(false);
    expect(sim.stats.lateAssume).toBe(sim.ac.filter(x => x.lateA).length); // only other flights, if any
  });

  it('LATE_TRANSFER: not assuming it within a minute counts as a late assume', () => {
    const sim = fresh({}, at('LATE_TRANSFER'));
    run(sim, 61);
    const a = sim.ac.find(x => x.noXfer);
    for (let i = 0; i < 200 && !a.lastIn; i++) sim.step();
    for (const x of sim.ac) if (x !== a && x.ctl === 'pend') sim.assume(x.id);
    run(sim, 62);
    expect(a.lateA).toBe(true);
  });

  it('the debrief counts late assumes, late transfers and wrong exit levels', () => {
    const d = fresh({}, []).debrief();
    for (const k of ['lateAssume', 'lateXfer', 'wrongXfl']) expect(d[k], k).toBe(0);
  });
});

describe('robustness', () => {
  it('every inject copes with an empty sector', () => {
    for (const type of Object.keys(TYPES)) {
      const sim = fresh({}, [{ min: 1, type, text: '' }]);
      sim.ac = [];
      expect(() => sim.fireNow(0), type).not.toThrow();
      expect(sim.scenario.injects[0].status, type).toBe('fired');
      // only the TSA and the two injects that bring their own traffic need no aircraft in the sector
      if (!['MILITARY_TSA', 'POPUP_TRAFFIC', 'LATE_TRANSFER'].includes(type)) expect(sim.logs[0].text, type).toMatch(/no suitable aircraft in sector/);
      expect(() => run(sim, 30), type).not.toThrow();
    }
  });

  it('commands reject unknown aircraft and invalid requests', () => {
    const sim = fresh({}, []);
    const mine = sim.ac.find(a => a.ctl === 'ass');
    for (const r of [sim.assume(9999), sim.transfer(9999), sim.clearLevel(9999, 300), sim.answer(9999, true), sim.ackEmergency(9999)]) expect(r.ok).toBe(false);
    expect(sim.assume(mine.id).msg).toMatch(/already assumed/);
    expect(sim.answer(mine.id, true).msg).toBe('No open request');
    expect(sim.ackEmergency(mine.id).msg).toBe('No emergency');
  });

  it('refuses to load an unknown sector', () => {
    const sim = new Sim(C);
    expect(() => sim.load({ ...buildLocalScenario(C, cfg()), sector: 'NOPE' })).toThrow(/Unknown sector NOPE/);
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
