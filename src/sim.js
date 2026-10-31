// Simulation engine. No DOM access: the UI reads state from a Sim instance and
// calls its command methods. Time advances in fixed 1-second steps via step().
import { D2R, dist, brg, angDiff, segInt, mulberry32, moveToward, fmtFL, fmtT } from './geo.js';
import { inSector } from './country.js';
import { machToTas, casToTas, tasToMach, windAt, normaliseWind } from './atmos.js';
import PERF from '../data/performance.json';

export const TYPES = {
  CLIMB_REQUEST: 'Level request',
  LEVEL_BUST: 'Level bust',
  WEATHER_CELL: 'CB cell and deviations',
  RADIO_FAILURE: 'Radio failure (7600)',
  EMERGENCY_DESCENT: 'Emergency descent (7700)',
  MILITARY_TSA: 'TSA activation',
  POPUP_TRAFFIC: 'Unplanned traffic',
  COORD_REQUEST: 'Exit level coordination',
  LATE_TRANSFER: 'Late transfer from previous sector'
};

export const DIFF = {
  foundational: { count: 7, conflicts: 1, label: 'Foundational' },
  intermediate: { count: 13, conflicts: 2, label: 'Intermediate' },
  advanced: { count: 20, conflicts: 4, label: 'Advanced' }
};

export const SEPARATION = { lateralNM: 5, verticalFt: 1000, lookaheadS: 180 };

/**
 * Objective and limits for each inject type, judged by gradeInjects() every step.
 * Times in seconds; windows run from the moment the inject fires (MILITARY_TSA: from activation).
 */
export const GRADING = {
  LEVEL_BUST: { reclearS: 60, text: 'Level re-cleared within 60 s' },
  RADIO_FAILURE: { lateralNM: 5, verticalFt: 1000, text: 'No aircraft within 5 NM / 1000 ft of the 7600 track while it is silent' },
  EMERGENCY_DESCENT: { ackS: 30, untilFL: 100, text: 'Acknowledged within 30 s, and no STCA with it in the descent to FL100' },
  WEATHER_CELL: { windowS: 600, text: 'Every deviation request answered before the aircraft deviates on its own (10 min)' },
  MILITARY_TSA: { windowS: 600, minFL: 195, text: 'No aircraft inside the active area at FL195+ (10 min after activation)' },
  POPUP_TRAFFIC: { windowS: 180, text: 'No STCA involving it in its first 3 min' },
  CLIMB_REQUEST: { answerS: 60, text: 'Answered within 60 s' },
  COORD_REQUEST: { answerS: 60, text: 'Answered within 60 s, and the aircraft leaves at the agreed level' },
  LATE_TRANSFER: { assumeS: 30, text: 'Assumed within 30 s of its first call' }
};
const LEVELS_ODD = [290, 310, 330, 350, 370, 390];
const LEVELS_EVEN = [300, 320, 340, 360, 380, 400];
const RADAR_REFRESH_S = 4;
const REQUEST_TIMEOUT_S = 120;
// Sector routine. Control state per aircraft (a.ctl): 'none' (not ours), 'pend' (transferred to us,
// to be assumed), 'ass' (assumed), 'xfer' (transferred onwards).
// A flight that would only clip the sector for less than minStayS stays with the sector it is in.
// A crossing only counts if the flight stays on the other side for at least crossS (gates sit on the border).
export const ROUTINE = { assumeGraceS: 60, warnS: 120, xflShare: 0.65, minStayS: 90, crossS: 60 };

export class Sim {
  constructor(country) {
    this.C = country;
    this.scenario = null;
    this.reset();
  }

  reset() {
    this.t = 0; this.ac = []; this.nextId = 1; this.stca = []; this.los = new Map();
    this.logs = []; this.wx = []; this.tsa = []; this.ended = false; this.csUsed = new Set(); this.timeline = [];
    this.spawnTimer = 30; this.rng = Math.random; this.wind = [];
  }

  /* ---------------- helpers ---------------- */
  pick(arr) { return arr[Math.floor(this.rng() * arr.length)]; }
  wpick(items, wfn) {
    const tot = items.reduce((a, b) => a + wfn(b), 0);
    let r = this.rng() * tot;
    for (const it of items) { r -= wfn(it); if (r <= 0) return it; }
    return items[items.length - 1];
  }
  /** who: 'i' for instructor-only lines (not sent to a trainee window). */
  log(text, cls = '', who = '') { this.logs.unshift({ t: this.t, text, cls, who }); if (this.logs.length > 120) this.logs.pop(); }
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

  /** Agreed exit level towards an exit gate, from traffic.json exitLevels (modelled). */
  gateXfl(exit) {
    const X = this.C.traffic.exitLevels;
    return (X && X.gates && X.gates[this.C.gateOf[exit]]) || null;
  }
  /**
   * Look ahead along the flight's own path: its route legs in own navigation, its heading when vectored.
   * Calls visit(s, [x, y]) every stepS seconds until it returns true, maxS is reached, or the flight leaves
   * en-route control (end of route, or the APP hand-off radius for arrivals). Returns { s, xy, end }.
   */
  lookAhead(a, maxS, stepS, visit) {
    const apt = a.cat === 'arr' ? this.C.mainAirports[a.exit] : null, d = a.gs / 3600 * stepS;
    let p = [a.x, a.y], k = a.ri, h = (a.trk ?? a.hdg) * D2R;
    for (let s = stepS; s <= maxS; s += stepS) {
      let left = d;
      if (a.mode === 'nav') {
        while (left > 0 && k < a.route.length) {
          const w = a.route[k].xy, dw = dist(p, w);
          if (dw <= left) { p = w; left -= dw; k++; } else { p = [p[0] + (w[0] - p[0]) / dw * left, p[1] + (w[1] - p[1]) / dw * left]; left = 0; }
        }
        if (k >= a.route.length) return { s, xy: p, end: true };
      } else p = [p[0] + Math.sin(h) * d, p[1] - Math.cos(h) * d];
      if (apt && dist(p, apt.xy) < apt.handoffNM) return { s, xy: p, end: true };
      if (visit && visit(s, p)) return { s, xy: p, end: false };
    }
    return { s: null, xy: p, end: false };
  }
  /** Where a flight leaves en-route control: the APP hand-off point for arrivals, otherwise the end of its route. */
  endPoint(a) {
    const r = this.lookAhead(a, 4 * 3600, 10);
    return r.end ? r.xy : null;
  }
  /** Agreed exit level for a flight: its gate's level, or for arrivals the APP level if we hand it to APP, else the arrival level. */
  xflOf(a) {
    if (a.cat !== 'arr') return this.gateXfl(a.exit);
    const X = this.C.traffic.exitLevels, ep = this.endPoint(a);
    if (!X || !ep) return null;
    return (inSector(ep, this.sector) ? X.app && X.app[a.exit] : X.arrivals && X.arrivals[a.exit]) || null;
  }

  /** Cruise level for a planned flight: mostly the exit gate's XFL when it suits the direction, else a semicircular level. */
  planLevel(exit, odd, list) {
    const x = this.gateXfl(exit);
    if (x && (Math.round(x / 10) % 2 === 1) === odd && list.includes(x) && this.rng() < ROUTINE.xflShare) return x;
    return this.pick(list);
  }

