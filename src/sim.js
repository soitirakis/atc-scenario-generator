// Simulation engine. No DOM access: the UI reads state from a Sim instance and
// calls its command methods. Time advances in fixed 1-second steps via step().
import { D2R, dist, brg, angDiff, segInt, mulberry32, moveToward, fmtFL, fmtT } from './geo.js';
import { inSector } from './country.js';

export const TYPES = {
  CLIMB_REQUEST: 'Level request',
  LEVEL_BUST: 'Level bust',
  WEATHER_CELL: 'CB cell and deviations',
  RADIO_FAILURE: 'Radio failure (7600)',
  EMERGENCY_DESCENT: 'Emergency descent (7700)',
  MILITARY_TSA: 'TSA activation',
  POPUP_TRAFFIC: 'Unplanned traffic'
};

export const DIFF = {
  foundational: { count: 7, conflicts: 1, label: 'Foundational' },
  intermediate: { count: 13, conflicts: 2, label: 'Intermediate' },
  advanced: { count: 20, conflicts: 4, label: 'Advanced' }
};

export const SEPARATION = { lateralNM: 5, verticalFt: 1000, lookaheadS: 180 };
const LEVELS_ODD = [290, 310, 330, 350, 370, 390];
const LEVELS_EVEN = [300, 320, 340, 360, 380, 400];
const RADAR_REFRESH_S = 4;
const REQUEST_TIMEOUT_S = 120;

export class Sim {
  constructor(country) {
    this.C = country;
    this.scenario = null;
    this.reset();
  }

  reset() {
    this.t = 0; this.ac = []; this.nextId = 1; this.stca = []; this.los = new Map();
    this.logs = []; this.wx = []; this.tsa = []; this.ended = false; this.csUsed = new Set();
    this.spawnTimer = 30; this.rng = Math.random;
  }

  /* ---------------- helpers ---------------- */
  pick(arr) { return arr[Math.floor(this.rng() * arr.length)]; }
  wpick(items, wfn) {
    const tot = items.reduce((a, b) => a + wfn(b), 0);
    let r = this.rng() * tot;
    for (const it of items) { r -= wfn(it); if (r <= 0) return it; }
    return items[items.length - 1];
  }
  log(text, cls = '') { this.logs.unshift({ t: this.t, text, cls }); if (this.logs.length > 120) this.logs.pop(); }
  get(id) { return this.ac.find(a => a.id === id) || null; }

  callsign() {
    for (let i = 0; i < 50; i++) {
      const op = this.wpick(this.C.traffic.operators, o => o.weight);
      const num = op.icao === 'ROT' ? 100 + Math.floor(this.rng() * 600) : 10 + Math.floor(this.rng() * 2900);
      const cs = op.icao + num;
      if (!this.csUsed.has(cs)) {
        this.csUsed.add(cs);
        const type = this.pick(op.types);
        return { cs, type, heavy: /A333|B77W|B788|A359|A388/.test(type) };
      }
    }
    return { cs: 'TST' + this.nextId, type: 'A320', heavy: false };
  }

  squawk() {
    let s = '';
    for (let i = 0; i < 4; i++) s += Math.floor(this.rng() * 8);
    return /^(7500|7600|7700|2000|1200|0000)$/.test(s) ? '4321' : s;
  }

  gatePts(g, role) {
    return this.C.traffic.gates[g].pts.filter(id => {
      const r = this.C.points[id].role;
      return role === 'E' ? r !== 'X' : r !== 'E';
    });
  }

  makeAircraft(o) {
    const ac = Object.assign({
      id: this.nextId++, x: 0, y: 0, hdg: 0, gs: 450, tgs: 450, fl: 350, cfl: 350, sfl: 350, vr: 1500,
      route: [], ri: 0, mode: 'nav', thdg: 0, sq: this.squawk(), plots: [], px: 0, py: 0,
      rcf: 0, emg: false, emgAck: false, bust: false, req: null, wxCleared: null, wxAsked: null,
      popupUntil: 0, born: this.t, cat: 'transit', lastIn: false, inbound: false, inTsa: false
    }, o);
    ac.px = ac.x; ac.py = ac.y;
    return ac;
  }

