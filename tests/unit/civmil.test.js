import { describe, it, expect } from 'vitest';
import RO from '../../data/RO/index.js';
import { loadCountry } from '../../src/country.js';
import { Sim, CIVMIL, vMin, GRADING } from '../../src/sim.js';
import { buildLocalScenario } from '../../src/scenario.js';
import { makeSnapshot, TRAINEE_COMMANDS } from '../../src/link.js';
import { dist } from '../../src/geo.js';

const RC = loadCountry(RO);
const fresh = (injects, C = RC, sector = 'ARG') => {
  const scn = buildLocalScenario(C, { sector, difficulty: 'intermediate', duration: 45, seed: 4127, objective: 'x' });
  scn.injects = injects;
  const sim = new Sim(C); sim.load(scn); return sim;
};
const run = (sim, s) => { for (let i = 0; i < s; i++) sim.step(); };
const at = (type, min = 1) => ({ min, type, text: '' });
/** One of your aircraft placed next to another track. */
const yours = (sim, near, dx, dFl) => {
  const fl = near.fl + dFl;
  const b = sim.initKinematics(sim.makeAircraft({ cs: 'MINE1', type: 'A320', x: near.x + dx, y: near.y, fl, cfl: fl, sfl: fl, route: [{ id: 'FAR', xy: [near.x + dx, near.y - 2000] }], entry: 'X', exit: 'Y' }));
  b.ctl = 'ass'; sim.ac.push(b); return b;
};
/** Fire COMLOSS, wait for the declaration, notify, wait for the QRA. */
const toQra = sim => {
  run(sim, 61);
  const g = sim.scenario.injects[0].g;
  run(sim, g.declareAt - sim.t);
  expect(sim.notifyMil(g.ac.id)).toEqual({ ok: true });
  run(sim, CIVMIL.scrambleS + 1);
  return g;
};

describe('military data (training constructs)', () => {
  it('Romania: one QRA base, LRCK, at its AIP aerodrome reference point, F-16; no LRFT or LRCT', () => {
    expect(RO.military._note).toMatch(/TRAINING CONSTRUCTS/);
    expect(RO.military._note).toMatch(/LRFT .* and LRCT .* are left out/);
    expect(RC.military.qra.map(q => [q.id, q.aircraft])).toEqual([['LRCK', 'F16']]);
    expect(RC.military.qra[0].xy).toEqual(RC.airports.LRCK.xy);
  });
  it('fighter performance is labelled as not from OpenAP or a manufacturer', () => {
    for (const raw of [RO]) expect(raw.military._note).toMatch(/not from OpenAP .* and not from a manufacturer/);
  });
});

describe('OAT tracks', () => {
  it('non-RVSM: 2000 ft from FL290 up, 1000 ft below; civil pairs keep 1000 ft', () => {
    const oat = { oat: { nonRvsm: true } };
    expect(vMin({ ...oat, fl: 300 }, { fl: 320 })).toBe(2000);
    expect(vMin({ ...oat, fl: 270 }, { fl: 280 })).toBe(1000);
    expect(vMin({ fl: 350 }, { fl: 360 })).toBe(1000);
  });

  it('STCA treats 1500 ft from a non-RVSM OAT track above FL290 as a loss of separation', () => {
    const sim = fresh([at('OAT_FORMATION')]);
    run(sim, 61);
    const f = sim.scenario.injects[0].g.ac;
    sim.ac = [f]; sim.target = 0;
    yours(sim, f, 2, 15);
    sim.step();
    expect(sim.stca.some(c => c.level === 'los' && (c.a === f || c.b === f))).toBe(true);
  });

  it('stays out of the civil routine: never pending or assumed, takes no clearance, not counted as traffic', () => {
    const sim = fresh([at('OAT_FORMATION')]);
    run(sim, 61);
    const f = sim.scenario.injects[0].g.ac;
    expect([f.ctl, f.cat, f.oat.n, f.oat.nonRvsm]).toEqual(['mil', 'oat', 2, true]);
    expect(sim.clearLevel(f.id, 280)).toEqual({ ok: false, msg: `${f.cs} is OAT under military control` });
    expect(sim.command(`${f.cs} 280`).msg).toBe(`${f.cs} is OAT under military control`);
    for (let i = 0; i < 400 && sim.get(f.id); i++) { sim.step(); expect(['mil']).toContain(f.ctl); }
    expect(sim.ours(f)).toBe(false);
  });

  it('the snapshot carries a plain copy: kind, count, non-RVSM, phase; no internal links', () => {
    const sim = toQraSim();
    const s = makeSnapshot(sim), q = s.ac.find(a => a.oat && a.oat.kind === 'qra');
    expect(q.oat).toEqual({ kind: 'qra', n: 2, nonRvsm: true, phase: 'intercept' });
    expect(() => structuredClone(s)).not.toThrow();
  });
});

