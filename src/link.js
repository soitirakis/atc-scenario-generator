// Two-window mode: the instructor window owns the Sim; the trainee window shows a
// read-only copy and sends commands. They talk over a BroadcastChannel (or anything
// with postMessage/onmessage, which the unit tests use). No DOM access here.
//
// Messages (all carry p: PROTOCOL and from: role):
//   trainee -> instructor  hello                 on start and every few seconds (presence)
//   trainee -> instructor  cmd {id, name, args}  a controller action; answered by reply
//   instructor -> trainee  reply {id, result}    { ok, msg } from the Sim
//   instructor -> trainee  snap {snap}           what the trainee may see, about once a second

export const CHANNEL_NAME = 'atc-scenario-generator';
export const PROTOCOL = 1;

/** The actions a controller can take. Anything else from a trainee window is refused. */
export const TRAINEE_COMMANDS = ['clearLevel', 'clearRate', 'turn', 'direct', 'speed', 'mach', 'resumeSpeed', 'resumeNav', 'answer', 'assume', 'transfer', 'ackEmergency'];
const ALLOWED = new Set(TRAINEE_COMMANDS);

export class Link {
  /**
   * @param channel  BroadcastChannel-like: postMessage(data) and an onmessage({ data }) property
   * @param role     'instructor' or 'trainee'
   */
  constructor(channel, role, { timeoutMs = 3000, now = () => Date.now() } = {}) {
    if (role !== 'instructor' && role !== 'trainee') throw new Error(`Unknown role ${role}`);
    this.ch = channel; this.role = role; this.timeoutMs = timeoutMs; this.now = now;
    this.uid = Math.random().toString(36).slice(2, 8); this.seq = 0;
    this.pending = new Map();
    this.handler = null; this.onSnapshot = null; this.onHello = null;
    this.lastSnapAt = null; this.lastHelloAt = null;
    channel.onmessage = e => this.receive(e && e.data);
  }

  send(msg) { this.ch.postMessage({ p: PROTOCOL, from: this.role, ...msg }); }

  receive(m) {
    if (!m || m.p !== PROTOCOL || m.from === this.role) return;
    if (this.role === 'trainee') {
      if (m.type === 'snap' && m.snap) { this.lastSnapAt = this.now(); if (this.onSnapshot) this.onSnapshot(m.snap); }
      if (m.type === 'reply') {
        const p = this.pending.get(m.id);
        if (p) { this.pending.delete(m.id); clearTimeout(p.timer); p.resolve(m.result); }
      }
      return;
    }
    if (m.type === 'hello') { this.lastHelloAt = this.now(); if (this.onHello) this.onHello(); }
    if (m.type === 'cmd') { this.lastHelloAt = this.now(); this.send({ type: 'reply', id: m.id, result: this.handle(m.name, m.args) }); }
  }

  /* ---------- instructor side ---------- */
  /** handler(name, args) runs an allowed command and returns { ok, msg }. */
  serve(handler) { this.handler = handler; }
  handle(name, args) {
    if (!ALLOWED.has(name)) return { ok: false, msg: `Not allowed from the trainee window: ${name}` };
    if (!Array.isArray(args) || args.length > 3 || !args.every(v => ['number', 'string', 'boolean'].includes(typeof v))) return { ok: false, msg: 'Bad arguments' };
    if (!this.handler) return { ok: false, msg: 'No session' };
    try { return this.handler(name, args) || { ok: true }; } catch (e) { return { ok: false, msg: String(e && e.message || e) }; }
  }
  publish(snap) { this.send({ type: 'snap', snap }); }
  /** A trainee window has been heard from in the last `ms` milliseconds. */
  traineeSeen(ms = 6000) { return this.lastHelloAt !== null && this.now() - this.lastHelloAt < ms; }

  /* ---------- trainee side ---------- */
  hello() { this.send({ type: 'hello' }); }
  /** Send a command; resolves with the Sim's { ok, msg }, or a failure if no instructor answers in time. */
  call(name, args = []) {
    return new Promise(resolve => {
      const id = `${this.uid}-${++this.seq}`;
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ ok: false, msg: 'The instructor window is not responding' }); }, this.timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.send({ type: 'cmd', id, name, args });
    });
  }
  /** A snapshot arrived in the last `ms` milliseconds. */
  instructorSeen(ms = 3500) { return this.lastSnapAt !== null && this.now() - this.lastSnapAt < ms; }

  close() {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    if (this.ch.close) this.ch.close();
  }
}

/* ---------- what a trainee may see ---------- */