  routeCrosses(start, route, sec) {
    let prev = start;
    for (const w of route) {
      for (let k = 0; k <= 10; k++) {
        const p = [prev[0] + (w.xy[0] - prev[0]) * k / 10, prev[1] + (w.xy[1] - prev[1]) * k / 10];
        if (inSector(p, sec)) return true;
      }
      prev = w.xy;
    }
    return false;
  }

  /** Plan one flight from the flow table. Returns a plan or null. */
  planFlight(opts = {}) {
    const C = this.C, T = C.traffic;
    for (let tries = 0; tries < 60; tries++) {
      const f = this.wpick(T.flows, x => x[2]);
      const rev = this.rng() < 0.5;
      const from = rev ? f[1] : f[0], to = rev ? f[0] : f[1];
      const cs = this.callsign();
      if (from === 'LROP' || to === 'LROP') {
        const g = from === 'LROP' ? to : from;
        const lrop = C.airports.LROP.xy;
        if (to === 'LROP') {
          const gate = C.points[this.pick(this.gatePts(g, 'E'))], conn = C.points[T.lrop.arr[g]];
          const route = [{ id: conn.id, xy: conn.xy }, { id: 'LROP', xy: lrop }];
          const lvl = brg(gate.xy, conn.xy) < 180 ? this.pick([330, 350, 370]) : this.pick([340, 360, 380]);
          if (opts.mustCross && !this.routeCrosses(gate.xy, route, opts.mustCross)) continue;
          return { ...cs, cat: 'arr', start: gate.xy, route, fl: lvl, cfl: lvl, rfl: lvl, entry: gate.id, exit: 'LROP' };
        }
        const gate = C.points[this.pick(this.gatePts(g, 'X'))], conn = C.points[T.lrop.dep[g]];
        const route = [{ id: conn.id, xy: conn.xy }, { id: gate.id, xy: gate.xy }];
        const b = brg(lrop, conn.xy);
        const st = [lrop[0] + Math.sin(b * D2R) * 18, lrop[1] - Math.cos(b * D2R) * 18];
        const rfl = brg(conn.xy, gate.xy) < 180 ? this.pick(LEVELS_ODD) : this.pick(LEVELS_EVEN);
        if (opts.mustCross && !this.routeCrosses(st, route, opts.mustCross)) continue;
        return { ...cs, cat: 'dep', start: st, route, fl: 100, cfl: 240, rfl, entry: 'LROP', exit: gate.id, gs: 330 };
      }
      const a = C.points[this.pick(this.gatePts(from, 'E'))], b = C.points[this.pick(this.gatePts(to, 'X'))];
      if (dist(a.xy, b.xy) < 140) continue;
      const route = [{ id: b.id, xy: b.xy }];
      if (opts.mustCross && !this.routeCrosses(a.xy, route, opts.mustCross)) continue;
      const odd = brg(a.xy, b.xy) < 180; // semicircular rule: odd eastbound, even westbound
      const lv = cs.heavy ? (odd ? this.pick([350, 370, 390]) : this.pick([360, 380, 400])) : (odd ? this.pick(LEVELS_ODD) : this.pick(LEVELS_EVEN));
      return { ...cs, cat: 'transit', start: a.xy, route, fl: lv, cfl: lv, rfl: lv, entry: a.id, exit: b.id };
    }
    return null;
  }

  spawnFromPlan(p, frac = 0) {
    const first = p.route[0].xy;
    const x = p.start[0] + (first[0] - p.start[0]) * frac, y = p.start[1] + (first[1] - p.start[1]) * frac;
    let fl = p.fl;
    if (p.cat === 'dep') fl = Math.min(p.cfl, 100 + frac * 300);
    const gs = p.gs || (fl > 280 ? 440 + Math.floor(this.rng() * 50) : 360);
    const ac = this.makeAircraft({ cs: p.cs, type: p.type, cat: p.cat, x, y, hdg: brg([x, y], first), gs, tgs: gs, fl, cfl: p.cfl, sfl: p.cfl, rfl: p.rfl, route: p.route, entry: p.entry, exit: p.exit });
    this.ac.push(ac);
    return ac;
  }

