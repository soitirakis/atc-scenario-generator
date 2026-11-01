import { describe, it, expect } from 'vitest';
import RO from '../../data/RO/index.js';
import { loadCountry } from '../../src/country.js';
import { Sim, RADIO, similarCallsign } from '../../src/sim.js';
import { buildLocalScenario } from '../../src/scenario.js';
import { Link, TRAINEE_COMMANDS, makeSnapshot } from '../../src/link.js';

const C = loadCountry(RO);
const fresh = () => {
  const scn = buildLocalScenario(C, { sector: 'ARG', difficulty: 'intermediate', duration: 30, seed: 4127, objective: 'x' });
  scn.injects = [];
  const sim = new Sim(C); sim.load(scn); return sim;
};
const run = (sim, s) => { for (let i = 0; i < s; i++) sim.step(); };
const mine = sim => sim.ac.filter(a => a.ctl === 'ass' && !a.rcf);
const readbackOf = (sim, cs) => sim.logs.find(l => l.cls === 'p' && l.text.endsWith(cs));

describe('readbacks and the frequency', () => {
  it(`every clearance is read back ${RADIO.readbackMinS}-${RADIO.readbackMaxS} s later, in the pilot's words`, () => {
    const sim = fresh(), a = mine(sim)[0], fl = Math.round(a.cfl) + 20;
    expect(sim.clearLevel(a.id, fl)).toEqual({ ok: true });
    expect(a.cfl).toBe(fl); // the clearance applies at once; the readback is what you hear
    expect(readbackOf(sim, a.cs)).toBeUndefined();
    let t = 0;
    while (!readbackOf(sim, a.cs) && t < 20) { sim.step(); t++; }
    expect(t).toBeGreaterThanOrEqual(RADIO.readbackMinS);
    expect(t).toBeLessThanOrEqual(RADIO.readbackMaxS);
    expect(readbackOf(sim, a.cs).text).toBe(`climb FL${fl}, ${a.cs}`);
  });

  it('the frequency is busy until the readback ends; a clearance then gets "say again" and is not applied', () => {
    const sim = fresh(), [a, b] = mine(sim);
    sim.clearLevel(a.id, Math.round(a.cfl) + 20);
    expect(sim.freqBusy()).toBe(true);
    expect(sim.freq.cs).toBe(a.cs);
    const before = b.thdg;
    const r = sim.turn(b.id, 90);
    expect(r).toEqual({ ok: false, msg: `Frequency busy: ${b.cs} say again` });
    expect(b.thdg).toBe(before);
    expect(sim.logs[0]).toMatchObject({ text: `${b.cs} say again`, cls: 'w' });
    while (sim.freqBusy()) sim.step();
    expect(readbackOf(sim, a.cs)).toBeTruthy();
    expect(sim.turn(b.id, 90).ok).toBe(true);
  });

  it('a request approval is a clearance on the frequency too', () => {
    const sim = fresh(), [a, b] = mine(sim);
    sim.pilotRequest(b.id, 'climb', 390);
    sim.clearLevel(a.id, Math.round(a.cfl) + 20);
    expect(sim.answer(b.id, true)).toMatchObject({ ok: false, msg: `Frequency busy: ${b.cs} say again` });
    expect(b.req).toBeTruthy();
  });

  it('a command line is one transmission with one readback', () => {
    const sim = fresh(), a = mine(sim)[0], fl = Math.round(a.cfl) + 20;
    expect(sim.command(`${a.cs.toLowerCase()} ${fl} H120 M78`)).toEqual({ ok: true });
    expect([a.cfl, a.thdg, a.spd]).toEqual([fl, 120, { mode: 'mach', v: 0.78 }]);
    run(sim, RADIO.readbackMaxS);
    const rbs = sim.logs.filter(l => l.cls === 'p');
    expect(rbs).toHaveLength(1);
    expect(rbs[0].text).toBe(`climb FL${fl}, turn heading 120, maintain M.78, ${a.cs}`);
  });

  it('a command line reports parse errors and refusals', () => {
    const sim = fresh(), a = mine(sim)[0], x = sim.ac.find(q => q.ctl === 'none');
    expect(sim.command('XYZ1 370')).toMatchObject({ ok: false, msg: 'No aircraft XYZ1 on the display' });
    expect(sim.command(`${a.cs} H400`).msg).toMatch(/Heading 400 is outside/);
    expect(sim.command(`${a.cs} D QQQQQ`)).toMatchObject({ ok: false, msg: 'Unknown point QQQQQ' });
    if (x) expect(sim.command(`${x.cs} 370`).msg).toMatch(/not on your frequency/);
  });

  it('readback timing has its own random stream: giving clearances does not change the other traffic', () => {
    const a = fresh(), b = fresh(), ida = mine(a)[0].id;
    a.clearLevel(ida, Math.round(a.get(ida).cfl) + 20);
    run(a, 300); run(b, 300);
    const pos = sim => sim.ac.filter(x => x.id !== ida).map(x => [x.cs, x.x.toFixed(3), x.y.toFixed(3)]);
    expect(pos(a)).toEqual(pos(b));
  });

  it('the trainee window sends command lines and sees the frequency state', () => {
    expect(TRAINEE_COMMANDS).toContain('command');
    const sim = fresh(), a = mine(sim)[0], link = new Link({ postMessage() {} }, 'instructor');
    link.handler = (name, args) => sim[name](...args);
    expect(link.handle('command', [`${a.cs} 390`])).toEqual({ ok: true });
    expect(makeSnapshot(sim).freq).toEqual({ busyUntil: sim.freq.busyUntil, cs: a.cs });
  });
});

describe('similar callsigns', () => {
  it('swap the last two digits, or change the last one, keeping the operator', () => {
    expect(similarCallsign('WZZ4127')).toBe('WZZ4172');
    expect(similarCallsign('ROT311')).toBe('ROT312'); // equal last digits: change the last one
    expect(similarCallsign('WZZ4127', new Set(['WZZ4172']))).toBe('WZZ4128');
    expect(similarCallsign('THY1')).toBeNull();
  });
});