  /* ---------------- performance (OpenAP WRAP, data/performance.json) ---------------- */
  perfOf(a) { return PERF.types[a.type] || PERF.types.A320; }
  /**
   * Vertical speed in ft/min at a level: the type's WRAP mean rate for that band (below the
   * CAS segment, constant CAS, constant Mach), adjusted by a rate clearance. Scripted
   * overrides (a.vr) and an emergency descent take precedence.
   */
  vRate(a, fl = a.fl, climbing = a.sfl > fl) {
    if (a.emg) return 4000;
    if (a.vr) return a.vr;
    const P = this.perfOf(a), ft = fl * 100;
    const band = climbing
      ? (ft < P.climb.casFromFt.opt ? P.climb.fpm.belowCas : ft < P.climb.machFromFt.opt ? P.climb.fpm.cas : P.climb.fpm.mach)
      : (ft > P.descent.machAboveFt.opt ? P.descent.fpm.mach : ft > P.descent.casAboveFt.opt ? P.descent.fpm.cas : P.descent.fpm.belowCas);
    if (!a.rate) return band.opt;
    return a.rate.kind === 'min' ? Math.max(band.opt, Math.min(a.rate.fpm, band.max)) : Math.min(band.opt, a.rate.fpm);
  }
  /** Level after s seconds, integrating the banded rates second by second, as step() does. */
  flAfter(a, s, from = a.fl) {
    let fl = from;
    const up = a.sfl > from;
    for (let k = 0; k < s && Math.abs(a.sfl - fl) > 0.05; k++) fl = moveToward(fl, a.sfl, this.vRate(a, fl, up) / 6000);
    return fl;
  }
  /** Predicted level every 10 s over the STCA look-ahead (index 0 is t = 10 s). */
  levelProfile(a) {
    const out = [];
    let fl = a.fl;
    for (let t = 10; t <= SEPARATION.lookaheadS; t += 10) { fl = this.flAfter(a, 10, fl); out.push(fl); }
    return out;
  }
  /** Speed to fly: a speed clearance, else the type's WRAP schedule (250 kt below FL100, climb CAS/Mach, cruise Mach, descent Mach/CAS). */
  speedTarget(a) {
    if (a.spd) return a.spd;
    const P = this.perfOf(a), ft = a.fl * 100;
    if (ft < 10000) return { mode: 'ias', v: 250 };
    if (a.sfl > a.fl + 0.5) return ft < P.climb.machFromFt.opt ? { mode: 'ias', v: P.climb.casKt.opt } : { mode: 'mach', v: P.climb.mach.opt };
    if (a.sfl < a.fl - 0.5) return ft > P.descent.machAboveFt.opt ? { mode: 'mach', v: P.descent.mach.opt } : { mode: 'ias', v: P.descent.casKt.opt };
    return ft >= P.climb.machFromFt.opt ? { mode: 'mach', v: P.cruise.mach.opt } : { mode: 'ias', v: P.climb.casKt.opt };
  }
  /** True airspeed (kt) for the speed to fly, in ISA, never above the type's maximum Mach. */
  tasFor(a) {
    const t = this.speedTarget(a), ft = a.fl * 100;
    const tas = t.mode === 'mach' ? machToTas(t.v, ft) : casToTas(t.v, ft);
    return Math.min(tas, machToTas(this.perfOf(a).cruise.maxMach.max, ft));
  }
  windAt(fl) { return windAt(this.wind, fl); }
  /** Heading that keeps the track on a course, given the wind (wind correction angle). */
  headingFor(course, tas, fl) {
    const [wx, wy] = this.windAt(fl), c = course * D2R;
    const cross = wx * Math.cos(c) + wy * Math.sin(c); // wind component to the right of the course
    return (course - Math.asin(Math.max(-0.95, Math.min(0.95, cross / Math.max(tas, 1)))) / D2R + 360) % 360;
  }
  /** Ground velocity from TAS along the heading plus the wind; sets gs and trk. Returns [east, south] in kt. */
  groundVel(a) {
    const [wx, wy] = this.windAt(a.fl), h = a.hdg * D2R;
    const vx = Math.sin(h) * a.tas + wx, vy = -Math.cos(h) * a.tas + wy;
    a.gs = Math.hypot(vx, vy); a.trk = (Math.atan2(vx, -vy) / D2R + 360) % 360;
    return [vx, vy];
  }
  /** Ground speed along a course at a level for a type flying its schedule (used to time built-in conflicts). */
  gsAlong(type, course, fl) {
    const probe = { type, fl, sfl: fl, spd: null, rate: null, vr: null, emg: false };
    const tas = this.tasFor(probe), [wx, wy] = this.windAt(fl), c = course * D2R;
    const along = wx * Math.sin(c) - wy * Math.cos(c), cross = wx * Math.cos(c) + wy * Math.sin(c);
    return Math.sqrt(Math.max(0, tas * tas - cross * cross)) + along;
  }
  /** Start airspeed, heading (with wind correction to the first waypoint) and ground velocity. */
  initKinematics(a) {
    a.tas = this.tasFor(a);
    if (a.route[a.ri]) a.hdg = this.headingFor(brg([a.x, a.y], a.route[a.ri].xy), a.tas, a.fl);
    this.groundVel(a);
    return a;
  }
  /** Instructor: replace the wind table ([{ fl, dir, kt }], direction FROM). */
  setWind(levels) {
    try { this.wind = normaliseWind(levels); } catch (e) { return { ok: false, msg: e.message }; }
    this.scenario.wind = this.wind.map(w => ({ ...w })); // a restart keeps the edited wind
    this.log(`Wind set: ${this.wind.map(w => `FL${fmtFL(w.fl)} ${String(w.dir).padStart(3, '0')}/${w.kt}`).join(', ') || 'calm'}`, '', 'i');
    return { ok: true };
  }

  /** On our frequency: transferred to us (pending) or assumed. */
  onFreq(a) { return a.ctl === 'ass' || a.ctl === 'pend'; }