  /** Two transits whose tracks cross inside the sector, timed to meet after `minutesAhead`. */
  placeConflict(minutesAhead) {
    const sec = this.sector;
    for (let tries = 0; tries < 300; tries++) {
      const a = this.planFlight({ mustCross: sec }), b = this.planFlight({ mustCross: sec });
      if (!a || !b || a.cat !== 'transit' || b.cat !== 'transit') continue;
      const ia = segInt(a.start, a.route[0].xy, b.start, b.route[0].xy);
      if (!ia || !inSector([ia[0], ia[1]], sec)) continue;
      const ha = brg(a.start, a.route[0].xy), hb = brg(b.start, b.route[0].xy);
      const cross = Math.abs(angDiff(ha, hb));
      if (cross < 25 || cross > 165) continue;
      const gs = 460, d = gs / 60 * minutesAhead, P = [ia[0], ia[1]];
      const jitter = 1 + (this.rng() - 0.5) * 0.06;
      const pa = [P[0] - Math.sin(ha * D2R) * d, P[1] + Math.cos(ha * D2R) * d];
      const pb = [P[0] - Math.sin(hb * D2R) * d * jitter, P[1] + Math.cos(hb * D2R) * d * jitter];
      if (dist(pa, a.start) > dist(P, a.start) + 1 || dist(pb, b.start) > dist(P, b.start) + 1) continue;
      const L = a.fl, climbing = this.rng() < 0.5;
      const acA = this.makeAircraft({ cs: a.cs, type: a.type, x: pa[0], y: pa[1], hdg: ha, gs, tgs: gs, fl: L, cfl: L, sfl: L, rfl: L, route: a.route, entry: a.entry, exit: a.exit, conflict: true });
      const bFL = climbing ? L - 30 : L, bCFL = climbing ? L + 10 : L;
      const acB = this.makeAircraft({ cs: b.cs, type: b.type, x: pb[0], y: pb[1], hdg: hb, gs, tgs: gs, fl: bFL, cfl: bCFL, sfl: bCFL, rfl: bCFL, route: b.route, entry: b.entry, exit: b.exit, vr: climbing ? 1000 : 1500, conflict: true });
      this.ac.push(acA, acB);
      return [acA, acB];
    }
    return null;
  }

  /* ---------------- lifecycle ---------------- */
  load(scenario) {
    this.scenario = scenario;
    this.reset();
    const C = this.C;
    this.rng = mulberry32(scenario.seed * 7919 + scenario.sector.length * 31 + scenario.difficulty.length);
    this.sector = C.sectors[scenario.sector];
    if (!this.sector) throw new Error(`Unknown sector ${scenario.sector}`);
    this.target = DIFF[scenario.difficulty].count;
    this.stats = { losCount: 0, losSec: 0, minSep: null, reqs: 0, reqAnswered: 0, reqTimeSum: 0, reqMissed: 0, selfDev: 0, tsaInf: 0, cmds: 0, emgAckT: null };
    for (const inj of scenario.injects) { inj.status = 'pending'; inj.firedAt = null; inj.target = null; }

    const nC = scenario.conflicts;
    for (let i = 0; i < nC; i++) this.placeConflict(4 + i * Math.max(3, (scenario.duration - 8) / Math.max(1, nC)));
    let guard = 0;
    while (this.ac.length < this.target && guard++ < 200) {
      const biased = this.rng() < 0.75;
      const p = this.planFlight({ mustCross: biased ? this.sector : null });
      if (!p) continue;
      let frac = 0.1 + this.rng() * 0.6;
      if (biased) { // start near where the first leg enters the sector
        const a0 = p.start, a1 = p.route[0].xy;
        let fe = -1;
        for (let k = 0; k <= 60; k++) {
          const f = k / 60;
          if (inSector([a0[0] + (a1[0] - a0[0]) * f, a0[1] + (a1[1] - a0[1]) * f], this.sector)) { fe = f; break; }
        }
        if (fe >= 0) frac = Math.max(0.02, Math.min(0.9, fe + (this.rng() - 0.55) * 0.3));
      }
      this.spawnFromPlan(p, frac);
    }
    for (const a of this.ac) { a.plots = []; a.px = a.x; a.py = a.y; a.lastIn = inSector([a.x, a.y], this.sector); }
    this.computeInbound();
    this.log(`Session loaded: ${scenario.title}`);
  }

