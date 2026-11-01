// Simulation engine. No DOM access: the UI reads state from a Sim instance and
// calls its command methods. Time advances in fixed 1-second steps via step().
import { D2R, dist, brg, angDiff, segInt, mulberry32, moveToward, fmtFL, fmtT, pip, centroid } from './geo.js';
import { inSector } from './country.js';
import { machToTas, casToTas, tasToMach, windAt, normaliseWind } from './atmos.js';
import PERF from '../data/performance.json';
import { clam } from './nets/clam.js';
import { apw, APW } from './nets/apw.js';
import { ram } from './nets/ram.js';
import { mtcd, MTCD } from './nets/mtcd.js';
import { levelProbe } from './tools/probe.js';
import { parseCommand } from './cmdline.js';

export const TYPES = {
  CLIMB_REQUEST: 'Level request',
  LEVEL_BUST: 'Level bust',
  WEATHER_CELL: 'CB cell and deviations',
  RADIO_FAILURE: 'Radio failure (7600)',
  EMERGENCY_DESCENT: 'Emergency descent (7700)',
  MILITARY_TSA: 'Military area activation',
  POPUP_TRAFFIC: 'Unplanned traffic',
  COORD_REQUEST: 'Exit level coordination',
  LATE_TRANSFER: 'Late transfer from previous sector',
  READBACK_ERROR: 'Readback error',
  SIMILAR_CALLSIGN: 'Similar callsigns',
  COMLOSS: 'COMLOSS and QRA scramble',
  OAT_FORMATION: 'OAT formation crossing (non-RVSM)',
  TSA_EXTENSION: 'Short-notice military area extension'
};

export const DIFF = {
  foundational: { count: 7, conflicts: 1, label: 'Foundational' },
  intermediate: { count: 13, conflicts: 2, label: 'Intermediate' },
  advanced: { count: 20, conflicts: 4, label: 'Advanced' }
};