  makeAircraft(o) {
    const ac = Object.assign({
      id: this.nextId++, x: 0, y: 0, hdg: 0, trk: 0, gs: 450, tas: 450, spd: null, rate: null, fl: 350, cfl: 350, sfl: 350, vr: null,
      route: [], ri: 0, mode: 'nav', thdg: 0, sq: this.squawk(), plots: [], px: 0, py: 0,
      rcf: 0, emg: false, emgAck: false, bust: false, req: null, wxCleared: null, wxAsked: null,
      popupUntil: 0, born: this.t, cat: 'transit', lastIn: false, inbound: false, inTsa: false,
      ctl: 'none', xfl: null, pendAt: null, noXfer: false, everIn: false, wasOurs: false, lateA: false, tEntry: null, tExit: null
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
      const apt = C.mainAirports[from] || C.mainAirports[to];
      if (apt) {
        const g = from === apt.id ? to : from;
        if (to === apt.id) {
          const gate = C.points[this.pick(this.gatePts(g, 'E'))], conn = C.points[apt.arr[g]];
          const route = [{ id: conn.id, xy: conn.xy }, { id: apt.id, xy: apt.xy }];
          const lvl = brg(gate.xy, conn.xy) < 180 ? this.pick([330, 350, 370]) : this.pick([340, 360, 380]);
          if (opts.mustCross && !this.routeCrosses(gate.xy, route, opts.mustCross)) continue;
          return { ...cs, cat: 'arr', start: gate.xy, route, fl: lvl, cfl: lvl, rfl: lvl, entry: gate.id, exit: apt.id };
        }
        const gate = C.points[this.pick(this.gatePts(g, 'X'))], conn = C.points[apt.dep[g]];
        const route = [{ id: conn.id, xy: conn.xy }, { id: gate.id, xy: gate.xy }];
        const b = brg(apt.xy, conn.xy);
        const st = [apt.xy[0] + Math.sin(b * D2R) * 18, apt.xy[1] - Math.cos(b * D2R) * 18];
        const odd = brg(conn.xy, gate.xy) < 180, rfl = this.planLevel(gate.id, odd, odd ? LEVELS_ODD : LEVELS_EVEN);
        if (opts.mustCross && !this.routeCrosses(st, route, opts.mustCross)) continue;
        return { ...cs, cat: 'dep', start: st, route, fl: 100, cfl: 240, rfl, entry: apt.id, exit: gate.id };
      }
      const a = C.points[this.pick(this.gatePts(from, 'E'))], b = C.points[this.pick(this.gatePts(to, 'X'))];
      if (dist(a.xy, b.xy) < 140) continue;
      const route = [{ id: b.id, xy: b.xy }];
      if (opts.mustCross && !this.routeCrosses(a.xy, route, opts.mustCross)) continue;
      const odd = brg(a.xy, b.xy) < 180; // semicircular rule: odd eastbound, even westbound
      const lv = this.planLevel(b.id, odd, cs.heavy ? (odd ? [350, 370, 390] : [360, 380, 400]) : (odd ? LEVELS_ODD : LEVELS_EVEN));
      return { ...cs, cat: 'transit', start: a.xy, route, fl: lv, cfl: lv, rfl: lv, entry: a.id, exit: b.id };
    }
    return null;
  }

  /** New traffic never appears within 10 NM and 1000 ft of an existing aircraft (built-in conflicts are placed separately). */
  clearToSpawn(p, frac) {
    const first = p.route[0].xy, x = p.start[0] + (first[0] - p.start[0]) * frac, y = p.start[1] + (first[1] - p.start[1]) * frac;
    const fl = p.cat === 'dep' ? Math.min(p.cfl, 100 + frac * 300) : p.fl;
    return !this.ac.some(a => dist([a.x, a.y], [x, y]) < 10 && Math.abs(a.fl - fl) < 10);
  }

  spawnFromPlan(p, frac = 0) {
    const first = p.route[0].xy;
    const x = p.start[0] + (first[0] - p.start[0]) * frac, y = p.start[1] + (first[1] - p.start[1]) * frac;
    let fl = p.fl;
    if (p.cat === 'dep') fl = Math.min(p.cfl, 100 + frac * 300);
    const ac = this.initKinematics(this.makeAircraft({ cs: p.cs, type: p.type, cat: p.cat, x, y, fl, cfl: p.cfl, sfl: p.cfl, rfl: p.rfl, route: p.route, entry: p.entry, exit: p.exit }));
    ac.xfl = this.xflOf(ac);
    // A departure from an airport in the sector is handed over by APP. Another flight that appears
    // inside (at a gate on the boundary) is transferred only if it stays long enough, like inbound traffic.
    if (inSector([x, y], this.sector)) {
      ac.lastIn = true;
      const out = this.lookAhead(ac, 900, 15, (t, q) => !inSector(q, this.sector));
      if (p.cat === 'dep' || out.s === null || out.s >= ROUTINE.minStayS) { ac.ctl = 'pend'; ac.pendAt = this.t; ac.wasOurs = ac.everIn = true; }
    }
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
      const P = [ia[0], ia[1]], L = a.fl, jitter = 1 + (this.rng() - 0.5) * 0.06, climbing = this.rng() < 0.5;
      const bFL = climbing ? L - 30 : L, bCFL = climbing ? L + 10 : L;
      const da = this.gsAlong(a.type, ha, L) / 60 * minutesAhead, db = this.gsAlong(b.type, hb, (bFL + bCFL) / 2) / 60 * minutesAhead * jitter;
      const pa = [P[0] - Math.sin(ha * D2R) * da, P[1] + Math.cos(ha * D2R) * da];
      const pb = [P[0] - Math.sin(hb * D2R) * db, P[1] + Math.cos(hb * D2R) * db];
      if (dist(pa, a.start) > dist(P, a.start) + 1 || dist(pb, b.start) > dist(P, b.start) + 1) continue;
      const acA = this.initKinematics(this.makeAircraft({ cs: a.cs, type: a.type, x: pa[0], y: pa[1], fl: L, cfl: L, sfl: L, rfl: L, route: a.route, entry: a.entry, exit: a.exit, conflict: true }));
      const acB = this.initKinematics(this.makeAircraft({ cs: b.cs, type: b.type, x: pb[0], y: pb[1], fl: bFL, cfl: bCFL, sfl: bCFL, rfl: bCFL, route: b.route, entry: b.entry, exit: b.exit, vr: climbing ? 1000 : null, conflict: true }));
      acA.xfl = this.xflOf(acA); acB.xfl = this.xflOf(acB);
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
    this.wind = scenario.wind ? normaliseWind(scenario.wind) : [];
    this.stats = { losCount: 0, losSec: 0, minSep: null, reqs: 0, reqAnswered: 0, reqTimeSum: 0, reqMissed: 0, selfDev: 0, tsaInf: 0, cmds: 0, emgAckT: null, lateAssume: 0, lateXfer: 0, wrongXfl: 0 };
    for (const inj of scenario.injects) { inj.status = 'pending'; inj.firedAt = null; inj.target = null; inj.result = null; inj.g = null; }

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
      // an arrival placed inside the APP hand-off radius would be handed over on the first step
      const apt = p.cat === 'arr' ? C.mainAirports[p.exit] : null, f0 = p.route[0].xy;
      if (apt && dist([p.start[0] + (f0[0] - p.start[0]) * frac, p.start[1] + (f0[1] - p.start[1]) * frac], apt.xy) < apt.handoffNM + 10) continue;
      if (!this.clearToSpawn(p, frac)) continue;
      this.spawnFromPlan(p, frac);
    }
    // the session starts with traffic in the sector already assumed; inbound traffic becomes pending
    for (const a of this.ac) {
      a.plots = []; a.px = a.x; a.py = a.y; a.lastIn = a.everIn = inSector([a.x, a.y], this.sector);
      a.ctl = a.lastIn ? 'ass' : 'none'; a.pendAt = null; a.wasOurs = a.lastIn;
    }
    this.computeInbound();
    this.log(`Session loaded: ${scenario.title}`, '', 'i');
  }