  /* ---------------- physics, 1 s ---------------- */
  step() {
    if (this.ended) return;
    this.t += 1;
    const C = this.C, sec = this.sector, lrop = C.airports.LROP && C.airports.LROP.xy;
    for (const a of this.ac) {
      let tgtH = a.hdg;
      if (a.mode === 'nav') {
        const w = a.route[a.ri];
        if (w) { tgtH = brg([a.x, a.y], w.xy); if (dist([a.x, a.y], w.xy) < 2.5) a.ri++; }
      } else tgtH = a.thdg;
      // automatically resume own navigation once clear of a weather cell
      if (a.wxCleared && a.mode === 'hdg') {
        const cell = a.wxCleared, w = a.route[a.ri];
        if (w && dist([a.x, a.y], [cell.x, cell.y]) > cell.r + 12) {
          const toW = brg([a.x, a.y], w.xy), toC = brg([a.x, a.y], [cell.x, cell.y]);
          if (Math.abs(angDiff(toW, toC)) > 70) { a.mode = 'nav'; a.wxCleared = null; this.log(`${a.cs} clear of weather, resuming own navigation`); }
        }
      }
      a.hdg = (a.hdg + Math.max(-3, Math.min(3, angDiff(a.hdg, tgtH))) + 360) % 360; // rate-one turn
      if (Math.abs(a.tgs - a.gs) > 0.5) a.gs += Math.sign(a.tgs - a.gs);
      if (Math.abs(a.sfl - a.fl) > 0.05) {
        const rate = (a.emg ? 4000 : a.vr) / 6000; // FL per second
        a.fl += Math.sign(a.sfl - a.fl) * Math.min(rate, Math.abs(a.sfl - a.fl));
      } else a.fl = a.sfl;
      a.x += Math.sin(a.hdg * D2R) * a.gs / 3600;
      a.y -= Math.cos(a.hdg * D2R) * a.gs / 3600;

      if (a.rcf > 0 && this.t >= a.rcf) { a.rcf = 0; a.sq = this.squawk(); this.log(`${a.cs} re-established contact on secondary frequency`, 'w'); }
      const inside = inSector([a.x, a.y], sec);
      if (inside && !a.lastIn) a.enteredAt = this.t;
      a.lastIn = inside;

      if (a.cat === 'dep' && !a.req && Math.abs(a.fl - a.cfl) < 0.1 && a.cfl < a.rfl && !a.rcf && !a.reqAskedClimb) {
        a.reqAskedClimb = true; this.raiseRequest(a, 'climb', a.rfl, `requests climb FL${fmtFL(a.rfl)}`);
      }
      if (a.cat === 'arr' && lrop && !a.req && !a.reqAskedDesc && a.cfl > 200 && dist([a.x, a.y], lrop) < 110) {
        a.reqAskedDesc = true; this.raiseRequest(a, 'descend', 110, 'requests descent');
      }
      for (const cell of this.wx) {
        if (a.wxCleared === cell) continue;
        const dc = dist([a.x, a.y], [cell.x, cell.y]);
        const rel = angDiff(a.hdg, brg([a.x, a.y], [cell.x, cell.y]));
        const ahead = Math.abs(rel) < 35 && a.fl > 200;
        if (ahead && dc < cell.r + 45 && !a.wxAsked && !a.req && !a.rcf) {
          a.wxAsked = cell; const side = rel > 0 ? -25 : 25;
          this.raiseRequest(a, 'wx', side, `requests ${Math.abs(side)}° ${side < 0 ? 'left' : 'right'} for weather`);
        }
        if (ahead && dc < cell.r + 10 && a.mode === 'nav') {
          const side = rel > 0 ? -30 : 30;
          a.mode = 'hdg'; a.thdg = (a.hdg + side + 360) % 360; a.wxCleared = cell;
          if (a.req && a.req.kind === 'wx') { this.stats.reqMissed++; a.req = null; }
          this.stats.selfDev++; this.log(`${a.cs} deviating for weather without clearance`, 'a');
        }
      }
      for (const z of this.tsa) {
        if (!z.active) continue;
        const inZ = dist([a.x, a.y], [z.x, z.y]) < z.r && a.fl >= 195;
        if (inZ && !a.inTsa) { this.stats.tsaInf++; this.log(`${a.cs} inside active TSA`, 'a'); }
        a.inTsa = inZ;
      }
      if (a.emg && a.fl <= 105) { a.done = 'emg'; this.log(`${a.cs} below FL110, transferred to approach / FIS`); }
      if (a.cat === 'arr' && lrop && dist([a.x, a.y], lrop) < 35) {
        a.done = 'arr';
        if (a.fl > 150) this.log(`${a.cs} handed to Bucharest APP too high (FL${fmtFL(a.fl)})`, 'w');
        else this.log(`${a.cs} transferred to Bucharest APP`);
      }
      if (a.ri >= a.route.length) a.done = a.done || 'exit';
      if (Math.abs(a.x) > 420 || Math.abs(a.y) > 300) a.done = 'exit';
      if (a.req && this.t - a.req.t > REQUEST_TIMEOUT_S) { this.stats.reqMissed++; this.log(`${a.cs} ${a.req.text} — no answer`, 'w'); a.req = null; }
    }
    this.ac = this.ac.filter(a => !a.done);

    this.spawnTimer--;
    if (this.spawnTimer <= 0 && this.ac.length < this.target) {
      const p = this.planFlight({ mustCross: this.rng() < 0.7 ? sec : null });
      if (p) this.spawnFromPlan(p, 0);
      this.spawnTimer = 25 + Math.floor(this.rng() * 50);
    }
    for (const c of this.wx) { c.x += c.vx; c.y += c.vy; }
    for (const z of this.tsa) if (!z.active && this.t >= z.at) { z.active = true; this.log('TSA now active FL195+', 'a'); }
    if (this.t % RADAR_REFRESH_S === 0) {
      for (const a of this.ac) { a.plots.push([a.px, a.py]); if (a.plots.length > 6) a.plots.shift(); a.px = a.x; a.py = a.y; }
    }
    this.stcaScan();
    for (const inj of this.scenario.injects) if (inj.status === 'pending' && this.t >= inj.min * 60) this.fireInject(inj);
    if (this.t % 5 === 0) this.computeInbound();
    if (this.t >= this.scenario.duration * 60) this.ended = true;
  }