/** "FL280-FL350" for an area's vertical limits. */
export const areaBand = z => `FL${fmtFL(z.lower)}-FL${fmtFL(z.upper)}`;
const AREA_MAX_NM2 = 4000;
const polyArea = poly => Math.abs(poly.reduce((s, p, i) => { const q = poly[(i + 1) % poly.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
function distToSeg(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/**
 * Radio: every clearance is one transmission, read back by the pilot after readbackMinS-readbackMaxS
 * seconds. The frequency is busy from the clearance until the readback ends; a clearance given while
 * it is busy gets "say again". In the readback-error and similar-callsign injects the aircraft acts on
 * what it read back actS seconds after the readback, unless corrected first.
 */
/**
 * Civil-military injects (training constructs; data/<CODE>/military.json): COMLOSS is declared after
 * comlossS of silence, the military must be notified within notifyS, the QRA pair is airborne
 * scrambleS after the notification, joins the silent aircraft and stays joinedS before contact is
 * restored and it returns to base. OAT tracks are non-RVSM: 5 NM and 2000 ft from FL290 up
 * (1000 ft below). An OAT formation is pre-notified formationLeadS before it enters; a short-notice
 * extension takes effect extensionNoticeS after notice and lowers the area by extensionFL.
 */
export const CIVMIL = { comlossS: 300, notifyS: 120, scrambleS: 180, coordS: 60, joinNM: 2, joinedS: 180, formationLeadS: 180, extensionNoticeS: 120, extensionFL: 20, lateralNM: 5, verticalFt: 1000, nonRvsmFt: 2000, rvsmFromFL: 290 };
/** Vertical minimum (ft) between two tracks: 2000 ft from FL290 if either is non-RVSM (OAT), else 1000. */
export const vMin = (a, b) => ((a.oat && a.oat.nonRvsm) || (b.oat && b.oat.nonRvsm)) && Math.max(a.fl, b.fl) >= CIVMIL.rvsmFromFL ? CIVMIL.nonRvsmFt : CIVMIL.verticalFt;

export const RADIO = { readbackMinS: 2, readbackMaxS: 6, readbackS: 2, actS: 10 };

/** A callsign that sounds like cs: same operator, last two digits swapped (or the last one changed). */
export function similarCallsign(cs, used = new Set()) {
  const m = /^([A-Z]+)(\d*?)(\d)(\d)$/.exec(cs);
  if (!m) return null;
  const [, op, head, d1, d2] = m;
  const tries = [d1 !== d2 ? head + d2 + d1 : null, ...[1, 2, 3, 7, 8, 9].map(k => head + d1 + ((+d2 + k) % 10))].filter(Boolean);
  for (const t of tries) if (!/^0/.test(t) && !used.has(op + t)) return op + t;
  return null;
}

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
  MILITARY_TSA: { windowS: 600, text: 'None of your aircraft inside the active military area within its vertical limits (10 min after activation)' },
  POPUP_TRAFFIC: { windowS: 180, text: 'No STCA involving it in its first 3 min' },
  CLIMB_REQUEST: { answerS: 60, text: 'Answered within 60 s' },
  COORD_REQUEST: { answerS: 60, text: 'Answered within 60 s, and the aircraft leaves at the agreed level' },
  LATE_TRANSFER: { assumeS: 30, text: 'Assumed within 30 s of its first call' },
  READBACK_ERROR: { windowS: 600, text: 'Wrong readback corrected before the aircraft acts on it' },
  SIMILAR_CALLSIGN: { windowS: 600, text: 'Clearance taken by the wrong aircraft corrected before it acts on it' },
  COMLOSS: { windowS: 1500, text: 'Military notified within 2 min of COMLOSS, QRA coordination answered within 60 s, and your traffic kept 5 NM / 2000 ft (1000 ft below FL290) from the QRA' },
  OAT_FORMATION: { windowS: 1500, text: 'Coordination answered within 60 s, and your traffic kept 5 NM / 2000 ft (1000 ft below FL290) from the formation' },
  TSA_EXTENSION: { windowS: 600, text: 'None of your aircraft inside the extended area within its new limits (10 min after it takes effect)' }
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
    this.nets = { clam: new Map(), apw: new Map(), ram: new Map(), mtcd: [] };
    this.freq = { busyUntil: 0, cs: null }; this.radio = []; this.radioActs = []; this._tx = null;
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
    if (a.oat) return climbing ? a.oat.perf.climbFpm : a.oat.perf.descentFpm; // military.json, a training construct
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
    if (a.oat) return a.oat.phase === 'intercept' ? a.oat.perf.dashKt : a.oat.perf.tasKt;
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
    a.legFrom = a.legFrom || [a.x, a.y]; // start of the cleared leg, for route adherence
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
      rcf: 0, emg: false, emgAck: false, bust: false, req: null, wxCleared: null, wxAsked: null, atcHdg: false, legFrom: null,
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
      // climbing: B climbs 1000 ft/min from 3000 ft below A and passes A's level after 3 minutes, so it
      // only meets A at the crossing when that is 3-4 minutes ahead; later conflicts are level
      const P = [ia[0], ia[1]], L = a.fl, jitter = 1 + (this.rng() - 0.5) * 0.06, climbing = this.rng() < 0.5 && minutesAhead <= 4;
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
    this.radioRng = mulberry32(scenario.seed * 104729 + 17); // readback timing: its own stream, so clearances do not change the traffic
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
        if (w) { tgtH = this.headingFor(brg([a.x, a.y], w.xy), a.tas, a.fl); if (dist([a.x, a.y], w.xy) < 2.5) { a.ri++; a.legFrom = w.xy; } }
      } else tgtH = a.thdg; // a heading clearance holds the heading; the wind makes the track drift
      // automatically resume own navigation once clear of a weather cell
      if (a.wxCleared && a.mode === 'hdg') {
        const cell = a.wxCleared, w = a.route[a.ri];
        if (w && dist([a.x, a.y], [cell.x, cell.y]) > cell.r + 12) {
          const toW = brg([a.x, a.y], w.xy), toC = brg([a.x, a.y], [cell.x, cell.y]);
          if (Math.abs(angDiff(toW, toC)) > 70) { a.mode = 'nav'; a.wxCleared = null; a.atcHdg = false; a.legFrom = [a.x, a.y]; this.log(`${a.cs} clear of weather, resuming own navigation`); }
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
      if (a.oat) { this.oatStep(a); continue; } // military traffic: not in the civil sector routine
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
        const inZ = this.inArea(a, z) && this.ours(a);
        if (inZ && !a.inTsa) { this.stats.tsaInf++; this.log(`${a.cs} inside active ${z.id}`, 'a'); }
        a.inTsa = inZ ? z : null;
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
    if (this.spawnTimer <= 0 && this.ac.filter(a => !a.oat).length < this.target) {
      const p = this.planFlight({ mustCross: this.rng() < 0.7 ? sec : null });
      if (p && this.clearToSpawn(p, 0)) this.spawnFromPlan(p, 0);
      this.spawnTimer = 25 + Math.floor(this.rng() * 50);
    }
    for (const c of this.wx) { c.x += c.vx; c.y += c.vy; }
    for (const z of this.tsa) if (!z.active && this.t >= z.at) { z.active = true; this.log(`${z.id} now active ${areaBand(z)}`, 'a'); this.mark(`${z.id} active`); }
    if (this.t % RADAR_REFRESH_S === 0) {
      for (const a of this.ac) { a.plots.push([a.px, a.py]); if (a.plots.length > 6) a.plots.shift(); a.px = a.x; a.py = a.y; }
    }
    this.radioStep();
    this.civmilStep();
    this.stcaScan();
    this.netsScan();
    this.gradeInjects();
    for (const inj of this.scenario.injects) if (inj.status === 'pending' && this.t >= inj.min * 60) this.fireInject(inj);
    if (this.t % 5 === 0) this.computeInbound();
    if (this.t >= this.scenario.duration * 60) this.ended = true;
  }

  stcaScan() {
    const res = [], now = new Set(), A = this.ac, { lateralNM, lookaheadS } = SEPARATION;
    const profiles = new Map(), profile = a => { if (!profiles.has(a)) profiles.set(a, this.levelProfile(a)); return profiles.get(a); };
    for (let i = 0; i < A.length; i++) for (let j = i + 1; j < A.length; j++) {
      const a = A[i], b = A[j];
      if (a.fl < 100 || b.fl < 100) continue;
      if ((a.oat && b.oat) || (a.oat && a.oat.target === b) || (b.oat && b.oat.target === a)) continue; // a formation, or an intercept
      const vmin = vMin(a, b);
      const dh = dist([a.x, a.y], [b.x, b.y]);
      if (dh > 60) continue;
      const dv = Math.abs(a.fl - b.fl) * 100;
      const key = a.id < b.id ? `${a.id}-${b.id}` : `${b.id}-${a.id}`;
      if (dh < lateralNM && dv < vmin) {
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
        if (dist(pa, pb) < lateralNM && Math.abs(fa - fb) * 100 < vmin) { res.push({ a, b, dh, dv, level: 'pred', tt: t, key }); break; }
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
      if (a.oat) continue;
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
        tgt.route = [{ id: best.id, xy: best.xy }]; tgt.ri = 0; tgt.mode = 'nav'; tgt.atcHdg = false; tgt.legFrom = [tgt.x, tgt.y]; tgt.spd = { mode: 'ias', v: 320 };
        this.log(`MAYDAY ${tgt.cs} emergency descent FL100, diverting ${best.id}`, 'a'); break;
      }
      case 'MILITARY_TSA': {
        // a real ENR 5.2 area (data/<CODE>/areas.json): one over the sector, else the nearest within 30 NM
        const area = this.pickArea();
        if (!area) break;
        const zone = { ...area, at: this.t + 300, active: false };
        this.tsa.push(zone); inj.g = { zone }; inj.target = area.id;
        this.log(`Military area ${area.id}${area.name ? ' (' + area.name + ')' : ''} active in 5 min, ${areaBand(area)}`, 'w'); break;
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
    if (inj.type === 'COMLOSS') {
      // silent, transponder normal: on radar it looks like any other flight until COMLOSS is declared
      const a = tgt && this.get(tgt.id);
      if (a) {
        a.rcf = this.t + 99999; a.req = null; a.comloss = { inj };
        inj.target = a.cs; inj.g = { ac: a, declareAt: this.t + CIVMIL.comlossS };
        this.log(`Inject: ${a.cs} goes silent (no 7600); COMLOSS in ${fmtT(CIVMIL.comlossS)}`, 'w', 'i');
      }
    }
    if (inj.type === 'OAT_FORMATION' && this.C.military) {
      const M = this.C.military, perf = M.aircraft[M.formation.aircraft];
      // a straight crossing through the sector, entering about formationLeadS from now
      const c = sec.c || centroid(sec.polys[0]), h = this.rng() * 360, d = [Math.sin(h * D2R), -Math.cos(h * D2R)];
      let k = 0; while (k < 400 && inSector([c[0] - d[0] * k, c[1] - d[1] * k], sec)) k++;
      const lead = perf.tasKt * CIVMIL.formationLeadS / 3600, start = [c[0] - d[0] * (k + lead), c[1] - d[1] * (k + lead)];
      let e = 0; while (e < 400 && inSector([c[0] + d[0] * e, c[1] + d[1] * e], sec)) e++;
      const end = [c[0] + d[0] * (e + 40), c[1] + d[1] * (e + 40)];
      const fl = [300, 320, 340, 360][Math.floor(this.rng() * 4)];
      const f = this.makeOat({ kind: 'formation', cs: `${M.formation.callsign}${41 + Math.floor(this.rng() * 50)}`, type: M.formation.aircraft, n: M.formation.n, xy: start, fl, sfl: fl, route: [{ id: 'MIL', xy: end }] });
      this.raiseRequest(f, 'mil', null, `(MIL) formation of ${M.formation.n}, non-RVSM, crossing ${sec.name} at FL${fmtFL(fl)} in about ${Math.round(CIVMIL.formationLeadS / 60)} min. Acknowledge.`);
      inj.target = f.cs; inj.g = { ac: f, req: f.req };
    }
    if (inj.type === 'TSA_EXTENSION') {
      // extend the latest military area down by extensionFL at short notice; with none, activate one at short notice
      const z = [...this.tsa].reverse().find(q => !q.ext) || this.pickArea();
      if (z) {
        const ext = { ...z, ext: true, active: false, at: this.t + CIVMIL.extensionNoticeS, lower: Math.max(0, z.lower - (this.tsa.includes(z) ? CIVMIL.extensionFL : 0)) };
        if (this.tsa.includes(z)) ext.name = `${z.id} extended`;
        this.tsa.push(ext); inj.g = { zone: ext }; inj.target = z.id;
        this.log(`Short notice: military area ${z.id} ${this.tsa.includes(z) ? 'extended to ' : 'active, '}${areaBand(ext)} in ${fmtT(CIVMIL.extensionNoticeS)}`, 'w');
      }
    }
    if (inj.type === 'READBACK_ERROR') {
      // armed: the next level or heading clearance to one of your aircraft is read back wrong
      inj.g = { armed: true }; inj.target = 'next level or heading clearance';
      this.log('Inject: the next level or heading clearance will be read back wrong', 'w', 'i');
    }
    if (inj.type === 'SIMILAR_CALLSIGN') {
      const cand = this.ac.filter(a => a.ctl === 'ass' && a.lastIn && !a.emg && !a.rcf && /\d\d$/.test(a.cs));
      const a = cand[Math.floor(this.rng() * cand.length)];
      const cs = a && similarCallsign(a.cs, this.csUsed);
      const p = cs && this.planFlight({ mustCross: sec });
      if (p) {
        this.csUsed.add(cs);
        const b = this.spawnFromPlan({ ...p, cs }, 0);
        for (let k = 0; k < 400 && !inSector([b.x, b.y], sec); k++) { // walk it in, just inside the boundary
          b.x += Math.sin(b.hdg * D2R); b.y -= Math.cos(b.hdg * D2R); b.hdg = brg([b.x, b.y], b.route[0].xy);
        }
        b.px = b.x; b.py = b.y; b.lastIn = b.everIn = b.wasOurs = true; b.ctl = 'pend'; b.pendAt = this.t;
        inj.target = `${a.cs} / ${b.cs}`; inj.g = { armed: true, pair: [a, b] };
        this.log(`${b.cs} calling, FL${fmtFL(b.fl)}`);
      }
    }
    if (!inj.target) this.log(`Inject ${TYPES[inj.type]}: ${inj.type === 'OAT_FORMATION' && !this.C.military ? 'no military data for this country' : inj.type === 'MILITARY_TSA' || inj.type === 'TSA_EXTENSION' ? 'no military area over or near the sector' : 'no suitable aircraft in sector'}`, 'w', 'i');
    // graded only when the inject found something to act on
    if (inj.g) inj.result = { state: 'pending', t: null, reason: GRADING[inj.type].text, at: null };
    this.mark(`${TYPES[inj.type]}${inj.target ? ' · ' + inj.target : ''} fired${inj.g ? '' : ', no suitable aircraft'}`);
  }

  /* ---------------- safety nets and monitoring aids (src/nets) ---------------- */
  /**
   * Predicted points every stepS seconds up to maxS: position along the flight's own path
   * (lookAhead: route legs in own navigation, heading when vectored) and level from flAfter,
   * the same models STCA uses. Stops where the flight leaves en-route control.
   */
  trajectory(a, maxS, stepS) {
    const out = [];
    let fl = a.fl;
    this.lookAhead(a, maxS, stepS, (s, xy) => { fl = this.flAfter(a, stepS, fl); out.push({ t: s, xy, fl }); return false; });
    return out;
  }
  /**
   * CLAM, RAM and APW every second for your traffic. MTCD every 10 s over all flights (it works from
   * planned trajectories, like flight plans): a pair is listed when one of them is yours or the
   * conflict is inside the training sector.
   */
  netsScan() {
    const N = this.nets, active = this.tsa.filter(z => z.active);
    N.clam.clear(); N.ram.clear(); N.apw.clear();
    for (const a of this.ac) {
      if (!this.ours(a)) continue;
      const c = clam(a); if (c) N.clam.set(a.id, c);
      const w = a.route[a.ri];
      const r = ram({ xy: [a.x, a.y], legFrom: a.legFrom, legTo: w && w.xy, atcHeading: a.mode === 'hdg' && a.atcHdg });
      if (r) N.ram.set(a.id, r);
      if (active.length) { const p = apw({ xy: [a.x, a.y], fl: a.fl }, this.trajectory(a, APW.lookaheadS, APW.stepS), active); if (p) N.apw.set(a.id, p); }
    }
    if (this.t % 10 === 0) {
      const flights = this.ac.filter(a => a.fl >= 100).map(ac => ({ ac, traj: this.trajectory(ac, MTCD.lookaheadS, MTCD.stepS) }));
      N.mtcd = mtcd(flights).filter(c => this.ours(c.a) || this.ours(c.b) || inSector(c.xy, this.sector)).map(c => ({ a: c.a.id, b: c.b.id, acs: c.a.cs, bcs: c.b.cs, t: c.t, tMin: c.tMin, minNM: c.minNM, dvFt: c.dvFt }));
    }
  }

  /**
   * What-if level probe: the flight's path as if cleared to fl now, against every other flight's
   * planned path (20 min, as MTCD) and the military areas, active or due. Read-only.
   */
  probeLevel(id, fl) {
    const a = this.get(id);
    if (!a) return { ok: false, msg: 'Aircraft no longer on frequency' };
    fl = Math.round(+fl);
    if (!(fl >= 100 && fl <= 450)) return { ok: false, msg: 'Probe a level from FL100 to FL450' };
    const what = { ...a, cfl: fl, sfl: fl, vr: null };
    const traj = this.trajectory(what, MTCD.lookaheadS, MTCD.stepS);
    const others = this.ac.filter(x => x !== a && x.fl >= 100).map(x => ({ cs: x.cs, traj: this.trajectory(x, MTCD.lookaheadS, MTCD.stepS) }));
    const areas = this.tsa.map(z => ({ ...z, from: Math.max(0, z.at - this.t) }));
    const r = levelProbe(traj, others, areas);
    return { ok: true, id, fl, conflicts: r.conflicts.map(c => ({ ...c, minNM: Math.round(c.minNM * 10) / 10 })), areas: r.areas };
  }

  /* ---------------- military areas (ENR 5.2) ---------------- */
  /** Aircraft the trainee is responsible for: assumed, or pending (about to be). */
  ours(a) { return a.ctl === 'ass' || a.ctl === 'pend'; }
  /** Inside the area laterally and within its vertical limits (inclusive). */
  inArea(a, z) { return a.fl >= z.lower && a.fl <= z.upper && pip([a.x, a.y], z.poly); }
  /** Within its vertical limits and inside or within nm of it laterally. */
  nearArea(a, z, nm) {
    if (a.fl < z.lower || a.fl > z.upper) return false;
    if (pip([a.x, a.y], z.poly)) return true;
    return z.poly.some((p, i) => distToSeg([a.x, a.y], p, z.poly[(i + 1) % z.poly.length]) < nm);
  }
  /**
   * The area the MILITARY_TSA inject activates: one reaching cruise levels (band overlapping
   * FL245-FL410) over the training sector, or else the nearest within 30 NM. Among those, a
   * workable exercise: an area of at most AREA_MAX_NM2 where possible, about two of your aircraft
   * affected, then the smallest. No rng, so seeds stay reproducible.
   */
  pickArea() {
    const sec = this.sector, cruise = this.C.areas.filter(z => z.upper !== null && z.lower !== null && z.upper > 245 && z.lower < 410);
    const gap = z => {
      if (z.poly.some(p => inSector(p, sec)) || sec.polys.some(poly => poly.some(p => pip(p, z.poly)))) return 0;
      let d = Infinity;
      for (const poly of sec.polys) for (const p of poly) for (let i = 0; i < z.poly.length; i++) d = Math.min(d, distToSeg(p, z.poly[i], z.poly[(i + 1) % z.poly.length]));
      return d;
    };
    const scored = cruise.map(z => ({ z, gap: gap(z), size: polyArea(z.poly), n: this.ac.filter(a => (this.ours(a) || a.inbound) && this.nearArea(a, z, 10)).length }))
      .filter(c => c.gap <= 30)
      .sort((p, q) => (p.gap > 0) - (q.gap > 0) || (p.gap > 0 && p.gap - q.gap) || (p.size > AREA_MAX_NM2) - (q.size > AREA_MAX_NM2)
        || (p.n === 0) - (q.n === 0) || Math.abs(p.n - 2) - Math.abs(q.n - 2) || p.size - q.size || p.z.id.localeCompare(q.z.id));
    return scored.length ? scored[0].z : null;
  }

  /* ---------------- per-inject grading ---------------- */
  /** Key event for the debrief timeline. */
  mark(text, cls = '') { this.timeline.push({ t: this.t, text, cls }); }

  gradeInjects() {
    for (const inj of this.scenario.injects) {
      if (!inj.result || inj.result.state !== 'pending') continue;
      const v = this.judge(inj);
      if (!v) continue;
      if (v.none) { inj.result = null; this.mark(`${TYPES[inj.type]}: not graded (${v.reason})`); continue; }
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
      case 'MILITARY_TSA':
      case 'TSA_EXTENSION': {
        const z = g.zone;
        if (!z.active) return null;
        const since = this.t - z.at;
        const b = this.ac.find(x => this.ours(x) && this.inArea(x, z));
        if (b) return fail(since, `${b.cs} inside ${z.id} at FL${fmtFL(b.fl)}, ${since} s after activation`);
        if (since >= L.windowS) return met(since, `no aircraft inside for ${Math.round(L.windowS / 60)} min after activation`);
        return null;
      }
      case 'POPUP_TRAFFIC': {
        const c = gone ? null : stcaWith(a);
        if (c) return fail(el, `STCA with ${other(c, a)} after ${el} s`);
        if (el >= L.windowS || gone) return met(el, `no STCA in its first ${Math.round(L.windowS / 60)} min`);
        return null;
      }
      case 'COMLOSS': {
        if (!g.declared) return gone ? { none: true, reason: `${a.cs} left before COMLOSS was declared` } : null;
        const late = (g.notifiedAt ?? this.t) - g.declared;
        if (late > CIVMIL.notifyS) return fail(g.notifiedAt === undefined ? null : late, g.notifiedAt === undefined ? `military not notified within ${CIVMIL.notifyS / 60} min of COMLOSS` : `military notified ${late} s after COMLOSS, limit ${CIVMIL.notifyS} s`);
        if (g.notifiedAt === undefined) return null;
        const q = g.qra;
        if (!q) return this.C.military ? null : met(Math.max(0, late), `military notified ${Math.max(0, late)} s after COMLOSS (no QRA base configured)`);
        const r = answered(g.req, CIVMIL.coordS);
        if (r && !r.ok) return { ...r, reason: `QRA coordination: ${r.reason}` };
        const c = this.oatConflict(q);
        if (c) return fail(Math.max(0, late), `${c.cs} within ${dist([c.x, c.y], [q.x, q.y]).toFixed(1)} NM / ${Math.round(Math.abs(c.fl - q.fl) * 100)} ft of ${q.cs} (OAT)`);
        if (!this.get(q.id) || el > L.windowS) return r ? met(Math.max(0, late), `military notified ${Math.max(0, late)} s after COMLOSS, coordination answered after ${r.s} s, separation from ${q.cs} kept`) : fail(null, 'QRA coordination not answered');
        return null;
      }
      case 'OAT_FORMATION': {
        const r = answered(g.req, CIVMIL.coordS);
        if (r && !r.ok) return { ...r, reason: `coordination: ${r.reason}` };
        const c = this.oatConflict(a);
        if (c) return fail(el, `${c.cs} within ${dist([c.x, c.y], [a.x, a.y]).toFixed(1)} NM / ${Math.round(Math.abs(c.fl - a.fl) * 100)} ft of ${a.cs} (OAT, non-RVSM)`);
        if (gone || el > L.windowS) return r ? met(r.s, `coordination answered after ${r.s} s, separation from ${a.cs} kept`) : fail(null, 'coordination not answered');
        return null;
      }
      case 'READBACK_ERROR':
      case 'SIMILAR_CALLSIGN': {
        const who = inj.type === 'READBACK_ERROR' ? 'the wrong readback' : `${g.ac ? g.ac.cs : ''} taking ${g.meant ? g.meant.cs : 'the other'}'s clearance`;
        if (g.correctedAt !== undefined) return met(g.rbAt === undefined ? 0 : Math.max(0, g.correctedAt - g.rbAt), `corrected ${g.rbAt === undefined || g.correctedAt < g.rbAt ? 'before the readback' : `${g.correctedAt - g.rbAt} s after the readback`}`);
        if (g.actedAt !== undefined) return fail(g.actedAt - g.rbAt, `${g.ac.cs} acted on ${who} (${g.wrong || g.right}) after ${g.actedAt - g.rbAt} s, not corrected`);
        if (g.armed && el > L.windowS) return { none: true, reason: `no clearance to trigger it in ${Math.round(L.windowS / 60)} min` };
        if (g.ac && !this.get(g.ac.id) && g.actAt === undefined) return { none: true, reason: `${g.ac.cs} left before the readback` };
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
  _cmd(id, what, fn, alt = null) {
    const a = this.get(id);
    if (!a) return { ok: false, msg: 'Aircraft no longer on frequency' };
    if (a.oat) return { ok: false, msg: `${a.cs} is OAT under military control` };
    if (!this.onFreq(a)) return { ok: false, msg: `${a.cs} is not on your frequency${a.ctl === 'xfer' ? ' (transferred)' : a.noXfer ? ' (not transferred to you yet)' : ''}` };
    if (!this._tx && this.freqBusy()) return this.sayAgain(a);
    if (a.rcf) { this.log(`${what} to ${a.cs} — no reply`, 'w'); return { ok: false, msg: `${a.cs}: no reply` }; }
    if (a.pilotNext) { // pseudo-pilot: refuse or query this clearance once
      const mode = a.pilotNext; a.pilotNext = null;
      if (mode === 'refuse') { this.log(`${a.cs} unable ${what}`, 'w'); return { ok: false, msg: `${a.cs}: unable ${what}` }; }
      this.log(`${a.cs} say again? (${what})`, 'w'); return { ok: false, msg: `${a.cs} asks you to say again` };
    }
    this.stats.cmds++; this.log(`${a.cs} ${what}`);
    // a correction cancels what this aircraft was about to do on a wrong readback
    for (const p of this.radioActs) if (p.a === a && !p.done && (p.kind === 'any' || p.kind === (alt && alt.kind))) { p.done = true; p.inj.g.correctedAt = this.t; this.mark(`${a.cs} corrected`, 'ok'); }
    const trap = this.radioTrap(a, alt, what, fn);
    if (trap) { this.queueReadback(trap.who, trap.what, trap.act); return { ok: true }; }
    fn(a);
    this.queueReadback(a, what);
    return { ok: true };
  }

  /* ---------------- civil-military (training constructs) ---------------- */
  /** A military track: flown by oatStep, never cleared by the trainee, separated from with vMin. */
  makeOat({ kind, cs, type, n, xy, fl, sfl, route }) {
    const perf = this.C.military.aircraft[type];
    const a = this.makeAircraft({ cs, type, cat: 'oat', x: xy[0], y: xy[1], fl, cfl: sfl, sfl, rfl: sfl, route, entry: 'MIL', exit: 'MIL' });
    a.ctl = 'mil'; a.oat = { kind, n, nonRvsm: perf.nonRvsm, perf, phase: kind === 'qra' ? 'intercept' : 'cross', target: null };
    this.initKinematics(a);
    a.hdg = route[0] ? brg(xy, route[0].xy) : 0;
    this.ac.push(a);
    return a;
  }
  /** Notify the military of a COMLOSS (a controller action, from either window). */
  notifyMil(id) {
    const a = this.get(id);
    if (!a) return { ok: false, msg: 'Aircraft no longer on the display' };
    if (!a.comloss) return { ok: false, msg: `${a.cs} is in contact: nothing to notify` };
    const g = a.comloss.inj.g;
    if (g.notifiedAt !== undefined) return { ok: false, msg: `Military already notified about ${a.cs}` };
    g.notifiedAt = this.t;
    this.log(`Military notified: ${a.cs} COMLOSS, FL${fmtFL(a.fl)}`);
    this.mark(`Military notified about ${a.cs}`, 'ok');
    if (!this.C.military) this.log('No QRA base configured for this country: no scramble', 'w', 'i');
    return { ok: true };
  }
  civmilStep() {
    for (const inj of this.scenario.injects) {
      if (inj.status !== 'fired' || !inj.g || inj.type !== 'COMLOSS') continue;
      const g = inj.g, a = g.ac;
      if (!g.declared && this.t >= g.declareAt && this.get(a.id) && a.rcf) {
        g.declared = this.t; a.comloss.declared = true;
        this.log(`COMLOSS ${a.cs}: no contact for ${Math.round(CIVMIL.comlossS / 60)} min, FL${fmtFL(a.fl)}. Notify the military.`, 'a');
        this.mark(`COMLOSS ${a.cs} declared`, 'a');
      }
      if (g.notifiedAt !== undefined && !g.qra && this.C.military && this.t >= g.notifiedAt + CIVMIL.scrambleS && this.get(a.id)) {
        const M = this.C.military, base = M.qra.reduce((m, q) => (dist(q.xy, [a.x, a.y]) < dist(m.xy, [a.x, a.y]) ? q : m), M.qra[0]);
        const q = this.makeOat({ kind: 'qra', cs: `${base.callsign}${11 + Math.floor(this.rng() * 80)}`, type: base.aircraft, n: 2, xy: base.xy, fl: 50, sfl: Math.round(a.fl), route: [{ id: a.cs, xy: [a.x, a.y] }] });
        q.oat.target = a; q.oat.base = base;
        this.raiseRequest(q, 'mil', null, `(MIL) QRA pair airborne from ${base.id}, climbing FL${fmtFL(Math.round(a.fl))} through your airspace to intercept ${a.cs}. Acknowledge.`);
        g.qra = q; g.req = q.req;
        this.mark(`QRA ${q.cs} airborne from ${base.id}`, 'w');
      }
    }
  }
  /** One second of a military track (after the shared motion step). */
  oatStep(a) {
    const o = a.oat, tgt = o.target && this.get(o.target.id) ? o.target : null;
    // an unanswered military call lapses like any request (the grading has already counted it)
    if (a.req && this.t - a.req.t > REQUEST_TIMEOUT_S) { this.stats.reqMissed++; this.log(`${a.cs} ${a.req.text.replace(/ Acknowledge\.$/, '')}: no answer`, 'w'); a.req = null; }
    if (o.kind === 'qra') {
      if (o.phase === 'intercept') {
        if (!tgt) { this.rtb(a); return; }
        a.route = [{ id: tgt.cs, xy: [tgt.x, tgt.y] }]; a.ri = 0; a.sfl = a.cfl = Math.round(tgt.fl);
        if (dist([a.x, a.y], [tgt.x, tgt.y]) < CIVMIL.joinNM && Math.abs(a.fl - tgt.fl) < 10) {
          o.phase = 'joined'; o.joinedAt = this.t;
          this.log(`${a.cs} (MIL) joined ${tgt.cs}`, 'w');
        }
      } else if (o.phase === 'joined') {
        if (!tgt) { this.rtb(a); return; }
        a.x = tgt.x + 0.8; a.y = tgt.y + 0.8; a.fl = a.sfl = a.cfl = tgt.fl; a.hdg = tgt.hdg; // flying in company
        if (this.t - o.joinedAt >= CIVMIL.joinedS) {
          tgt.rcf = this.t + 1; delete tgt.comloss;
          this.rtb(a);
        }
      } else if (dist([a.x, a.y], o.base.xy) < 5) a.done = 'mil';
    } else if (a.ri >= a.route.length) a.done = 'mil';
    if (Math.abs(a.x) > 420 || Math.abs(a.y) > 300) a.done = 'mil';
    if (a.done) this.log(`${a.cs} (MIL) left your area`);
  }
  rtb(a) {
    a.oat.phase = 'rtb'; a.oat.target = null;
    const b = a.oat.base;
    a.route = [{ id: b.id, xy: b.xy }]; a.ri = 0; a.sfl = a.cfl = 100;
    this.log(`${a.cs} (MIL) returning to ${b.id}`);
  }
  /** One of your aircraft too close to an OAT track (not the one it intercepts), or null. */
  oatConflict(o) {
    if (!this.get(o.id)) return null;
    return this.ac.find(x => this.ours(x) && x !== o.oat.target && !x.oat && dist([x.x, x.y], [o.x, o.y]) < CIVMIL.lateralNM && Math.abs(x.fl - o.fl) * 100 < vMin(x, o)) || null;
  }

  /* ---------------- radio ---------------- */
  freqBusy() { return this.t < this.freq.busyUntil; }
  sayAgain(a) { this.log(`${a.cs} say again`, 'w'); return { ok: false, msg: `Frequency busy: ${a.cs} say again` }; }
  /**
   * The pilot's readback: logged readbackMinS-readbackMaxS s later; the frequency is busy until it ends.
   * Inside transmit() the parts of one transmission are collected and read back together.
   * act: { apply, kind, inj } makes the aircraft act on the readback RADIO.actS s after it.
   */
  queueReadback(a, what, act = null) {
    if (this._tx) { this._tx.push({ a, what, act }); return; }
    const at = this.t + RADIO.readbackMinS + Math.floor(this.radioRng() * (RADIO.readbackMaxS - RADIO.readbackMinS + 1));
    this.radio.push({ at, a, text: `${what}, ${a.cs}`, act });
    this.freq = { busyUntil: at + RADIO.readbackS, cs: a.cs };
  }
  /** One transmission with several clearances to one aircraft, read back together. */
  transmit(id, actions) {
    const a = this.get(id);
    if (!a) return { ok: false, msg: 'Aircraft no longer on frequency' };
    if (this.freqBusy()) return this.sayAgain(a);
    this._tx = [];
    let res = { ok: true };
    try {
      for (const { cmd, args } of actions) {
        if (!this[cmd] || !['clearLevel', 'turn', 'direct', 'speed', 'mach', 'clearRate'].includes(cmd)) { res = { ok: false, msg: `Unknown clearance ${cmd}` }; break; }
        const r = this[cmd](id, ...args);
        if (!r.ok) { res = r; break; }
      }
    } finally {
      const parts = this._tx; this._tx = null;
      if (parts.length) {
        const who = parts[0].a, act = parts.find(p => p.act);
        this.queueReadback(who, parts.filter(p => p.a === who).map(p => p.what).join(', '), act ? act.act : null);
      }
    }
    return res;
  }
  /** A command line in controller shorthand ("ROT123 370 H120"), as one transmission. */
  command(text) {
    const p = parseCommand(text, this.ac.map(a => a.cs));
    if (!p.ok) return { ok: false, msg: p.error };
    return this.transmit(this.ac.find(a => a.cs.toUpperCase() === p.cs).id, p.actions);
  }
  radioStep() {
    for (const r of this.radio) if (!r.done && this.t >= r.at) {
      r.done = true;
      this.log(r.text, 'p');
      if (r.act) { const p = { ...r.act, a: r.a, at: this.t + RADIO.actS }; r.act.inj.g.rbAt = this.t; r.act.inj.g.actAt = p.at; this.radioActs.push(p); }
    }
    this.radio = this.radio.filter(r => !r.done);
    for (const p of this.radioActs) if (!p.done && this.t >= p.at) {
      p.done = true;
      if (this.get(p.a.id)) { p.apply(p.a); p.inj.g.actedAt = this.t; this.mark(`${p.a.cs} acted on ${p.what}`, 'w'); }
    }
    this.radioActs = this.radioActs.filter(p => !p.done);
  }
  /**
   * Inject hooks on a clearance: a wrong readback (READBACK_ERROR, level or heading) or the clearance
   * taken by the similar callsign (SIMILAR_CALLSIGN). Returns who reads back what, and what they will do.
   */
  radioTrap(a, alt, what, fn) {
    const inj = this.scenario.injects.find(i => i.status === 'fired' && i.g && i.g.armed && (i.type === 'READBACK_ERROR' ? alt && this.ours(a) : i.g.pair && i.g.pair.includes(a)));
    if (!inj) return null;
    const g = inj.g;
    if (inj.type === 'READBACK_ERROR') {
      const wrong = alt.wrong(this.radioRng() < 0.5 ? -1 : 1);
      g.armed = false; g.ac = a; inj.target = a.cs; g.kind = alt.kind; g.right = alt.what; g.wrong = wrong.what;
      return { who: a, what: wrong.what, act: { kind: alt.kind, inj, what: wrong.what, apply: wrong.apply } };
    }
    const other = g.pair[0] === a ? g.pair[1] : g.pair[0];
    if (!this.get(other.id) || !this.onFreq(other)) return null;
    g.armed = false; g.ac = other; g.meant = a; g.right = what;
    // the other flight takes it: it reads back with its own callsign and will do it (fn takes the aircraft)
    return { who: other, what, act: { kind: 'any', inj, what, apply: fn } };
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
    const set = (a, v) => { if (a.bust) a.bustFixedAt = this.t; a.cfl = v; a.sfl = v; a.bust = false; a.vr = null; this._closeReq(a, ['climb', 'descend']); };
    return this._cmd(id, `${dir} FL${fmtFL(fl)}`, a => set(a, fl), {
      kind: 'level', what: `${dir} FL${fmtFL(fl)}`,
      // the pilot reads back 1000 ft off and sets that in the Mode S selected level; the clearance stands
      wrong: d => ({ what: `${dir} FL${fmtFL(fl + 10 * d)}`, apply: a => { set(a, fl); a.sfl = fl + 10 * d; } })
    });
  }
  turn(id, hdg) {
    const v = ((Math.round(hdg) % 360) + 360) % 360;
    const hdgText = h => `turn heading ${String(h || 360).padStart(3, '0')}`;
    const set = (a, h) => { a.mode = 'hdg'; a.thdg = h; a.atcHdg = true; if (this._closeReq(a, ['wx'])) a.wxCleared = a.wxAsked; };
    return this._cmd(id, hdgText(v), a => set(a, v), {
      kind: 'heading', what: hdgText(v),
      wrong: d => { const h = (v + 30 * d + 360) % 360; return { what: hdgText(h), apply: a => set(a, h) }; }
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
    a.ri = 0; a.mode = 'nav'; a.wxCleared = null; a.atcHdg = false; a.legFrom = [a.x, a.y];
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
  resumeNav(id) { return this._cmd(id, 'resume own navigation', a => { a.mode = 'nav'; a.wxCleared = null; a.atcHdg = false; a.legFrom = [a.x, a.y]; }); }
  answer(id, approve) {
    const a = this.get(id);
    if (!a || !a.req) return { ok: false, msg: 'No open request' };
    const r = a.req, coord = r.kind === 'coord' || r.kind === 'mil'; // coordination with the next sector or the military, not the aircraft
    if (!coord && !this.onFreq(a)) return { ok: false, msg: `${a.cs} is not on your frequency` };
    if (!coord && a.rcf) return { ok: false, msg: `${a.cs}: no reply` };
    if (!coord && this.freqBusy()) return this.sayAgain(a);
    this.stats.reqAnswered++; this.stats.reqTimeSum += this.t - r.t;
    r.answeredAt = this.t; r.approved = approve;
    if (r.cell) r.cell.answers.push(this.t - r.t);
    if (!coord) this.stats.cmds++;
    if (r.kind === 'mil') this.log(`${a.cs} coordination with the military acknowledged`);
    else if (coord) {
      if (approve) { a.xfl = r.value; this.log(`${a.cs} exit level FL${fmtFL(r.value)} agreed with the next sector`); }
      else this.log(`${a.cs} exit level change refused, FL${fmtFL(a.xfl)} stands`);
    } else if (approve) {
      if (r.kind === 'climb' || r.kind === 'descend') { if (a.bust) a.bustFixedAt = this.t; a.cfl = r.value; a.sfl = r.value; a.bust = false; }
      if (r.kind === 'wx') { a.mode = 'hdg'; a.thdg = (a.hdg + r.value + 360) % 360; a.wxCleared = a.wxAsked; a.atcHdg = true; }
      if (r.kind === 'direct') { const p = this.C.points[r.value] || this.C.airports[r.value]; if (p) this._directTo(a, r.value, p.xy); }
      const what = r.kind === 'wx' ? 'deviation approved' : r.kind === 'direct' ? 'direct ' + r.value : (r.kind === 'climb' ? 'climb' : 'descend') + ' FL' + fmtFL(r.value);
      this.log(`${a.cs} ${what}`);
      this.queueReadback(a, what);
    } else { this.log(`${a.cs} unable, ${r.text.replace('requests ', '')}`); this.queueReadback(a, 'roger'); }
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
      if (a.comloss && a.comloss.declared) { const g = a.comloss.inj.g; items.push({ p: 1, ac: a, h: `${a.cs} COMLOSS`, s: g.notifiedAt === undefined ? `No contact for ${fmtT(this.t - g.declared + CIVMIL.comlossS)}. Notify the military.` : `Military notified${g.qra ? `, ${g.qra.cs} (QRA) airborne` : ', QRA scramble expected'}. Keep traffic clear.`, act: g.notifiedAt === undefined ? 'notify' : null }); }
      if (a.rcf && a.sq === '7600') items.push({ p: 1, ac: a, h: `${a.cs} radio failure`, s: `Squawk 7600. Continues FL${fmtFL(a.cfl)} on own navigation. Separate others from it.` });
      const cl = this.nets.clam.get(a.id), rm = this.nets.ram.get(a.id), ap = this.nets.apw.get(a.id);
      if (cl) items.push({ p: cl.kind === 'DEV' ? 1 : 2, ac: a, h: `${a.cs} CLAM ${cl.kind === 'DEV' ? 'level deviation' : 'selected level'}`, s: `Cleared FL${fmtFL(a.cfl)}, selected FL${fmtFL(a.sfl)}, now FL${fmtFL(a.fl)}. Re-issue the level.` });
      if (ap) items.push({ p: 1, ac: a, h: ap.level === 'VIOLATION' ? `${a.cs} APW inside ${ap.area.id}` : `${a.cs} APW ${ap.area.id} in ${fmtT(ap.tt)}`, s: `FL${fmtFL(a.fl)}, area ${areaBand(ap.area)}. Turn out, or leave its levels.` });
      if (rm) items.push({ p: 2, ac: a, h: `${a.cs} RAM off route ${rm.xtk.toFixed(1)} NM`, s: `Not on an ATC heading.${a.route[a.ri] ? ` Next point ${a.route[a.ri].id}.` : ''} Clear it direct or give a heading.` });
    }
    for (const c of this.stca) {
      if (c.level === 'los') items.push({ p: 1, ac: c.a, h: `${c.a.cs} / ${c.b.cs} below minima`, s: `${c.dh.toFixed(1)} NM, ${Math.round(c.dv)} ft` });
      else if (c.a.lastIn || c.b.lastIn || c.a.inbound || c.b.inbound) items.push({ p: 2, ac: c.a, h: `${c.a.cs} / ${c.b.cs} STCA in ${fmtT(c.tt)}`, s: `Now ${c.dh.toFixed(0)} NM, ${Math.round(c.dv)} ft` });
    }
    for (const z of this.tsa) if (!z.active) {
      const n = this.ac.filter(a => this.ours(a) && this.nearArea(a, z, 15)).length;
      items.push({ p: 2, h: `${z.id} activates in ${fmtT(z.at - this.t)}`, s: `${areaBand(z)}. ${n} of your aircraft inside or within 15 NM` });
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
      if (a.req) items.push({ p: a.req.kind === 'mil' ? 1 : a.req.kind === 'wx' || a.req.kind === 'coord' ? 2 : 3, ac: a, h: `${a.cs} ${a.req.text}`, s: `Waiting ${this.t - a.req.t} s`, act: 'req' });
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
