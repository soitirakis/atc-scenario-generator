import { describe, it, expect, vi, afterEach } from 'vitest';
import RO from '../../data/RO/index.js';
import { loadCountry } from '../../src/country.js';
import { Sim } from '../../src/sim.js';
import { buildLocalScenario } from '../../src/scenario.js';
import { Link, SimView, makeSnapshot, PROTOCOL, TRAINEE_COMMANDS } from '../../src/link.js';

const C = loadCountry(RO);

/** Behaves like BroadcastChannel: structured clone, asynchronous delivery, never echoed to the sender. */
class FakeHub {
  constructor() { this.ends = []; this.sent = []; }
  channel() {
    const hub = this, end = {
      onmessage: null, closed: false,
      postMessage(data) {
        hub.sent.push(data);
        for (const other of hub.ends) if (other !== end && !other.closed) {
          const copy = structuredClone(data);
          queueMicrotask(() => other.onmessage && other.onmessage({ data: copy }));
        }
      },
      close() { end.closed = true; }
    };
    this.ends.push(end);
    return end;
  }
}
const flush = () => new Promise(r => setTimeout(r, 0));

function setup({ injects } = {}) {
  const sim = new Sim(C);
  const scn = buildLocalScenario(C, { sector: 'ARG', difficulty: 'intermediate', duration: 30, seed: 4127, objective: 'General radar handling.' });
  if (injects) scn.injects = injects;
  sim.load(scn);
  const hub = new FakeHub();
  const instr = new Link(hub.channel(), 'instructor'), trainee = new Link(hub.channel(), 'trainee');
  instr.serve((name, args) => sim[name](...args));
  const view = new SimView(trainee, () => C);
  trainee.onSnapshot = snap => view.apply(snap);
  return { sim, hub, instr, trainee, view };
}
afterEach(() => vi.useRealTimers());

describe('snapshot: what the trainee may see', () => {
  it('carries no inject list, scenario title or instructor-only items', () => {
    const { sim } = setup({ injects: [{ min: 2, type: 'LEVEL_BUST', text: 'secret' }] });
    for (let i = 0; i < 61; i++) sim.step(); // "Inject in" is now a priority on the instructor side
    expect(sim.priorities().some(p => /^Inject in/.test(p.h))).toBe(true);
    const snap = makeSnapshot(sim, { session: 1 });
    const text = JSON.stringify(snap);
    expect(snap.injects).toBeUndefined();
    expect(text).not.toMatch(/secret|LEVEL_BUST|Inject in|Session loaded/);
    expect(snap.brief).toEqual({ duration: 30, difficulty: 'intermediate', objective: 'General radar handling.', seed: 4127 });
    expect(Object.keys(snap.brief)).not.toContain('title');
  });

  it('does not reveal which aircraft are built-in conflicts', () => {
    const { sim } = setup();
    expect(sim.ac.some(a => a.conflict)).toBe(true);
    for (const a of makeSnapshot(sim).ac) expect(a.conflict, a.cs).toBeUndefined();
  });

  it('is plain data that survives structured cloning unchanged', () => {
    const { sim } = setup();
    for (let i = 0; i < 120; i++) sim.step();
    const snap = makeSnapshot(sim, { session: 3, running: true, speed: 4 });
    expect(structuredClone(snap)).toEqual(snap);
    expect(snap.stca.every(c => typeof c.a === 'number' && typeof c.b === 'number')).toBe(true);
    expect(snap.prio.every(p => p.ac === null || typeof p.ac === 'number')).toBe(true);
  });

  it('shows a radio failure only when the aircraft squawks 7600', () => {
    const { sim } = setup({ injects: [{ min: 1, type: 'RADIO_FAILURE', text: '' }] });
    const quiet = sim.ac.find(a => a.ctl === 'ass');
    sim.pilotSilent(quiet.id, 300);
    for (let i = 0; i < 61; i++) sim.step();
    const failed = sim.ac.find(a => a.sq === '7600');
    const byId = new Map(makeSnapshot(sim).ac.map(a => [a.id, a]));
    expect(byId.get(failed.id).rcf).toBe(true);
    expect(byId.get(quiet.id).rcf).toBe(false); // silent, but nothing on radar shows it
  });

  it('includes the debrief at the end, without inject counts', () => {
    const { sim } = setup();
    while (!sim.ended) sim.step();
    const d = makeSnapshot(sim).debrief;
    expect(d.lateXfer).toBeGreaterThan(0);
    expect(d.injectsFired).toBeUndefined();
    expect(d.injectsTotal).toBeUndefined();
  });
});