  stcaScan() {
    const res = [], now = new Set(), A = this.ac, { lateralNM, verticalFt, lookaheadS } = SEPARATION;
    for (let i = 0; i < A.length; i++) for (let j = i + 1; j < A.length; j++) {
      const a = A[i], b = A[j];
      if (a.fl < 100 || b.fl < 100) continue;
      const dh = dist([a.x, a.y], [b.x, b.y]);
      if (dh > 60) continue;
      const dv = Math.abs(a.fl - b.fl) * 100;
      const key = a.id < b.id ? `${a.id}-${b.id}` : `${b.id}-${a.id}`;
      if (dh < lateralNM && dv < verticalFt) {
        now.add(key);
        if (!this.los.has(key)) { this.los.set(key, this.t); this.stats.losCount++; this.log(`LOSS OF SEPARATION ${a.cs} / ${b.cs} ${dh.toFixed(1)} NM ${Math.round(dv)} ft`, 'a'); }
        this.stats.losSec++;
        if (this.stats.minSep === null || dh < this.stats.minSep) this.stats.minSep = dh;
        res.push({ a, b, dh, dv, level: 'los', tt: 0, key });
        continue;
      }
      const va = [Math.sin(a.hdg * D2R) * a.gs / 3600, -Math.cos(a.hdg * D2R) * a.gs / 3600];
      const vb = [Math.sin(b.hdg * D2R) * b.gs / 3600, -Math.cos(b.hdg * D2R) * b.gs / 3600];
      for (let t = 10; t <= lookaheadS; t += 10) {
        const pa = [a.x + va[0] * t, a.y + va[1] * t], pb = [b.x + vb[0] * t, b.y + vb[1] * t];
        const fa = moveToward(a.fl, a.sfl, (a.emg ? 4000 : a.vr) / 6000 * t);
        const fb = moveToward(b.fl, b.sfl, (b.emg ? 4000 : b.vr) / 6000 * t);
        if (dist(pa, pb) < lateralNM && Math.abs(fa - fb) * 100 < verticalFt) { res.push({ a, b, dh, dv, level: 'pred', tt: t, key }); break; }
      }
    }
    for (const k of [...this.los.keys()]) if (!now.has(k)) this.los.delete(k);
    this.stca = res;
  }

