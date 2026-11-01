import { describe, it, expect } from 'vitest';
import RO from '../../data/RO/index.js';
import { loadCountry } from '../../src/country.js';
import { Sim, SEPARATION } from '../../src/sim.js';
import { buildLocalScenario } from '../../src/scenario.js';
import { clam, CLAM } from '../../src/nets/clam.js';
import { apw, APW, inside } from '../../src/nets/apw.js';
import { ram, RAM, crossTrack } from '../../src/nets/ram.js';
import { mtcd, MTCD } from '../../src/nets/mtcd.js';
import { pip } from '../../src/geo.js';

/* ---------------- modules on plain data ---------------- */

describe('CLAM (cleared level adherence)', () => {
  it('no alert when the selected level is the cleared level, level or on the way to it', () => {
    expect(clam({ fl: 350, cfl: 350, sfl: 350 })).toBeNull();
    expect(clam({ fl: 300, cfl: 350, sfl: 350 })).toBeNull(); // climbing to its clearance
    expect(clam({ fl: 380, cfl: 350, sfl: 350 })).toBeNull(); // descending to it
  });
  it('SFL: the Mode S selected level differs from the cleared level', () => {
    expect(clam({ fl: 350, cfl: 350, sfl: 360 })).toMatchObject({ kind: 'SFL', text: 'CLAM: selected FL360, cleared FL350' });
  });
  it(`DEV: more than ${CLAM.deviationFt} ft past the cleared level, towards the selected level`, () => {
    expect(clam({ fl: 352.5, cfl: 350, sfl: 360 }).kind).toBe('SFL'); // 250 ft: not yet
    expect(clam({ fl: 353.5, cfl: 350, sfl: 360 })).toMatchObject({ kind: 'DEV', devFt: 350 });
    expect(clam({ fl: 346, cfl: 350, sfl: 340 })).toMatchObject({ kind: 'DEV', devFt: -400 });
  });
  it('still climbing towards a selected level short of the cleared level: SFL, not DEV', () => {
    // cleared FL370, selected FL360 (a wrong readback), climbing through FL350: nothing has been passed yet
    expect(clam({ fl: 350, cfl: 370, sfl: 360 }).kind).toBe('SFL');
    expect(clam({ fl: 360, cfl: 370, sfl: 360 }).kind).toBe('DEV'); // levelled 1000 ft short
  });
  it('DEV: moving away from the cleared level', () => {
    expect(clam({ fl: 345, cfl: 350, sfl: 330 })).toMatchObject({ kind: 'DEV' });
  });
});

describe('APW (area proximity warning)', () => {
  const box = { id: 'LRTRA1U', poly: [[0, 0], [20, 0], [20, 20], [0, 20]], lower: 280, upper: 350 };
  const east = (fl, x0 = -20, gs = 480) => Array.from({ length: APW.lookaheadS / APW.stepS }, (_, k) => {
    const t = (k + 1) * APW.stepS; return { t, xy: [x0 + (gs / 3600) * t, 10], fl };
  });
  it('inside means laterally and within the vertical limits, limits included', () => {
    expect(inside([10, 10], 300, box)).toBe(true);
    expect(inside([10, 10], 350, box)).toBe(true);
    expect(inside([10, 10], 360, box)).toBe(false);
    expect(inside([30, 10], 300, box)).toBe(false);
  });
  it('VIOLATION when inside an active area now', () => {
    expect(apw({ xy: [5, 5], fl: 300 }, [], [box])).toMatchObject({ level: 'VIOLATION', area: box, tt: 0 });
  });
  it(`PREDICTED with the time to entry when the trajectory enters within ${APW.lookaheadS} s`, () => {
    // 20 NM out at 480 kt: enters after 150 s, outside the look-ahead; 12 NM out: after 90 s
    expect(apw({ xy: [-20, 10], fl: 300 }, east(300), [box])).toBeNull();
    expect(apw({ xy: [-12, 10], fl: 300 }, east(300, -12), [box])).toMatchObject({ level: 'PREDICTED', tt: 90 });
  });
  it('no alert when the predicted levels pass above or below the area', () => {
    expect(apw({ xy: [-12, 10], fl: 370 }, east(370, -12), [box])).toBeNull();
  });
});