describe('link between the two windows', () => {
  it('publishes snapshots that rebuild a view the radar can read', async () => {
    const { sim, instr, trainee, view } = setup();
    for (let i = 0; i < 300; i++) sim.step();
    instr.publish(makeSnapshot(sim, { session: 1 }));
    await flush();
    expect(trainee.instructorSeen()).toBe(true);
    expect(view.t).toBe(300);
    expect(view.sector).toBe(C.sectors.ARG);
    expect(view.ac.map(a => a.cs)).toEqual(sim.ac.map(a => a.cs));
    const a = sim.ac[0];
    expect(view.get(a.id).cfl).toBe(a.cfl);
    for (const c of view.stca) { expect(c.a).toBe(view.get(c.a.id)); expect(c.b).toBe(view.get(c.b.id)); }
    for (const p of view.priorities()) if (p.ac) expect(p.ac).toBe(view.get(p.ac.id));
  });

  it('runs a trainee command on the instructor Sim and returns its result', async () => {
    const { sim, view } = setup();
    const a = sim.ac.find(x => x.ctl === 'ass');
    const r = await view.clearLevel(a.id, 250);
    expect(r).toEqual({ ok: true });
    expect(a.cfl).toBe(250);
    expect((await view.clearLevel(9999, 250)).ok).toBe(false);
  });

  it('every controller action is available on the view', () => {
    const { view } = setup();
    for (const name of TRAINEE_COMMANDS) expect(typeof view[name], name).toBe('function');
  });

  it('refuses instructor actions and malformed arguments from the trainee window', async () => {
    const { sim, trainee } = setup({ injects: [{ min: 20, type: 'LEVEL_BUST', text: '' }] });
    expect((await trainee.call('fireNow', [0])).msg).toMatch(/Not allowed/);
    expect((await trainee.call('pilotSilent', [1, 300])).ok).toBe(false);
    expect((await trainee.call('load', [{}])).ok).toBe(false);
    expect((await trainee.call('clearLevel', [{ id: 1 }, 250])).msg).toBe('Bad arguments');
    expect(sim.scenario.injects[0].status).toBe('pending');
  });

  it('a command with no instructor window answering fails after the timeout', async () => {
    vi.useFakeTimers();
    const hub = new FakeHub(), trainee = new Link(hub.channel(), 'trainee', { timeoutMs: 3000 });
    const p = trainee.call('clearLevel', [1, 250]);
    await vi.advanceTimersByTimeAsync(3001);
    expect(await p).toEqual({ ok: false, msg: 'The instructor window is not responding' });
    expect(trainee.pending.size).toBe(0);
  });

  it('replies reach the window that asked, with two trainee windows open', async () => {
    const { sim, hub, view } = setup();
    const second = new SimView(new Link(hub.channel(), 'trainee'), () => C);
    const a = sim.ac.find(x => x.ctl === 'ass');
    // both ask at once; each must get its own answer, not the other window's
    const [mine, theirs] = await Promise.all([view.clearLevel(a.id, 260), second.clearLevel(9999, 260)]);
    expect(mine).toEqual({ ok: true });
    expect(theirs.ok).toBe(false);
    expect(theirs.msg).toMatch(/no longer on frequency/);
  });

  it('presence: the instructor hears the trainee hello', async () => {
    const { instr, trainee } = setup();
    let hellos = 0;
    instr.onHello = () => hellos++;
    expect(instr.traineeSeen()).toBe(false);
    trainee.hello();
    await flush();
    expect(hellos).toBe(1);
    expect(instr.traineeSeen()).toBe(true);
  });

  it('ignores messages from another protocol version or from its own role', async () => {
    const { hub, view, trainee } = setup();
    const stray = hub.channel();
    stray.postMessage({ p: PROTOCOL + 1, from: 'instructor', type: 'snap', snap: { t: 999 } });
    stray.postMessage({ p: PROTOCOL, from: 'trainee', type: 'snap', snap: { t: 999 } });
    stray.postMessage(null);
    await flush();
    expect(view.snap).toBeNull();
    expect(trainee.instructorSeen()).toBe(false);
  });

  it('rejects an unknown role', () => {
    expect(() => new Link(new FakeHub().channel(), 'pilot')).toThrow(/Unknown role/);
  });
});