  computeInbound() {
    for (const a of this.ac) {
      a.inbound = false;
      if (a.lastIn) continue;
      for (let s = 30; s <= 360; s += 30) {
        const p = [a.x + Math.sin(a.hdg * D2R) * a.gs / 3600 * s, a.y - Math.cos(a.hdg * D2R) * a.gs / 3600 * s];
        if (inSector(p, this.sector)) { a.inbound = true; break; }
      }
    }
  }

  raiseRequest(a, kind, value, text) {
    a.req = { kind, value, text, t: this.t };
    this.stats.reqs++;
    this.log(`${a.cs} ${text}`);
  }

  /* ---------------- injects ---------------- */
  sectorAircraft() {
    return this.ac.filter(a => a.lastIn && !a.emg && !a.rcf && !a.bust && a.fl > 240);
  }

  fireInject(inj) {
    inj.status = 'fired'; inj.firedAt = this.t;
    const C = this.C, sec = this.sector, pool = this.sectorAircraft();
    const tgt = pool.length ? pool[Math.floor(this.rng() * pool.length)] : null;
    switch (inj.type) {
      case 'CLIMB_REQUEST': {
        if (!tgt) break; inj.target = tgt.cs;
        const nl = Math.min(410, tgt.cfl + 20);
        this.raiseRequest(tgt, 'climb', nl, `requests climb FL${fmtFL(nl)} (ride report)`); break;
      }
      case 'LEVEL_BUST': {
        const t2 = pool.find(a => Math.abs(a.fl - a.cfl) < 0.1) || tgt; if (!t2) break; inj.target = t2.cs;
        t2.bust = true; t2.sfl = t2.cfl + (this.rng() < 0.5 ? 10 : -10); t2.vr = 1200;
        this.log(`${t2.cs} leaving FL${fmtFL(t2.cfl)} without clearance — selected FL${fmtFL(t2.sfl)}`, 'a'); break;
      }
      case 'WEATHER_CELL': {
        const t2 = tgt || this.ac[0]; if (!t2) break; inj.target = t2.cs;
        const ahead = 55 + this.rng() * 20, r = 12 + this.rng() * 8;
        const x = t2.x + Math.sin(t2.hdg * D2R) * ahead, y = t2.y - Math.cos(t2.hdg * D2R) * ahead;
        const drift = this.rng() * 360 * D2R;
        const cell = { x, y, r, vx: Math.sin(drift) * 15 / 3600, vy: -Math.cos(drift) * 15 / 3600, top: 380 + Math.floor(this.rng() * 6) * 10 };
        this.wx.push(cell);
        this.log(`CB cell building ahead of ${t2.cs}, tops FL${cell.top}`, 'w'); break;
      }
      case 'RADIO_FAILURE': {
        if (!tgt) break; inj.target = tgt.cs;
        tgt.rcf = this.t + 240 + Math.floor(this.rng() * 240); tgt.sq = '7600'; tgt.req = null;
        this.log(`${tgt.cs} squawking 7600 — no reply on frequency`, 'a'); break;
      }
      case 'EMERGENCY_DESCENT': {
        if (!tgt) break; inj.target = tgt.cs;
        tgt.emg = true; tgt.sq = '7700'; tgt.cfl = 100; tgt.sfl = 100; tgt.req = null;
        let best = null, bd = 1e9;
        for (const ap of C.airportList) { const dd = dist([tgt.x, tgt.y], ap.xy); if (dd < bd) { bd = dd; best = ap; } }
        tgt.route = [{ id: best.id, xy: best.xy }]; tgt.ri = 0; tgt.mode = 'nav'; tgt.tgs = 320;
        this.log(`MAYDAY ${tgt.cs} emergency descent FL100, diverting ${best.id}`, 'a'); break;
      }
      case 'MILITARY_TSA': {
        // centred on the sector point with the most traffic near it; geometry is a training construct
        const cand = C.pointList.filter(p => inSector(p.xy, sec));
        let best = cand[0], score = -1;
        for (const p of cand) { const s = this.ac.filter(a => dist([a.x, a.y], p.xy) < 60).length; if (s > score) { score = s; best = p; } }
        const c = best ? best.xy : (sec.c || [0, 0]);
        this.tsa.push({ x: c[0], y: c[1], r: 22, at: this.t + 300, active: false, name: best ? 'TSA near ' + best.id : 'TSA' });
        this.log(`TSA activation notified: active in 5 min, FL195+${best ? ' around ' + best.id : ''}`, 'w'); break;
      }
      case 'POPUP_TRAFFIC': {
        const p = this.planFlight({ mustCross: sec });
        if (!p) break;
        const ac = this.spawnFromPlan(p, 0);
        for (let k = 0; k < 400; k++) { // walk it to just outside the sector boundary
          const nx = ac.x + Math.sin(ac.hdg * D2R), ny = ac.y - Math.cos(ac.hdg * D2R);
          if (inSector([nx, ny], sec)) break;
          ac.x = nx; ac.y = ny; ac.hdg = brg([ac.x, ac.y], ac.route[0].xy);
        }
        ac.px = ac.x; ac.py = ac.y; ac.popupUntil = this.t + 90; inj.target = ac.cs;
        this.log(`${ac.cs} calling, not coordinated, FL${fmtFL(ac.fl)}`, 'w'); break;
      }
    }
    if (!inj.target && inj.type !== 'MILITARY_TSA') this.log(`Inject ${TYPES[inj.type]}: no suitable aircraft in sector`, 'w');
  }