  /* ---------------- physics, 1 s ---------------- */
  step() {
    if (this.ended) return;
    this.t += 1;
    const C = this.C, sec = this.sector;
    for (const a of this.ac) {
      const apt = a.cat === 'arr' ? C.mainAirports[a.exit] : null;
      let tgtH = a.hdg;
      if (a.mode === 'nav') { // own navigation flies the track to the waypoint, correcting for wind
        const w = a.route[a.ri];
        if (w) { tgtH = this.headingFor(brg([a.x, a.y], w.xy), a.tas, a.fl); if (dist([a.x, a.y], w.xy) < 2.5) a.ri++; }
      } else tgtH = a.thdg; // a heading clearance holds the heading; the wind makes the track drift
      // automatically resume own navigation once clear of a weather cell
      if (a.wxCleared && a.mode === 'hdg') {
        const cell = a.wxCleared, w = a.route[a.ri];
        if (w && dist([a.x, a.y], [cell.x, cell.y]) > cell.r + 12) {
          const toW = brg([a.x, a.y], w.xy), toC = brg([a.x, a.y], [cell.x, cell.y]);
          if (Math.abs(angDiff(toW, toC)) > 70) { a.mode = 'nav'; a.wxCleared = null; this.log(`${a.cs} clear of weather, resuming own navigation`); }
        }
      }
      a.hdg = (a.hdg + Math.max(-3, Math.min(3, angDiff(a.hdg, tgtH))) + 360) % 360; // rate-one turn
      a.tas = moveToward(a.tas, this.tasFor(a), 1.5); // about 1.5 kt/s of acceleration
      if (Math.abs(a.sfl - a.fl) > 0.05) {
        const rate = this.vRate(a) / 6000; // FL per second
        a.fl += Math.sign(a.sfl - a.fl) * Math.min(rate, Math.abs(a.sfl - a.fl));
      }
      if (Math.abs(a.sfl - a.fl) <= 0.05) { a.fl = a.sfl; a.rate = null; } // a rate clearance ends at the cleared level
      const [vx, vy] = this.groundVel(a);
      a.x += vx / 3600;
      a.y += vy / 3600;

      if (a.rcf > 0 && this.t >= a.rcf) { a.rcf = 0; if (a.sq === '7600') a.sq = this.squawk(); this.log(`${a.cs} re-established contact on secondary frequency`, 'w'); }
      const inside = inSector([a.x, a.y], sec);
      if (inside && !a.lastIn) this.entered(a);
      else if (!inside && a.lastIn) this.left(a);
      a.lastIn = inside;
      if (inside && !a.lateA && a.pendAt !== null && (a.ctl === 'pend' || (a.noXfer && a.ctl === 'none')) && this.t - a.pendAt > ROUTINE.assumeGraceS) {
        a.lateA = true; this.stats.lateAssume++; this.mark(`Late assume ${a.cs}`, 'w');
        this.log(`${a.cs} in ${sec.name} and not assumed`, 'w');
      }

      if (a.cat === 'dep' && this.onFreq(a) && !a.req && Math.abs(a.fl - a.cfl) < 0.1 && a.cfl < a.rfl && !a.rcf && !a.reqAskedClimb) {
        a.reqAskedClimb = true; this.raiseRequest(a, 'climb', a.rfl, `requests climb FL${fmtFL(a.rfl)}`);
      }
      if (apt && this.onFreq(a) && !a.req && !a.reqAskedDesc && a.cfl > 200 && dist([a.x, a.y], apt.xy) < 110) {
        const X = C.traffic.exitLevels, appFl = (X && X.app && X.app[apt.id]) || 110;
        a.reqAskedDesc = true; this.raiseRequest(a, 'descend', appFl, 'requests descent');
      }
      for (const cell of this.wx) {
        if (a.wxCleared === cell) continue;
        const dc = dist([a.x, a.y], [cell.x, cell.y]);
        const rel = angDiff(a.hdg, brg([a.x, a.y], [cell.x, cell.y]));
        const ahead = Math.abs(rel) < 35 && a.fl > 200;
        if (ahead && dc < cell.r + 45 && !a.wxAsked && !a.req && !a.rcf && this.onFreq(a)) {
          a.wxAsked = cell; const side = rel > 0 ? -25 : 25;
          this.raiseRequest(a, 'wx', side, `requests ${Math.abs(side)}° ${side < 0 ? 'left' : 'right'} for weather`);
          a.req.cell = cell;
        }
        if (ahead && dc < cell.r + 10 && a.mode === 'nav') {
          const side = rel > 0 ? -30 : 30;
          a.mode = 'hdg'; a.thdg = (a.hdg + side + 360) % 360; a.wxCleared = cell;
          if (a.req && a.req.kind === 'wx') { if (a.req.cell) a.req.cell.selfDevs.push({ cs: a.cs, t: this.t }); this.stats.reqMissed++; a.req = null; }
          if (this.onFreq(a)) { this.stats.selfDev++; this.log(`${a.cs} deviating for weather without clearance`, 'a'); }
        }
      }
      for (const z of this.tsa) {
        if (!z.active) continue;
        const inZ = dist([a.x, a.y], [z.x, z.y]) < z.r && a.fl >= 195;
        if (inZ && !a.inTsa) { this.stats.tsaInf++; this.log(`${a.cs} inside active TSA`, 'a'); }
        a.inTsa = inZ;
      }
      if (a.emg && a.fl <= 105) { a.done = 'emg'; this.log(`${a.cs} below FL110, transferred to approach / FIS`); }
      if (apt && dist([a.x, a.y], apt.xy) < apt.handoffNM) {
        a.done = 'arr';
        if (a.fl > 150) this.log(`${a.cs} handed to ${apt.approach} too high (FL${fmtFL(a.fl)})`, 'w');
        else this.log(`${a.cs} transferred to ${apt.approach}`);
      }
      if (a.ri >= a.route.length) a.done = a.done || 'exit';
      if (Math.abs(a.x) > 420 || Math.abs(a.y) > 300) a.done = 'exit';
      if (a.req && this.t - a.req.t > REQUEST_TIMEOUT_S) { if (a.req.cell) a.req.cell.missed.push({ cs: a.cs, t: this.t }); this.stats.reqMissed++; this.log(`${a.cs} ${a.req.text} — no answer`, 'w'); a.req = null; }
    }
    // leaving the simulation still assumed (reached the exit gate or the APP hand-off) is a late transfer too
    for (const a of this.ac) if (a.done && a.done !== 'emg' && a.ctl === 'ass') this.lateTransfer(a, a.done === 'arr' ? `reached the ${(C.mainAirports[a.exit] || {}).approach || 'APP'} hand-off` : 'reached its exit');
    this.ac = this.ac.filter(a => !a.done);

    this.spawnTimer--;
    if (this.spawnTimer <= 0 && this.ac.length < this.target) {
      const p = this.planFlight({ mustCross: this.rng() < 0.7 ? sec : null });
      if (p && this.clearToSpawn(p, 0)) this.spawnFromPlan(p, 0);
      this.spawnTimer = 25 + Math.floor(this.rng() * 50);
    }
    for (const c of this.wx) { c.x += c.vx; c.y += c.vy; }
    for (const z of this.tsa) if (!z.active && this.t >= z.at) { z.active = true; this.log('TSA now active FL195+', 'a'); this.mark(`${z.name} active`); }
    if (this.t % RADAR_REFRESH_S === 0) {
      for (const a of this.ac) { a.plots.push([a.px, a.py]); if (a.plots.length > 6) a.plots.shift(); a.px = a.x; a.py = a.y; }
    }
    this.stcaScan();
    this.gradeInjects();
    for (const inj of this.scenario.injects) if (inj.status === 'pending' && this.t >= inj.min * 60) this.fireInject(inj);
    if (this.t % 5 === 0) this.computeInbound();
    if (this.t >= this.scenario.duration * 60) this.ended = true;
  }

  stcaScan() {
    const res = [], now = new Set(), A = this.ac, { lateralNM, verticalFt, lookaheadS } = SEPARATION;
    const profiles = new Map(), profile = a => { if (!profiles.has(a)) profiles.set(a, this.levelProfile(a)); return profiles.get(a); };
    for (let i = 0; i < A.length; i++) for (let j = i + 1; j < A.length; j++) {
      const a = A[i], b = A[j];
      if (a.fl < 100 || b.fl < 100) continue;
      const dh = dist([a.x, a.y], [b.x, b.y]);
      if (dh > 60) continue;
      const dv = Math.abs(a.fl - b.fl) * 100;
      const key = a.id < b.id ? `${a.id}-${b.id}` : `${b.id}-${a.id}`;
      if (dh < lateralNM && dv < verticalFt) {
        now.add(key);
        if (!this.los.has(key)) { this.los.set(key, this.t); this.stats.losCount++; this.log(`LOSS OF SEPARATION ${a.cs} / ${b.cs} ${dh.toFixed(1)} NM ${Math.round(dv)} ft`, 'a'); this.mark(`Loss of separation ${a.cs} / ${b.cs}`, 'a'); }
        this.stats.losSec++;
        if (this.stats.minSep === null || dh < this.stats.minSep) this.stats.minSep = dh;
        res.push({ a, b, dh, dv, level: 'los', tt: 0, key });
        continue;
      }
      const va = [Math.sin(a.trk * D2R) * a.gs / 3600, -Math.cos(a.trk * D2R) * a.gs / 3600];
      const vb = [Math.sin(b.trk * D2R) * b.gs / 3600, -Math.cos(b.trk * D2R) * b.gs / 3600];
      const la = profile(a), lb = profile(b);
      for (let t = 10; t <= lookaheadS; t += 10) {
        const pa = [a.x + va[0] * t, a.y + va[1] * t], pb = [b.x + vb[0] * t, b.y + vb[1] * t];
        const fa = la[t / 10 - 1], fb = lb[t / 10 - 1];
        if (dist(pa, pb) < lateralNM && Math.abs(fa - fb) * 100 < verticalFt) { res.push({ a, b, dh, dv, level: 'pred', tt: t, key }); break; }
      }
    }
    for (const k of [...this.los.keys()]) if (!now.has(k)) this.los.delete(k);
    this.stca = res;
  }

  /**
   * Look-ahead along each flight's path: inbound traffic and its time to entry, and for traffic in
   * the sector the time to exit (or to the end of en-route control). The previous sector transfers
   * inbound traffic to us, so it becomes pending here.
   */
  computeInbound() {
    const sec = this.sector;
    for (const a of this.ac) {
      a.inbound = false; a.tEntry = null; a.tExit = null;
      if (a.lastIn) {
        // where it leaves for good, or leaves en-route control while still inside. Same 5 s resolution as
        // staysOut, and a slightly shorter excursion counts, so the transfer prompt never comes after the penalty.
        let out = null;
        const r = this.lookAhead(a, 900 + ROUTINE.crossS, 5, (s, p) => {
          if (inSector(p, sec)) { out = null; return false; }
          if (out === null) out = s;
          return s - out >= ROUTINE.crossS - 10;
        });
        a.tExit = r.s === null ? null : out !== null ? out : r.s;
      } else {
        let s0 = null, s1 = null;
        const r = this.lookAhead(a, 360 + ROUTINE.minStayS, 15, (s, p) => {
          const inside = inSector(p, sec);
          if (inside && s0 === null) { if (s > 360) return true; s0 = s; } else if (!inside && s0 !== null) { s1 = s; return true; }
          return false;
        });
        const stay = s0 === null ? 0 : (s1 ?? (r.end ? r.s : Infinity)) - s0;
        if (s0 !== null && stay >= ROUTINE.minStayS) { a.inbound = true; a.tEntry = s0; }
        // assumed before entry but leaving en-route control (e.g. handed to APP) before it gets here
        else if (a.ctl === 'ass') { const e = this.lookAhead(a, 3600, 15); a.tExit = e.end ? e.s : null; }
      }
      // an assumed flight that drifted out along the boundary and is not coming back has left
      if (a.ctl === 'ass' && !a.lastIn && a.everIn && !a.inbound && this.staysOut(a)) this.lateTransfer(a, `left ${sec.name}`);
      // transferred to us once, as it approaches; a flight that was ours and has left is not transferred again
      if (a.ctl === 'none' && a.inbound && !a.noXfer && !a.wasOurs) { a.ctl = 'pend'; a.pendAt = this.t; a.wasOurs = true; }
      else if (a.ctl === 'pend' && !a.inbound && !a.lastIn && !a.everIn) { a.ctl = 'none'; a.pendAt = null; } // turned away
    }
  }

