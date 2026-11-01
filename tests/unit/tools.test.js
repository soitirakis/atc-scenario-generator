import { describe, it, expect } from 'vitest';
import RO from '../../data/RO/index.js';
import { loadCountry } from '../../src/country.js';
import { Sim } from '../../src/sim.js';
import { buildLocalScenario } from '../../src/scenario.js';
import { Link, TRAINEE_COMMANDS } from '../../src/link.js';
import { endXY, rangeBearing, rblText } from '../../src/tools/rbl.js';
import { sep, SEP } from '../../src/tools/sep.js';
import { levelProbe } from '../../src/tools/probe.js';

/* ---------------- modules on plain data ---------------- */

describe('range and bearing line', () => {
  it('bearing in degrees true (y is south in the NM plane) and range in NM', () => {
    expect(rangeBearing([0, 0], [10, 0])).toEqual({ nm: 10, brg: 90 });
    expect(rangeBearing([0, 0], [0, -10])).toEqual({ nm: 10, brg: 360 }); // north is 360, not 000
    expect(rangeBearing([0, 0], [-3, 4])).toMatchObject({ nm: 5, brg: 217 });
    expect(rblText({ nm: 23.44, brg: 45 })).toBe('045° 23.4 NM');
  });
  it('a track end follows the track; a fixed end stays; a track that left ends the line', () => {
    const ac = { 7: { x: 3, y: 4 } }, get = id => ac[id] || null;
    expect(endXY({ ac: 7, xy: [0, 0] }, get)).toEqual([3, 4]);
    expect(endXY({ xy: [1, 2] }, get)).toEqual([1, 2]);
    expect(endXY({ ac: 8, xy: [0, 0] }, get)).toBeNull();
  });
});

describe('SEP: closest point of approach on present track and ground speed', () => {
  it('head-on, 2 NM apart laterally: minimum 2 NM when they pass', () => {
    const a = { x: -40, y: 0, trk: 90, gs: 480 }, b = { x: 40, y: 2, trk: 270, gs: 480 };
    const r = sep(a, b);
    expect(r.nowNM).toBeCloseTo(Math.hypot(80, 2));
    expect(r.minNM).toBeCloseTo(2);
    expect(r.tMin).toBe(300); // 80 NM at 960 kt closure
    expect(r.pa[0]).toBeCloseTo(0); expect(r.pb[0]).toBeCloseTo(0);
  });
  it('diverging: the minimum is now', () => {
    expect(sep({ x: 0, y: 0, trk: 270, gs: 450 }, { x: 10, y: 0, trk: 90, gs: 450 })).toMatchObject({ tMin: 0, minNM: 10 });
  });
  it('same track and speed: the distance never changes', () => {
    expect(sep({ x: 0, y: 0, trk: 90, gs: 450 }, { x: 0, y: 8, trk: 90, gs: 450 })).toMatchObject({ tMin: 0, minNM: 8 });
  });
  it(`a very slow closure is capped at ${SEP.maxS / 60} minutes`, () => {
    expect(sep({ x: 0, y: 0, trk: 90, gs: 450 }, { x: 200, y: 0, trk: 90, gs: 440 }).tMin).toBe(SEP.maxS);
  });
});

describe('level probe on plain trajectories', () => {
  const line = (x0, vx, fl) => Array.from({ length: 40 }, (_, k) => { const t = (k + 1) * 30; return { t, xy: [x0 + vx * t, 0], fl }; });
  const other = { cs: 'OTH', traj: line(80, -480 / 3600, 350) };
  const area = { id: 'TRA', poly: [[-10, -10], [-5, -10], [-5, 10], [-10, 10]], lower: 280, upper: 350, from: 0 };
  it('at a level shared with converging traffic: the conflict, soonest first', () => {
    const r = levelProbe(line(-80, 480 / 3600, 350), [other], []);
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]).toMatchObject({ cs: 'OTH', dvFt: 0, tMin: 600 });
    expect(r.conflicts[0].t).toBeLessThan(600); // separation is lost before the closest point
  });
  it('1000 ft away from it: no conflict', () => {
    expect(levelProbe(line(-80, 480 / 3600, 360), [other], []).conflicts).toEqual([]);
  });
  it('military areas: entered within their limits, only once they are active', () => {
    expect(levelProbe(line(-80, 480 / 3600, 300), [], [area]).areas).toEqual([{ id: 'TRA', tt: 540 }]);
    expect(levelProbe(line(-80, 480 / 3600, 360), [], [area]).areas).toEqual([]); // above it
    expect(levelProbe(line(-80, 480 / 3600, 300), [], [{ ...area, from: 900 }]).areas).toEqual([]); // through before it activates
  });
});

/* ---------------- in the simulator ---------------- */

const C = loadCountry(RO);
const fresh = injects => {
  const scn = buildLocalScenario(C, { sector: 'ARG', difficulty: 'intermediate', duration: 30, seed: 4127, objective: 'x' });
  scn.injects = injects || [];
  const sim = new Sim(C); sim.load(scn); return sim;
};

describe('level probe in the simulator', () => {
  it('a built-in conflict: probing the present level finds the other flight; 2000 ft away it does not', () => {
    const sim = fresh();
    const [a, b] = sim.ac.filter(x => x.conflict);
    const here = sim.probeLevel(a.id, Math.round(a.cfl));
    expect(here.ok).toBe(true);
    expect(here.conflicts.map(c => c.cs)).toContain(b.cs);
    const away = sim.probeLevel(a.id, Math.round(a.cfl) + 20);
    expect(away.conflicts.map(c => c.cs)).not.toContain(b.cs);
  });
  it('changes nothing: the aircraft keeps its clearance', () => {
    const sim = fresh(), a = sim.ac[0], before = JSON.stringify([a.cfl, a.sfl, a.fl, a.x, a.y]);
    sim.probeLevel(a.id, 410);
    expect(JSON.stringify([a.cfl, a.sfl, a.fl, a.x, a.y])).toBe(before);
  });
  it('reports a military area that is due, if the level is inside its limits', () => {
    const sim = fresh([{ min: 1, type: 'MILITARY_TSA', text: '' }]);
    for (let i = 0; i < 61; i++) sim.step();
    const z = sim.tsa[0];
    // the aircraft whose present path crosses the area laterally
    const a = sim.ac.find(x => sim.probeLevel(x.id, Math.min(z.upper, 400) - 10).areas.some(h => h.id === z.id));
    expect(a).toBeTruthy();
    const inBand = sim.probeLevel(a.id, Math.min(z.upper, 400) - 10).areas.find(h => h.id === z.id);
    expect(inBand.tt).toBeGreaterThanOrEqual(z.at - sim.t);
    expect(sim.probeLevel(a.id, z.lower - 20).areas.some(h => h.id === z.id)).toBe(false);
  });
  it('refuses a level outside FL100-FL450 and an unknown aircraft', () => {
    const sim = fresh();
    expect(sim.probeLevel(sim.ac[0].id, 90)).toMatchObject({ ok: false });
    expect(sim.probeLevel(9999, 350)).toMatchObject({ ok: false });
  });
  it('the trainee window may run it through the link, and gets the result back', () => {
    expect(TRAINEE_COMMANDS).toContain('probeLevel');
    const sim = fresh(), link = new Link({ postMessage() {} }, 'instructor');
    link.handler = (name, args) => sim[name](...args);
    const r = link.handle('probeLevel', [sim.ac[0].id, 370]);
    expect(r).toMatchObject({ ok: true, fl: 370 });
    expect(Array.isArray(r.conflicts)).toBe(true);
  });
});