  /** Instructor: fire a pending inject immediately. */
  fireNow(index) {
    const inj = this.scenario.injects[index];
    if (!inj || inj.status !== 'pending') return false;
    inj.min = Math.ceil(this.t / 60);
    this.fireInject(inj);
    return true;
  }

  /* ---------------- clearances ----------------
     Each returns { ok, msg }. A radio-failure aircraft never reads back. */
  _cmd(id, what, fn) {
    const a = this.get(id);
    if (!a) return { ok: false, msg: 'Aircraft no longer on frequency' };
    if (a.rcf) { this.log(`${what} to ${a.cs} — no reply`, 'w'); return { ok: false, msg: `${a.cs}: no reply (radio failure)` }; }
    fn(a); this.stats.cmds++; this.log(`${a.cs} ${what}`);
    return { ok: true };
  }
  _closeReq(a, kinds) {
    if (a.req && kinds.includes(a.req.kind)) { this.stats.reqAnswered++; this.stats.reqTimeSum += this.t - a.req.t; a.req = null; return true; }
    return false;
  }
  clearLevel(id, fl) {
    const a = this.get(id); const dir = a && fl > a.fl ? 'climb' : 'descend';
    return this._cmd(id, `${dir} FL${fmtFL(fl)}`, a => { a.cfl = fl; a.sfl = fl; a.bust = false; a.vr = 1500; this._closeReq(a, ['climb', 'descend']); });
  }
  turn(id, hdg) {
    const v = ((Math.round(hdg) % 360) + 360) % 360;
    return this._cmd(id, `turn heading ${String(v || 360).padStart(3, '0')}`, a => {
      a.mode = 'hdg'; a.thdg = v;
      if (this._closeReq(a, ['wx'])) a.wxCleared = a.wxAsked;
    });
  }
  direct(id, pointId) {
    const key = String(pointId).trim().toUpperCase();
    const p = this.C.points[key] || this.C.airports[key];
    if (!p) return { ok: false, msg: `Unknown point ${key}` };
    return this._cmd(id, `direct ${key}`, a => {
      const last = a.route[a.route.length - 1];
      a.route = key === last.id ? [last] : [{ id: key, xy: p.xy }, last];
      a.ri = 0; a.mode = 'nav'; a.wxCleared = null;
    });
  }
  speed(id, kt) {
    const v = Math.max(250, Math.min(520, Math.round(kt)));
    return this._cmd(id, `speed ${v} kt`, a => { a.tgs = v; });
  }
  resumeNav(id) { return this._cmd(id, 'resume own navigation', a => { a.mode = 'nav'; a.wxCleared = null; }); }
  answer(id, approve) {
    const a = this.get(id);
    if (!a || !a.req) return { ok: false, msg: 'No open request' };
    if (a.rcf) return { ok: false, msg: `${a.cs}: no reply` };
    const r = a.req;
    this.stats.reqAnswered++; this.stats.reqTimeSum += this.t - r.t; this.stats.cmds++;
    if (approve) {
      if (r.kind === 'climb' || r.kind === 'descend') { a.cfl = r.value; a.sfl = r.value; a.bust = false; }
      if (r.kind === 'wx') { a.mode = 'hdg'; a.thdg = (a.hdg + r.value + 360) % 360; a.wxCleared = a.wxAsked; }
      this.log(`${a.cs} ${r.kind === 'wx' ? 'deviation approved' : (r.kind === 'climb' ? 'climb' : 'descend') + ' FL' + fmtFL(r.value)}`);
    } else this.log(`${a.cs} unable, ${r.text.replace('requests ', '')}`);
    a.req = null;
    return { ok: true };
  }
  ackEmergency(id) {
    const a = this.get(id);
    if (!a || !a.emg) return { ok: false, msg: 'No emergency' };
    a.emgAck = true;
    if (this.stats.emgAckT === null) this.stats.emgAckT = this.t;
    this.log(`${a.cs} emergency acknowledged, descent approved`);
    return { ok: true };
  }