  entered(a) {
    a.enteredAt = this.t; a.everIn = true;
    if (a.noXfer && a.ctl === 'none') { a.pendAt = this.t; this.log(`${a.cs} entering ${this.sector.name}, not transferred by the previous sector`, 'w'); }
  }
  /** Out of the sector and not back within crossS: a real exit, not a wobble along the boundary. */
  staysOut(a) {
    const r = this.lookAhead(a, ROUTINE.crossS, 5, (s, p) => inSector(p, this.sector));
    return r.s === null || r.end;
  }
  left(a) {
    if (a.ctl === 'ass') { if (this.staysOut(a)) this.lateTransfer(a, `left ${this.sector.name}`); }
    else if (a.ctl !== 'xfer' && this.staysOut(a)) { a.ctl = 'none'; a.noXfer = false; }
  }
  /** Transfer of control at the wrong cleared level is a coordination error. */
  checkXfl(a) {
    if (a.xfl !== null && Math.round(a.cfl) !== a.xfl) {
      this.stats.wrongXfl++;
      this.mark(`Wrong exit level ${a.cs}: FL${fmtFL(a.cfl)}, agreed FL${fmtFL(a.xfl)}`, 'w');
      this.log(`${a.cs} transferred at FL${fmtFL(a.cfl)}, agreed exit FL${fmtFL(a.xfl)}`, 'w');
    }
  }
  lateTransfer(a, what) {
    a.leftAt = this.t; a.leftCfl = Math.round(a.cfl); this.mark(`Late transfer ${a.cs}`, 'w');
    this.stats.lateXfer++;
    this.log(`${a.cs} ${what} without transfer`, 'w');
    this.checkXfl(a);
    a.ctl = 'xfer';
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
        this.raiseRequest(tgt, 'climb', nl, `requests climb FL${fmtFL(nl)} (ride report)`); inj.g = { ac: tgt, req: tgt.req }; break;
      }
      case 'LEVEL_BUST': {
        const t2 = pool.find(a => Math.abs(a.fl - a.cfl) < 0.1) || tgt; if (!t2) break; inj.target = t2.cs;
        t2.bust = true; t2.sfl = t2.cfl + (this.rng() < 0.5 ? 10 : -10); t2.vr = 1200; t2.bustFixedAt = undefined; inj.g = { ac: t2 };
        this.log(`${t2.cs} leaving FL${fmtFL(t2.cfl)} without clearance — selected FL${fmtFL(t2.sfl)}`, 'a'); break;
      }
      case 'WEATHER_CELL': {
        const t2 = tgt || this.ac[0]; if (!t2) break; inj.target = t2.cs;
        const ahead = 55 + this.rng() * 20, r = 12 + this.rng() * 8;
        const x = t2.x + Math.sin(t2.hdg * D2R) * ahead, y = t2.y - Math.cos(t2.hdg * D2R) * ahead;
        const drift = this.rng() * 360 * D2R;
        const cell = { x, y, r, vx: Math.sin(drift) * 15 / 3600, vy: -Math.cos(drift) * 15 / 3600, top: 380 + Math.floor(this.rng() * 6) * 10 };
        cell.answers = []; cell.missed = []; cell.selfDevs = [];
        this.wx.push(cell); inj.g = { cell };
        this.log(`CB cell building ahead of ${t2.cs}, tops FL${cell.top}`, 'w'); break;
      }
      case 'RADIO_FAILURE': {
        if (!tgt) break; inj.target = tgt.cs;
        tgt.rcf = this.t + 240 + Math.floor(this.rng() * 240); tgt.sq = '7600'; tgt.req = null; inj.g = { ac: tgt };
        this.log(`${tgt.cs} squawking 7600 — no reply on frequency`, 'a'); break;
      }
      case 'EMERGENCY_DESCENT': {
        if (!tgt) break; inj.target = tgt.cs;
        tgt.emg = true; tgt.sq = '7700'; tgt.cfl = 100; tgt.sfl = 100; tgt.req = null; inj.g = { ac: tgt };
        tgt.xfl = null; // a diverting emergency is no longer held to the agreed exit level
        let best = null, bd = 1e9;
        for (const ap of C.airportList) { const dd = dist([tgt.x, tgt.y], ap.xy); if (dd < bd) { bd = dd; best = ap; } }
        tgt.route = [{ id: best.id, xy: best.xy }]; tgt.ri = 0; tgt.mode = 'nav'; tgt.spd = { mode: 'ias', v: 320 };
        this.log(`MAYDAY ${tgt.cs} emergency descent FL100, diverting ${best.id}`, 'a'); break;
      }
      case 'MILITARY_TSA': {
        // centred on the sector point with the most traffic near it; geometry is a training construct
        const cand = C.pointList.filter(p => inSector(p.xy, sec));
        let best = cand[0], score = -1;
        for (const p of cand) { const s = this.ac.filter(a => dist([a.x, a.y], p.xy) < 60).length; if (s > score) { score = s; best = p; } }
        const c = best ? best.xy : (sec.c || [0, 0]);
        const zone = { x: c[0], y: c[1], r: 22, at: this.t + 300, active: false, name: best ? 'TSA near ' + best.id : 'TSA' };
        this.tsa.push(zone); inj.g = { zone };
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
        ac.px = ac.x; ac.py = ac.y; ac.popupUntil = this.t + 90; inj.target = ac.cs; inj.g = { ac };
        this.log(`${ac.cs} calling, not coordinated, FL${fmtFL(ac.fl)}`, 'w'); break;
      }
      case 'COORD_REQUEST': {
        // the next sector asks for a different exit level; prefer a flight with time left before its exit
        const cand = this.ac.filter(a => a.ctl === 'ass' && a.lastIn && a.cat !== 'arr' && a.xfl !== null && !a.req && !a.emg)
          .sort((a, b) => (a.tExit ?? 1e9) - (b.tExit ?? 1e9));
        const t2 = cand.find(a => a.tExit !== null && a.tExit >= ROUTINE.warnS) || cand[0];
        if (!t2) break; inj.target = t2.cs;
        let nx = t2.xfl + (this.rng() < 0.5 ? 20 : -20);
        if (nx > 410 || nx < 250) nx = t2.xfl * 2 - nx;
        this.raiseRequest(t2, 'coord', nx, `next sector requests exit FL${fmtFL(nx)} instead of FL${fmtFL(t2.xfl)}`); inj.g = { ac: t2, req: t2.req }; break;
      }
      case 'LATE_TRANSFER': {
        // an inbound flight the previous sector does not transfer: it reaches the sector unannounced
        let t2 = this.ac.filter(a => !a.lastIn && a.inbound && a.ctl !== 'ass' && !a.emg && a.tEntry !== null && a.tEntry <= ROUTINE.warnS)
          .sort((a, b) => a.tEntry - b.tEntry)[0];
        if (!t2) {
          const p = this.planFlight({ mustCross: sec });
          if (!p) break;
          t2 = this.spawnFromPlan(p, 0);
          let k = 0, past = 0;
          while (k++ < 400 && past < 3) { // walk it along its track to just inside the boundary
            t2.x += Math.sin(t2.hdg * D2R); t2.y -= Math.cos(t2.hdg * D2R);
            if (inSector([t2.x, t2.y], sec)) past++;
          }
          t2.px = t2.x; t2.py = t2.y;
        }
        t2.ctl = 'none'; t2.noXfer = true; t2.pendAt = t2.lastIn ? this.t : null; t2.assumedAt = undefined; inj.target = t2.cs; inj.g = { ac: t2 }; break;
      }
    }
    if (!inj.target && inj.type !== 'MILITARY_TSA') this.log(`Inject ${TYPES[inj.type]}: no suitable aircraft in sector`, 'w', 'i');
    // graded only when the inject found something to act on
    if (inj.g) inj.result = { state: 'pending', t: null, reason: GRADING[inj.type].text, at: null };
    this.mark(`${TYPES[inj.type]}${inj.target ? ' · ' + inj.target : ''} fired${inj.g ? '' : ', no suitable aircraft'}`);
  }

  /* ---------------- per-inject grading ---------------- */
  /** Key event for the debrief timeline. */
  mark(text, cls = '') { this.timeline.push({ t: this.t, text, cls }); }

  gradeInjects() {
    for (const inj of this.scenario.injects) {
      if (!inj.result || inj.result.state !== 'pending') continue;
      const v = this.judge(inj);
      if (!v) continue;
      inj.result = { state: v.met ? 'met' : 'not met', t: v.t, reason: v.reason, at: this.t };
      this.mark(`${TYPES[inj.type]}${inj.target ? ' · ' + inj.target : ''}: ${inj.result.state} (${v.reason})`, v.met ? 'ok' : 'w');
    }
  }

  /** null while the objective is still open; otherwise { met, t (measured seconds or null), reason }. */
  judge(inj) {
    const L = GRADING[inj.type], g = inj.g, t0 = inj.firedAt, el = this.t - t0;
    const a = g.ac, gone = a ? !this.get(a.id) : false;
    const met = (t, reason) => ({ met: true, t, reason }), fail = (t, reason) => ({ met: false, t, reason });
    const stcaWith = x => this.stca.find(c => c.a === x || c.b === x);
    const other = (c, x) => (c.a === x ? c.b : c.a).cs;
    const clock = t => fmtT(t);
    const answered = (req, limit) => {
      if (req.answeredAt !== undefined) {
        const s = req.answeredAt - req.t;
        return s <= limit ? { ok: true, s } : fail(s, `answered after ${s} s, limit ${limit} s`);
      }
      if (this.t - req.t > limit) return fail(null, `not answered within ${limit} s`);
      return null;
    };
    switch (inj.type) {
      case 'LEVEL_BUST': {
        if (a.bustFixedAt !== undefined) { const s = a.bustFixedAt - t0; return s <= L.reclearS ? met(s, `re-cleared after ${s} s`) : fail(s, `re-cleared after ${s} s, limit ${L.reclearS} s`); }
        if (el > L.reclearS || gone) return fail(null, `not re-cleared within ${L.reclearS} s`);
        return null;
      }
      case 'CLIMB_REQUEST': {
        const r = answered(g.req, L.answerS);
        if (r && r.ok) return met(r.s, `answered after ${r.s} s`);
        if (r) return r;
        return gone ? fail(null, 'left frequency before an answer') : null;
      }
      case 'COORD_REQUEST': {
        const r = answered(g.req, L.answerS);
        if (r && !r.ok) return r;
        if (!r) return gone ? fail(null, 'left before an answer') : null;
        const leftAt = a.leftCfl ?? (gone ? Math.round(a.cfl) : null);
        if (leftAt === null) return null; // answered in time; waiting for it to leave
        return leftAt === a.xfl ? met(r.s, `answered after ${r.s} s, left at the agreed FL${fmtFL(a.xfl)}`) : fail(r.s, `left at FL${fmtFL(leftAt)}, agreed FL${fmtFL(a.xfl)}`);
      }
      case 'RADIO_FAILURE': {
        if (a.rcf > 0 && !gone) {
          const b = this.ac.find(x => x !== a && dist([x.x, x.y], [a.x, a.y]) < L.lateralNM && Math.abs(x.fl - a.fl) * 100 < L.verticalFt);
          if (b) return fail(el, `${b.cs} within ${dist([b.x, b.y], [a.x, a.y]).toFixed(1)} NM / ${Math.round(Math.abs(b.fl - a.fl) * 100)} ft at ${clock(this.t)}`);
          return null;
        }
        return met(el, `no traffic within ${L.lateralNM} NM / ${L.verticalFt} ft during ${el} s of silence`);
      }
      case 'EMERGENCY_DESCENT': {
        const ack = a.emgAckAt === undefined ? null : a.emgAckAt - t0;
        if (ack !== null && ack > L.ackS) return fail(ack, `acknowledged after ${ack} s, limit ${L.ackS} s`);
        if (ack === null && (el > L.ackS || gone)) return fail(null, `not acknowledged within ${L.ackS} s`);
        const c = gone ? null : stcaWith(a);
        if (c) return fail(ack, `STCA with ${other(c, a)} at FL${fmtFL(a.fl)}, ${clock(this.t)}`);
        if (ack !== null && (gone || a.fl <= L.untilFL + 0.5)) return met(ack, `acknowledged after ${ack} s, no STCA ${gone ? `until it left at FL${fmtFL(a.fl)}` : 'in the descent'}`);
        return null;
      }
      case 'WEATHER_CELL': {
        const cell = g.cell, dev = cell.selfDevs[0], miss = cell.missed[0];
        if (dev) return fail(dev.t - t0, `${dev.cs} deviated with its request unanswered, ${clock(dev.t)}`);
        if (miss) return fail(miss.t - t0, `${miss.cs} deviation request not answered, ${clock(miss.t)}`);
        if (el >= L.windowS) {
          const n = cell.answers.length, slow = n ? Math.max(...cell.answers) : null;
          return met(slow, n ? `${n} deviation request${n > 1 ? 's' : ''} answered, slowest ${slow} s` : 'no deviation requests to answer');
        }
        return null;
      }
      case 'MILITARY_TSA': {
        const z = g.zone;
        if (!z.active) return null;
        const since = this.t - z.at;
        const b = this.ac.find(x => dist([x.x, x.y], [z.x, z.y]) < z.r && x.fl >= L.minFL);
        if (b) return fail(since, `${b.cs} inside at FL${fmtFL(b.fl)}, ${since} s after activation`);
        if (since >= L.windowS) return met(since, `no aircraft inside for ${Math.round(L.windowS / 60)} min after activation`);
        return null;
      }
      case 'POPUP_TRAFFIC': {
        const c = gone ? null : stcaWith(a);
        if (c) return fail(el, `STCA with ${other(c, a)} after ${el} s`);
        if (el >= L.windowS || gone) return met(el, `no STCA in its first ${Math.round(L.windowS / 60)} min`);
        return null;
      }
      case 'LATE_TRANSFER': {
        const first = a.pendAt; // set when it enters and calls
        if (a.assumedAt !== undefined) {
          const s = first === null ? 0 : Math.max(0, a.assumedAt - first);
          return s <= L.assumeS ? met(s, first === null || a.assumedAt < first ? 'assumed before it entered' : `assumed after ${s} s`) : fail(s, `assumed after ${s} s, limit ${L.assumeS} s`);
        }
        if (first !== null && this.t - first > L.assumeS) return fail(null, `not assumed within ${L.assumeS} s of its first call`);
        if (gone) return fail(null, 'left before it was assumed');
        return null;
      }
    }
    return null;
  }

  /** Instructor: fire a pending (or held) inject immediately. */
  fireNow(index) {
    const inj = this.scenario.injects[index];
    if (!inj || (inj.status !== 'pending' && inj.status !== 'held')) return false;
    inj.min = Math.ceil(this.t / 60);
    this.fireInject(inj);
    return true;
  }
  /** Instructor: hold a pending inject (it will not fire on time) or release it. */
  holdInject(index, hold) {
    const inj = this.scenario.injects[index];
    if (!inj || inj.status === 'fired') return { ok: false, msg: 'Inject already fired' };
    inj.status = hold ? 'held' : 'pending';
    this.log(`Inject ${TYPES[inj.type]} ${hold ? 'held' : 'released'}`, '', 'i');
    return { ok: true };
  }
  /** Instructor: move an inject later (or earlier) by whole minutes, not before the next minute or past the session end. */
  delayInject(index, minutes) {
    const inj = this.scenario.injects[index];
    if (!inj || inj.status === 'fired') return { ok: false, msg: 'Inject already fired' };
    inj.min = Math.max(Math.ceil((this.t + 1) / 60), Math.min(this.scenario.duration - 1, inj.min + Math.round(minutes)));
    this.log(`Inject ${TYPES[inj.type]} moved to ${String(inj.min).padStart(2, '0')}:00`, '', 'i');
    return { ok: true };
  }
  /** Instructor: change an unfired inject's minute, type or instructor text. */
  editInject(index, { min, type, text } = {}) {
    const inj = this.scenario.injects[index];
    if (!inj || inj.status === 'fired') return { ok: false, msg: 'Inject already fired' };
    if (type !== undefined && !TYPES[type]) return { ok: false, msg: `Unknown inject type ${type}` };
    if (min !== undefined) {
      const m = Math.round(+min);
      if (!(m * 60 > this.t && m < this.scenario.duration)) return { ok: false, msg: `Minute must be after ${fmtT(this.t)} and before ${this.scenario.duration}:00` };
      inj.min = m;
    }
    if (type !== undefined) inj.type = type;
    if (text !== undefined) inj.text = String(text).slice(0, 160);
    this.log(`Inject edited: ${String(inj.min).padStart(2, '0')}:00 ${TYPES[inj.type]}`, '', 'i');
    return { ok: true };
  }

  /* ---------------- pseudo-pilot (instructor speaks as any aircraft) ---------------- */
  _pilot(id) { const a = this.get(id); return a ? { a } : { err: { ok: false, msg: 'No such aircraft' } }; }
  /** The pilot asks for something: climb/descend to an FL, a weather deviation in degrees (negative left), or a direct to a point. */
  pilotRequest(id, kind, value) {
    const { a, err } = this._pilot(id); if (err) return err;
    if (a.req) return { ok: false, msg: `${a.cs} already has an open request` };
    if (kind === 'climb' || kind === 'descend') {
      const fl = Math.round(+value / 10) * 10;
      if (!(fl >= 100 && fl <= 410)) return { ok: false, msg: 'Level must be FL100–FL410' };
      this.raiseRequest(a, kind, fl, `requests ${kind} FL${fmtFL(fl)}`);
    } else if (kind === 'wx') {
      const deg = Math.max(-60, Math.min(60, Math.round(+value)));
      if (!deg) return { ok: false, msg: 'Give a deviation in degrees' };
      this.raiseRequest(a, 'wx', deg, `requests ${Math.abs(deg)}° ${deg < 0 ? 'left' : 'right'} for weather`);
    } else if (kind === 'direct') {
      const key = String(value).trim().toUpperCase();
      if (!this.C.points[key] && !this.C.airports[key]) return { ok: false, msg: `Unknown point ${key}` };
      this.raiseRequest(a, 'direct', key, `requests direct ${key}`);
    } else return { ok: false, msg: `Unknown request ${kind}` };
    return { ok: true };
  }
  /** The pilot will refuse ('refuse') or query ('query') the next clearance once; null cancels. */
  pilotNextReply(id, mode) {
    const { a, err } = this._pilot(id); if (err) return err;
    if (mode !== null && mode !== 'refuse' && mode !== 'query') return { ok: false, msg: `Unknown reply ${mode}` };
    a.pilotNext = mode;
    this.log(mode ? `${a.cs} pilot will ${mode} the next clearance` : `${a.cs} pilot reply reset`, '', 'i');
    return { ok: true };
  }
  /** The pilot turns off track without a clearance, by deg (negative left). */
  pilotDeviate(id, deg) {
    const { a, err } = this._pilot(id); if (err) return err;
    const d = Math.max(-90, Math.min(90, Math.round(+deg)));
    if (!d) return { ok: false, msg: 'Give a deviation in degrees' };
    a.mode = 'hdg'; a.thdg = (a.hdg + d + 360) % 360; a.req = null;
    this.log(`${a.cs} deviating ${Math.abs(d)}° ${d < 0 ? 'left' : 'right'}, heading ${String(Math.round(a.thdg) || 360).padStart(3, '0')}`, 'w');
    return { ok: true };
  }
  /** The pilot selects another transponder code (four octal digits). */
  pilotSquawk(id, code) {
    const { a, err } = this._pilot(id); if (err) return err;
    const c = String(code).trim();
    if (!/^[0-7]{4}$/.test(c)) return { ok: false, msg: 'Squawk is four digits 0–7' };
    a.sq = c;
    this.log(`${a.cs} squawking ${c}`, '', 'i');
    return { ok: true };
  }
  /** The pilot stops answering for `seconds` (0 restores contact). The squawk does not change. */
  pilotSilent(id, seconds) {
    const { a, err } = this._pilot(id); if (err) return err;
    const s = Math.max(0, Math.round(+seconds));
    a.rcf = s ? this.t + s : 0;
    if (s) a.req = null;
    this.log(s ? `${a.cs} silent for ${s} s` : `${a.cs} back on frequency`, '', 'i');
    return { ok: true };
  }

  /* ---------------- clearances ----------------
     Each returns { ok, msg }. A radio-failure aircraft never reads back. */
  _cmd(id, what, fn) {
    const a = this.get(id);
    if (!a) return { ok: false, msg: 'Aircraft no longer on frequency' };
    if (!this.onFreq(a)) return { ok: false, msg: `${a.cs} is not on your frequency${a.ctl === 'xfer' ? ' (transferred)' : a.noXfer ? ' (not transferred to you yet)' : ''}` };
    if (a.rcf) { this.log(`${what} to ${a.cs} — no reply`, 'w'); return { ok: false, msg: `${a.cs}: no reply` }; }
    if (a.pilotNext) { // pseudo-pilot: refuse or query this clearance once
      const mode = a.pilotNext; a.pilotNext = null;
      if (mode === 'refuse') { this.log(`${a.cs} unable ${what}`, 'w'); return { ok: false, msg: `${a.cs}: unable ${what}` }; }
      this.log(`${a.cs} say again? (${what})`, 'w'); return { ok: false, msg: `${a.cs} asks you to say again` };
    }
    fn(a); this.stats.cmds++; this.log(`${a.cs} ${what}`);
    return { ok: true };
  }
  /** Take control of a flight transferred to us, or of one the previous sector failed to transfer (after coordination). */
  assume(id) {
    const a = this.get(id);
    if (!a) return { ok: false, msg: 'Aircraft no longer on frequency' };
    if (a.ctl === 'ass') return { ok: false, msg: `${a.cs} is already assumed` };
    if (a.ctl !== 'pend' && !a.noXfer) return { ok: false, msg: `${a.cs} has not been transferred to you` };
    a.ctl = 'ass'; a.noXfer = false; a.assumedAt = this.t;
    this.log(`${a.cs} assumed${a.lastIn ? '' : `, entering ${this.sector.name} in ${fmtT(a.tEntry || 0)}`}`);
    return { ok: true };
  }
  /** Hand an assumed flight to the next unit. The cleared level must be the agreed exit level. */
  transfer(id) {
    const a = this.get(id);
    if (!a) return { ok: false, msg: 'Aircraft no longer on frequency' };
    if (a.ctl !== 'ass') return { ok: false, msg: `${a.cs} is not assumed` };
    this.checkXfl(a);
    a.leftAt = this.t; a.leftCfl = Math.round(a.cfl);
    a.ctl = 'xfer'; this.stats.cmds++;
    this.log(`${a.cs} transferred${a.xfl !== null ? ` at FL${fmtFL(a.cfl)}` : ''}`);
    return { ok: true };
  }
  _closeReq(a, kinds) {
    if (a.req && kinds.includes(a.req.kind)) { this.stats.reqAnswered++; this.stats.reqTimeSum += this.t - a.req.t; a.req = null; return true; }
    return false;
  }
  clearLevel(id, fl) {
    const a = this.get(id); const dir = a && fl > a.fl ? 'climb' : 'descend';
    return this._cmd(id, `${dir} FL${fmtFL(fl)}`, a => { if (a.bust) a.bustFixedAt = this.t; a.cfl = fl; a.sfl = fl; a.bust = false; a.vr = null; this._closeReq(a, ['climb', 'descend']); });
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
    return this._cmd(id, `direct ${key}`, a => this._directTo(a, key, p.xy));
  }
  _directTo(a, key, xy) {
    const last = a.route[a.route.length - 1];
    a.route = key === last.id ? [last] : [{ id: key, xy }, last];
    a.ri = 0; a.mode = 'nav'; a.wxCleared = null;
  }
  speed(id, kt) {
    const v = Math.max(200, Math.min(350, Math.round(kt / 5) * 5));
    return this._cmd(id, `speed ${v} kt`, a => { a.spd = { mode: 'ias', v }; });
  }
  /** Mach clearance, up to the type's maximum operating Mach in the data. */
  mach(id, m) {
    const a = this.get(id), v = Math.round(+m * 100) / 100;
    if (!(v >= 0.6)) return { ok: false, msg: 'Mach from .60' };
    if (a && v > this.perfOf(a).cruise.maxMach.max) return { ok: false, msg: `${a.cs}: unable M.${String(Math.round(v * 100)).padStart(2, '0')}` };
    return this._cmd(id, `maintain M.${String(Math.round(v * 100)).padStart(2, '0')}`, a => { a.spd = { mode: 'mach', v }; });
  }
  resumeSpeed(id) { return this._cmd(id, 'resume normal speed', a => { a.spd = null; }); }
  /**
   * Rate clearance for the climb or descent in progress: kind 'min' ("at fpm or greater")
   * or 'max' ("at fpm or less"). Ends at the cleared level. Unable if the type cannot do it.
   */
  clearRate(id, fpm, kind = 'min') {
    const a = this.get(id), r = Math.round(+fpm / 100) * 100;
    if (!a) return { ok: false, msg: 'Aircraft no longer on frequency' };
    if (kind !== 'min' && kind !== 'max') return { ok: false, msg: 'Rate: or greater, or less' };
    if (!(r >= 500 && r <= 6000)) return { ok: false, msg: 'Rate 500–6000 ft/min' };
    if (Math.abs(a.sfl - a.fl) <= 0.5) return { ok: false, msg: `${a.cs} is not climbing or descending; clear a level first` };
    const up = a.sfl > a.fl, P = this.perfOf(a), ft = a.fl * 100;
    const band = up ? (ft < P.climb.casFromFt.opt ? P.climb.fpm.belowCas : ft < P.climb.machFromFt.opt ? P.climb.fpm.cas : P.climb.fpm.mach)
      : (ft > P.descent.machAboveFt.opt ? P.descent.fpm.mach : ft > P.descent.casAboveFt.opt ? P.descent.fpm.cas : P.descent.fpm.belowCas);
    if (kind === 'min' && r > band.max) return { ok: false, msg: `${a.cs}: unable ${r} ft/min` };
    return this._cmd(id, `${up ? 'climb' : 'descend'} at ${r} ft/min or ${kind === 'min' ? 'greater' : 'less'}`, a => { a.rate = { fpm: r, kind }; a.vr = null; });
  }
  resumeNav(id) { return this._cmd(id, 'resume own navigation', a => { a.mode = 'nav'; a.wxCleared = null; }); }
  answer(id, approve) {
    const a = this.get(id);
    if (!a || !a.req) return { ok: false, msg: 'No open request' };
    const r = a.req, coord = r.kind === 'coord'; // coordination is with the next sector, not with the aircraft
    if (!coord && !this.onFreq(a)) return { ok: false, msg: `${a.cs} is not on your frequency` };
    if (!coord && a.rcf) return { ok: false, msg: `${a.cs}: no reply` };
    this.stats.reqAnswered++; this.stats.reqTimeSum += this.t - r.t;
    r.answeredAt = this.t; r.approved = approve;
    if (r.cell) r.cell.answers.push(this.t - r.t);
    if (!coord) this.stats.cmds++;
    if (coord) {
      if (approve) { a.xfl = r.value; this.log(`${a.cs} exit level FL${fmtFL(r.value)} agreed with the next sector`); }
      else this.log(`${a.cs} exit level change refused, FL${fmtFL(a.xfl)} stands`);
    } else if (approve) {
      if (r.kind === 'climb' || r.kind === 'descend') { if (a.bust) a.bustFixedAt = this.t; a.cfl = r.value; a.sfl = r.value; a.bust = false; }
      if (r.kind === 'wx') { a.mode = 'hdg'; a.thdg = (a.hdg + r.value + 360) % 360; a.wxCleared = a.wxAsked; }
      if (r.kind === 'direct') { const p = this.C.points[r.value] || this.C.airports[r.value]; if (p) this._directTo(a, r.value, p.xy); }
      this.log(`${a.cs} ${r.kind === 'wx' ? 'deviation approved' : r.kind === 'direct' ? 'direct ' + r.value : (r.kind === 'climb' ? 'climb' : 'descend') + ' FL' + fmtFL(r.value)}`);
    } else this.log(`${a.cs} unable, ${r.text.replace('requests ', '')}`);
    a.req = null;
    return { ok: true };
  }
  ackEmergency(id) {
    const a = this.get(id);
    if (!a || !a.emg) return { ok: false, msg: 'No emergency' };
    a.emgAck = true;
    if (a.emgAckAt === undefined) { a.emgAckAt = this.t; this.mark(`Emergency acknowledged ${a.cs}`); }
    if (this.stats.emgAckT === null) this.stats.emgAckT = this.t;
    this.log(`${a.cs} emergency acknowledged, descent approved`);
    return { ok: true };
  }

  /* ---------------- read models for the UI ---------------- */
  priorities() {
    const items = [];
    for (const a of this.ac) {
      if (a.emg) items.push({ p: 1, ac: a, h: `${a.cs} emergency descent`, s: `Squawk 7700, descending FL${fmtFL(a.fl)} to FL100, diverting ${a.route[0] ? a.route[0].id : ''}${a.emgAck ? ' · acknowledged' : ''}`, act: a.emgAck ? null : 'ack' });
      if (a.rcf && a.sq === '7600') items.push({ p: 1, ac: a, h: `${a.cs} radio failure`, s: `Squawk 7600. Continues FL${fmtFL(a.cfl)} on own navigation. Separate others from it.` });
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
      // sector routine: assume what comes in, transfer what goes out at the agreed level
      if (a.lastIn && (a.ctl === 'pend' || (a.noXfer && a.ctl === 'none'))) {
        items.push({ p: 1, ac: a, h: a.noXfer ? `${a.cs} in sector without transfer` : `${a.cs} in sector, not assumed`, s: a.noXfer ? 'The previous sector has not transferred it. Coordinate, then assume.' : `FL${fmtFL(a.fl)}, from ${a.entry}. Assume it now.`, act: 'assume' });
      } else if ((a.ctl === 'pend' || a.noXfer) && a.tEntry !== null && a.tEntry <= ROUTINE.warnS) {
        items.push({ p: 3, ac: a, h: `${a.cs} pending, enters in ${fmtT(a.tEntry)}`, s: `FL${fmtFL(a.fl)}, from ${a.entry}. Assume on first call.`, act: 'assume' });
      }
      if (a.ctl === 'ass' && a.tExit !== null && a.tExit <= ROUTINE.warnS) {
        const atXfl = a.xfl === null || Math.round(a.cfl) === a.xfl;
        items.push({ p: atXfl ? 3 : 2, ac: a, h: `${a.cs} transfer, exits in ${fmtT(a.tExit)}`, s: a.xfl === null ? `FL${fmtFL(a.cfl)}, no agreed exit level` : atXfl ? `Cleared FL${fmtFL(a.cfl)}, the agreed exit level` : `Cleared FL${fmtFL(a.cfl)}, agreed exit FL${fmtFL(a.xfl)}. Re-clear before transfer.`, act: 'xfer' });
      }
      if (a.req) items.push({ p: a.req.kind === 'wx' || a.req.kind === 'coord' ? 2 : 3, ac: a, h: `${a.cs} ${a.req.text}`, s: `Waiting ${this.t - a.req.t} s`, act: 'req' });
      if (a.popupUntil > this.t) items.push({ p: 2, ac: a, h: `${a.cs} uncoordinated`, s: `Entering at FL${fmtFL(a.fl)}. Check conflicts and accept or turn.` });
    }
    const next = this.scenario.injects.find(i => i.status === 'pending');
    if (next && next.min * 60 - this.t < 120) items.push({ p: 3, h: `Inject in ${fmtT(next.min * 60 - this.t)}`, s: TYPES[next.type] + ' (instructor view)', instr: true });
    return items.sort((a, b) => a.p - b.p);
  }

  debrief() {
    const st = this.stats;
    return {
      ...st,
      avgResponse: st.reqAnswered ? Math.round(st.reqTimeSum / st.reqAnswered) : null,
      injectsFired: this.scenario.injects.filter(i => i.status === 'fired').length,
      injectsTotal: this.scenario.injects.length,
      injects: this.scenario.injects.map(i => ({ min: i.min, type: i.type, label: TYPES[i.type], target: i.target, status: i.status, firedAt: i.firedAt, objective: GRADING[i.type].text, result: i.result ? { ...i.result } : null })),
      timeline: this.timeline.map(e => ({ ...e }))
    };
  }
}