function toQraSim() { const sim = fresh([at('COMLOSS')]); toQra(sim); return sim; }

describe('COMLOSS escalation', () => {
  it('silent without 7600, COMLOSS declared after the set time, then a Notify MIL action', () => {
    const sim = fresh([at('COMLOSS')]);
    run(sim, 61);
    const g = sim.scenario.injects[0].g, a = g.ac;
    expect(a.sq).not.toBe('7600');
    expect(sim.clearLevel(a.id, 300)).toMatchObject({ ok: false, msg: `${a.cs}: no reply` });
    expect(sim.priorities().some(p => p.ac === a && /COMLOSS/.test(p.h))).toBe(false);
    run(sim, g.declareAt - sim.t);
    expect(sim.priorities().find(p => p.ac === a && /COMLOSS/.test(p.h))).toMatchObject({ p: 1, act: 'notify' });
    expect(TRAINEE_COMMANDS).toContain('notifyMil');
    expect(sim.notifyMil(a.id)).toEqual({ ok: true });
    expect(sim.notifyMil(a.id).ok).toBe(false); // once
  });

  it('the QRA pair scrambles from the nearest configured base, climbs to the silent aircraft and asks for coordination', () => {
    const sim = fresh([at('COMLOSS')]);
    const g = toQra(sim), q = g.qra;
    expect(q.oat.kind).toBe('qra');
    expect(q.oat.base.id).toBe('LRCK');
    expect(dist([q.x, q.y], RC.military.qra[0].xy)).toBeLessThan(5);
    expect(q.type).toBe('F16');
    expect(q.req).toMatchObject({ kind: 'mil' });
    expect(q.req.text).toMatch(new RegExp(`QRA pair airborne from LRCK, climbing FL\\d+ .* to intercept ${g.ac.cs}`));
    expect(sim.priorities().find(p => p.ac === q && p.act === 'req').p).toBe(1);
  });

  it('joins the silent aircraft, contact is restored, the fighters return to base', () => {
    const sim = fresh([at('COMLOSS')]);
    const g = toQra(sim), q = g.qra, a = g.ac;
    sim.answer(q.id, true);
    for (let i = 0; i < 1500 && q.oat.phase === 'intercept' && sim.get(a.id); i++) sim.step();
    expect(q.oat.phase).toBe('joined');
    expect(dist([q.x, q.y], [a.x, a.y])).toBeLessThan(CIVMIL.joinNM);
    run(sim, CIVMIL.joinedS + 2);
    expect(q.oat.phase).toBe('rtb');
    expect(a.rcf).toBe(0);
    expect(a.comloss).toBeUndefined();
  });

});

describe('short-notice military area extension', () => {
  it('an active area is extended down by the set amount at short notice; the original stays', () => {
    const sim = fresh([at('MILITARY_TSA'), at('TSA_EXTENSION', 7)]);
    run(sim, 7 * 60 + 1);
    expect(sim.tsa).toHaveLength(2);
    const [z, ext] = sim.tsa;
    expect(ext).toMatchObject({ id: z.id, ext: true, lower: z.lower - CIVMIL.extensionFL, upper: z.upper, active: false, name: `${z.id} extended` });
    expect(ext.at - sim.t).toBe(CIVMIL.extensionNoticeS - 1);
    run(sim, CIVMIL.extensionNoticeS);
    expect(ext.active).toBe(true);
  });
  it('with no area active, it activates one at short notice', () => {
    const sim = fresh([at('TSA_EXTENSION')]);
    run(sim, 61);
    expect(sim.tsa).toHaveLength(1);
    expect(sim.tsa[0].at - sim.t).toBe(CIVMIL.extensionNoticeS - 1);
    expect(GRADING.TSA_EXTENSION.windowS).toBe(600);
  });
});

describe('military coordination calls', () => {
  it('lapse like any request when nobody answers', () => {
    const sim = fresh([at('OAT_FORMATION')]);
    run(sim, 61);
    const f = sim.scenario.injects[0].g.ac;
    expect(f.req).toBeTruthy();
    run(sim, 125);
    expect(f.req).toBeNull();
    expect(sim.logs.some(l => l.text.startsWith(`${f.cs} (MIL) formation`) && l.text.endsWith(': no answer'))).toBe(true);
    expect(sim.scenario.injects[0].result.state).toBe('not met'); // already graded at 60 s
  });
});