describe('RAM (route adherence)', () => {
  const leg = { legFrom: [0, 0], legTo: [100, 0] };
  it('cross-track distance to the leg', () => {
    expect(crossTrack([50, 4], [0, 0], [100, 0])).toBeCloseTo(4);
    expect(crossTrack([-3, 4], [0, 0], [100, 0])).toBeCloseTo(5); // before the leg start
  });
  it(`alerts beyond ${RAM.lateralNM} NM off the cleared leg`, () => {
    expect(ram({ xy: [50, 2.9], ...leg, atcHeading: false })).toBeNull();
    expect(ram({ xy: [50, 3.4], ...leg, atcHeading: false }).xtk).toBeCloseTo(3.4);
  });
  it('no alert on a heading from ATC, or without a leg', () => {
    expect(ram({ xy: [50, 20], ...leg, atcHeading: true })).toBeNull();
    expect(ram({ xy: [50, 20], legFrom: null, legTo: [100, 0], atcHeading: false })).toBeNull();
  });
});

describe('MTCD (medium-term conflict detection)', () => {
  const T = MTCD.lookaheadS / MTCD.stepS;
  const line = (x0, y0, vx, vy, fl) => Array.from({ length: T }, (_, k) => { const t = (k + 1) * MTCD.stepS; return { t, xy: [x0 + vx * t, y0 + vy * t], fl }; });
  it('lists a predicted loss of separation with its time, closest point and vertical distance', () => {
    // head-on along y = 0 at 480 kt each, 160 NM apart: they meet after 600 s
    const a = { ac: 'A', traj: line(-80, 0, 480 / 3600, 0, 350) }, b = { ac: 'B', traj: line(80, 0, -480 / 3600, 0, 350) };
    const [c] = mtcd([a, b]);
    expect(c).toMatchObject({ a: 'A', b: 'B', tMin: 600, dvFt: 0 });
    expect(c.t).toBe(581); // 5 NM apart at 960 kt closure: 18.75 s before they meet
    expect(c.minNM).toBeCloseTo(0);
  });
  it('finds a pair that passes inside 5 NM between two samples', () => {
    // head-on, 3 NM apart laterally, meeting at 585 s: 4 NM along-track at both the 570 s and 600 s samples
    const a = { ac: 'A', traj: line(-78, 0, 480 / 3600, 0, 350) }, b = { ac: 'B', traj: line(78, 3, -480 / 3600, 0, 350) };
    expect(a.traj.every((p, k) => Math.hypot(b.traj[k].xy[0] - p.xy[0], b.traj[k].xy[1] - p.xy[1]) >= 5)).toBe(true);
    const [c] = mtcd([a, b]);
    expect(c).toMatchObject({ tMin: 585 });
    expect(c.minNM).toBeCloseTo(3);
  });
  it('vertically separated or laterally clear pairs are not listed', () => {
    const a = { ac: 'A', traj: line(-80, 0, 480 / 3600, 0, 350) };
    expect(mtcd([a, { ac: 'B', traj: line(80, 0, -480 / 3600, 0, 360) }])).toEqual([]);
    expect(mtcd([a, { ac: 'B', traj: line(80, 10, -480 / 3600, 0, 350) }])).toEqual([]);
  });
  it('soonest conflict first', () => {
    const a = { ac: 'A', traj: line(-80, 0, 480 / 3600, 0, 350) }, b = { ac: 'B', traj: line(80, 0, -480 / 3600, 0, 350) };
    const c = { ac: 'C', traj: line(-20, 0, 480 / 3600, 0, 350).map(p => ({ ...p, xy: [p.xy[0], 50] })) };
    const d = { ac: 'D', traj: line(20, 0, -480 / 3600, 0, 350).map(p => ({ ...p, xy: [p.xy[0], 50] })) };
    expect(mtcd([a, b, c, d]).map(x => x.a + x.b)).toEqual(['CD', 'AB']);
  });
});

/* ---------------- in the simulator ---------------- */

const C = loadCountry(RO);
const fresh = injects => {
  const scn = buildLocalScenario(C, { sector: 'ARG', difficulty: 'intermediate', duration: 30, seed: 4127, objective: 'x' });
  if (injects) scn.injects = injects;
  const sim = new Sim(C); sim.load(scn); return sim;
};
const run = (sim, s) => { for (let i = 0; i < s; i++) sim.step(); };