  /* ---------------- read models for the UI ---------------- */
  priorities() {
    const items = [];
    for (const a of this.ac) {
      if (a.emg) items.push({ p: 1, ac: a, h: `${a.cs} emergency descent`, s: `Squawk 7700, descending FL${fmtFL(a.fl)} to FL100, diverting ${a.route[0] ? a.route[0].id : ''}${a.emgAck ? ' · acknowledged' : ''}`, act: a.emgAck ? null : 'ack' });
      if (a.rcf) items.push({ p: 1, ac: a, h: `${a.cs} radio failure`, s: `Squawk 7600. Continues FL${fmtFL(a.cfl)} on own navigation. Separate others from it.` });
      if (a.bust) items.push({ p: 1, ac: a, h: `${a.cs} level bust`, s: `Cleared FL${fmtFL(a.cfl)}, selected FL${fmtFL(a.sfl)}, now FL${fmtFL(a.fl)}. Re-issue the level.` });
      if (a.inTsa) items.push({ p: 1, ac: a, h: `${a.cs} inside active TSA`, s: `FL${fmtFL(a.fl)}. Turn or descend below FL195.` });
    }
    for (const c of this.stca) {
      if (c.level === 'los') items.push({ p: 1, ac: c.a, h: `${c.a.cs} / ${c.b.cs} below minima`, s: `${c.dh.toFixed(1)} NM, ${Math.round(c.dv)} ft` });
      else if (c.a.lastIn || c.b.lastIn || c.a.inbound || c.b.inbound) items.push({ p: 2, ac: c.a, h: `${c.a.cs} / ${c.b.cs} STCA in ${fmtT(c.tt)}`, s: `Now ${c.dh.toFixed(0)} NM, ${Math.round(c.dv)} ft` });
    }
    for (const z of this.tsa) if (!z.active) {
      const n = this.ac.filter(a => dist([a.x, a.y], [z.x, z.y]) < z.r + 15 && a.fl >= 195).length;
      items.push({ p: 2, h: `${z.name} activates in ${fmtT(z.at - this.t)}`, s: `${n} aircraft at FL195+ inside or close to it` });
    }
    for (const a of this.ac) {
      if (a.req) items.push({ p: a.req.kind === 'wx' ? 2 : 3, ac: a, h: `${a.cs} ${a.req.text}`, s: `Waiting ${this.t - a.req.t} s`, act: 'req' });
      if (a.popupUntil > this.t) items.push({ p: 2, ac: a, h: `${a.cs} uncoordinated`, s: `Entering at FL${fmtFL(a.fl)}. Check conflicts and accept or turn.` });
    }
    const next = this.scenario.injects.find(i => i.status === 'pending');
    if (next && next.min * 60 - this.t < 120) items.push({ p: 3, h: `Inject in ${fmtT(next.min * 60 - this.t)}`, s: TYPES[next.type] + ' (instructor view)' });
    return items.sort((a, b) => a.p - b.p);
  }

  debrief() {
    const st = this.stats;
    return {
      ...st,
      avgResponse: st.reqAnswered ? Math.round(st.reqTimeSum / st.reqAnswered) : null,
      injectsFired: this.scenario.injects.filter(i => i.status === 'fired').length,
      injectsTotal: this.scenario.injects.length
    };
  }
}