// Aircraft fields a controller can know from radar, the flight plan and the frequency.
// Not sent: built-in conflict flags, inject internals, when a radio failure will end.
const AC_FIELDS = ['id', 'cs', 'type', 'cat', 'entry', 'exit', 'x', 'y', 'px', 'py', 'plots', 'hdg', 'thdg', 'trk', 'gs', 'tas', 'spd', 'rate', 'fl', 'cfl', 'sfl', 'rfl',
  'route', 'ri', 'mode', 'sq', 'ctl', 'xfl', 'noXfer', 'lastIn', 'inbound', 'tEntry', 'tExit', 'emg', 'emgAck', 'bust', 'popupUntil'];

/**
 * The trainee's copy of the session: plain data, safe for structured cloning.
 * @param sim   the instructor's Sim
 * @param info  { session, running, speed } from the instructor UI
 */
export function makeSnapshot(sim, { session = 0, running = false, speed = 1 } = {}) {
  const scn = sim.scenario;
  const ac = sim.ac.map(a => {
    const o = {};
    for (const k of AC_FIELDS) o[k] = a[k];
    o.route = a.route.map(w => ({ id: w.id, xy: [w.xy[0], w.xy[1]] }));
    o.plots = a.plots.map(p => [p[0], p[1]]);
    o.req = a.req ? { kind: a.req.kind, value: a.req.value, text: a.req.text, t: a.req.t } : null;
    o.rcf = a.rcf > 0 && a.sq === '7600'; // only a 7600 squawk shows a radio failure on radar
    return o;
  });
  return {
    session, running, speed, t: sim.t, ended: sim.ended,
    country: sim.C.meta.code, sector: sim.sector.id,
    brief: { duration: scn.duration, difficulty: scn.difficulty, objective: scn.objective, seed: scn.seed },
    ac,
    stca: sim.stca.map(c => ({ a: c.a.id, b: c.b.id, level: c.level, tt: c.tt, dh: c.dh, dv: c.dv })),
    wx: sim.wx.map(c => ({ x: c.x, y: c.y, r: c.r, top: c.top })),
    tsa: sim.tsa.map(z => ({ x: z.x, y: z.y, r: z.r, at: z.at, active: z.active, name: z.name })),
    prio: sim.priorities().filter(p => !p.instr).map(p => ({ p: p.p, ac: p.ac ? p.ac.id : null, h: p.h, s: p.s, act: p.act || null })),
    logs: sim.logs.filter(l => l.who !== 'i').slice(0, 60).map(l => ({ t: l.t, text: l.text, cls: l.cls })),
    debrief: sim.ended ? traineeDebrief(sim.debrief()) : null
  };
}

function traineeDebrief(d) {
  const { injectsFired, injectsTotal, ...rest } = d;
  return rest;
}

/**
 * Read model for the trainee window. It has the shape the renderer and panels read from
 * a Sim (C, t, ac, sector, stca, wx, tsa, logs, scenario, get, priorities, debrief), and
 * its commands go to the instructor window and resolve to { ok, msg }.
 */
export class SimView {
  constructor(link, countryFor) {
    this.link = link; this.countryFor = countryFor;
    this.C = null; this.sector = null; this.snap = null;
    this.t = 0; this.ended = false; this.ac = []; this.stca = []; this.wx = []; this.tsa = []; this.logs = [];
    this.scenario = { duration: 30, injects: [], criteria: [] };
    this.byId = new Map(); this.prio = [];
    for (const name of TRAINEE_COMMANDS) this[name] = (...args) => this.link.call(name, args);
  }
  apply(snap) {
    this.snap = snap;
    this.C = this.countryFor(snap.country);
    this.sector = this.C.sectors[snap.sector];
    this.t = snap.t; this.ended = snap.ended;
    this.ac = snap.ac; this.byId = new Map(snap.ac.map(a => [a.id, a]));
    this.stca = snap.stca.map(c => ({ ...c, a: this.byId.get(c.a), b: this.byId.get(c.b) })).filter(c => c.a && c.b);
    this.wx = snap.wx; this.tsa = snap.tsa; this.logs = snap.logs;
    this.prio = snap.prio.map(p => ({ ...p, ac: p.ac === null ? null : this.byId.get(p.ac) })).filter(p => p.ac !== undefined);
    this.scenario = { ...snap.brief, sector: snap.sector, injects: [], criteria: [] };
    return this;
  }
  get(id) { return this.byId.get(id) || null; }
  priorities() { return this.prio; }
  debrief() { return this.snap && this.snap.debrief; }
}