describe('safety nets in the simulator', () => {
  it('CLAM catches the level bust inject from what the radar sees: SFL first, then the deviation', () => {
    const sim = fresh([{ min: 1, type: 'LEVEL_BUST', text: '' }]);
    run(sim, 61);
    const a = sim.ac.find(x => x.bust);
    expect(sim.nets.clam.get(a.id).kind).toBe('SFL');
    for (let i = 0; i < 60 && sim.nets.clam.get(a.id).kind !== 'DEV'; i++) sim.step();
    expect(sim.nets.clam.get(a.id).kind).toBe('DEV');
    expect(sim.priorities().find(p => p.ac === a && /CLAM/.test(p.h))).toMatchObject({ p: 1, h: `${a.cs} CLAM level deviation` });
    sim.clearLevel(a.id, a.cfl);
    sim.step();
    expect(sim.nets.clam.has(a.id)).toBe(false);
  });

  it('RAM: a pilot deviation without clearance goes off route; an ATC heading does not alert', () => {
    const sim = fresh([]);
    const a = sim.ac.find(x => x.ctl === 'ass' && x.mode === 'nav' && !x.conflict);
    sim.pilotDeviate(a.id, 40);
    for (let i = 0; i < 300 && !sim.nets.ram.has(a.id) && sim.get(a.id); i++) sim.step();
    expect(sim.nets.ram.get(a.id).xtk).toBeGreaterThan(3);
    expect(sim.priorities().some(p => p.ac === a && /RAM off route/.test(p.h))).toBe(true);
    sim.turn(a.id, a.hdg); // now on an ATC heading
    sim.step();
    expect(sim.nets.ram.has(a.id)).toBe(false);
    sim.resumeNav(a.id); // own navigation again, direct from here: back on a cleared leg
    sim.step();
    expect(sim.nets.ram.has(a.id)).toBe(false);
  });

  it('APW predicts entry into an active military area, then flags the violation', () => {
    const sim = fresh([{ min: 1, type: 'MILITARY_TSA', text: '' }]);
    run(sim, 61);
    const z = sim.tsa[0];
    run(sim, z.at - sim.t + 1);
    expect(z.active).toBe(true);
    // one of our aircraft flying east, at a level inside the area, aimed through its deepest point
    // and starting 8 NM west of where that line enters the area
    const xs = z.poly.map(p => p[0]), ys = z.poly.map(p => p[1]);
    let deep = null, dmax = 0;
    for (let y = Math.min(...ys); y < Math.max(...ys); y++) for (let x = Math.min(...xs); x < Math.max(...xs); x++) {
      if (!pip([x, y], z.poly)) continue;
      const d = Math.min(...z.poly.map((p, i) => crossTrack([x, y], p, z.poly[(i + 1) % z.poly.length])));
      if (d > dmax) { dmax = d; deep = [x, y]; }
    }
    let ex = deep[0]; while (pip([ex, deep[1]], z.poly)) ex -= 0.5;
    const fl = Math.min(z.upper, 400) - 10;
    const a = sim.initKinematics(sim.makeAircraft({ cs: 'APW1', type: 'A320', x: ex - 8, y: deep[1], fl, cfl: fl, sfl: fl, route: [{ id: 'E', xy: [ex + 400, deep[1]] }], entry: 'X', exit: 'Y' }));
    a.ctl = 'ass'; sim.ac = [a]; sim.target = 0;
    sim.step();
    expect(sim.nets.apw.get(a.id)).toMatchObject({ level: 'PREDICTED', area: { id: z.id } });
    expect(sim.nets.apw.get(a.id).tt).toBeLessThanOrEqual(APW.lookaheadS);
    for (let i = 0; i < 200 && sim.nets.apw.get(a.id)?.level !== 'VIOLATION'; i++) sim.step();
    expect(sim.nets.apw.get(a.id).level).toBe('VIOLATION');
    expect(sim.priorities()[0]).toMatchObject({ p: 1, h: `APW1 APW inside ${z.id}` });
  });

  it('MTCD lists a built-in conflict well before STCA can see it', () => {
    const sim = fresh([]);
    run(sim, 10);
    // the second built-in conflict is set up about 15 minutes ahead (the first is at 4 minutes)
    const pair = sim.nets.mtcd.find(c => sim.get(c.a).conflict && sim.get(c.b).conflict && c.t > SEPARATION.lookaheadS);
    expect(pair).toBeTruthy();
    expect(pair.t).toBeGreaterThan(SEPARATION.lookaheadS);
    expect(pair.t).toBeLessThanOrEqual(MTCD.lookaheadS);
    expect(sim.stca.some(c => c.a.id === pair.a || c.a.id === pair.b)).toBe(false);
  });

  it('MTCD reaches the trainee window in the snapshot', async () => {
    const { makeSnapshot } = await import('../../src/link.js');
    const sim = fresh([]);
    run(sim, 10);
    expect(makeSnapshot(sim).mtcd).toEqual(sim.nets.mtcd);
  });
});
