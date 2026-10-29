// Canvas radar display. Reads a Sim; never changes simulation state.
import { D2R, fmtFL, fmtT } from './geo.js';

const MONO = '"IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace';
const UI = '"Barlow Semi Condensed", "Arial Narrow", system-ui, sans-serif';

export class Renderer {
  constructor(canvas, sim) {
    this.cv = canvas; this.ctx = canvas.getContext('2d'); this.sim = sim;
    this.V = { cx: 0, cy: 0, sc: 1, w: 0, h: 0, dpr: 1 };
    this.layers = { sectors: true, points: 'ex', navaids: true, airports: true, labels: true, vec: 2 };
    this.sel = null; this.col = {};
    this.readColors(); this.resize();
  }

  readColors() {
    const cs = getComputedStyle(document.documentElement);
    for (const k of ['scope', 'map', 'map-hi', 'text', 'muted', 'assumed', 'pend', 'unc', 'accent', 'warn', 'alert', 'wx', 'ok', 'line', 'panel']) this.col[k] = cs.getPropertyValue('--' + k).trim();
  }

  resize() {
    const r = this.cv.getBoundingClientRect(), V = this.V;
    const prevW = V.w;
    V.dpr = window.devicePixelRatio || 1; V.w = r.width; V.h = r.height;
    this.cv.width = Math.round(r.width * V.dpr); this.cv.height = Math.round(r.height * V.dpr);
    if (prevW) V.sc *= V.w / prevW || 1;
  }

  sx(p) { return (p[0] - this.V.cx) * this.V.sc + this.V.w / 2; }
  sy(p) { return (p[1] - this.V.cy) * this.V.sc + this.V.h / 2; }
  toWorld(mx, my) { const V = this.V; return [(mx - V.w / 2) / V.sc + V.cx, (my - V.h / 2) / V.sc + V.cy]; }

  fitBox(minX, minY, maxX, maxY, pad = 30) {
    const V = this.V;
    V.cx = (minX + maxX) / 2; V.cy = (minY + maxY) / 2;
    V.sc = Math.min((V.w - pad * 2) / Math.max(1, maxX - minX), (V.h - pad * 2) / Math.max(1, maxY - minY));
  }
  fitSector() {
    const s = this.sim.sector; if (!s) return;
    const b = [1e9, 1e9, -1e9, -1e9];
    for (const p of s.polys.flat()) { b[0] = Math.min(b[0], p[0]); b[1] = Math.min(b[1], p[1]); b[2] = Math.max(b[2], p[0]); b[3] = Math.max(b[3], p[1]); }
    this.fitBox(b[0] - 40, b[1] - 40, b[2] + 40, b[3] + 40);
  }
  fitFir() { const b = this.sim.C.bounds; this.fitBox(b[0] - 20, b[1] - 20, b[2] + 20, b[3] + 20); }
  zoomAt(mx, my, f) {
    const V = this.V, before = this.toWorld(mx, my);
    V.sc = Math.max(0.3, Math.min(12, V.sc * f));
    V.cx = before[0] - (mx - V.w / 2) / V.sc; V.cy = before[1] - (my - V.h / 2) / V.sc;
  }
  centreOn(a) {
    const X = this.sx([a.x, a.y]), Y = this.sy([a.x, a.y]);
    if (X < 40 || Y < 40 || X > this.V.w - 40 || Y > this.V.h - 40) { this.V.cx = a.x; this.V.cy = a.y; }
  }

  /** Aircraft under a screen point (plot symbol or label block). */
  hitTest(mx, my) {
    let best = null, bd = 16;
    for (const a of this.sim.ac) {
      const d = Math.hypot(this.sx([a.px, a.py]) - mx, this.sy([a.px, a.py]) - my);
      if (d < bd) { bd = d; best = a; }
    }
    if (best) return best;
    for (const a of this.sim.ac) {
      const b = a._lb;
      if (b && mx >= b[0] && mx <= b[0] + b[2] && my >= b[1] && my <= b[1] + b[3]) return a;
    }
    return null;
  }

  acColor(a) {
    const c = this.col;
    if (a.emg) return c.alert;
    if (a.rcf) return c.warn;
    if (a.lastIn) return c.assumed;
    if (a.inbound) return c.pend;
    return c.unc;
  }

  path(poly) {
    const ctx = this.ctx; ctx.beginPath();
    poly.forEach((q, i) => (i ? ctx.lineTo(this.sx(q), this.sy(q)) : ctx.moveTo(this.sx(q), this.sy(q))));
    ctx.closePath();
  }

  draw() {
    const { ctx, V, col, layers, sim } = this, C = sim.C, W = V.w, H = V.h;
    const sx = p => this.sx(p), sy = p => this.sy(p);
    ctx.setTransform(V.dpr, 0, 0, V.dpr, 0, 0);
    ctx.fillStyle = col.scope; ctx.fillRect(0, 0, W, H);
    const sel = sim.sector;

    // coastline
    ctx.setLineDash([2, 4]); ctx.strokeStyle = col.map; ctx.lineWidth = 1; ctx.beginPath();
    C.coast.forEach((q, i) => (i ? ctx.lineTo(sx(q), sy(q)) : ctx.moveTo(sx(q), sy(q)))); ctx.stroke(); ctx.setLineDash([]);

    // sectors
    if (layers.sectors) {
      for (const sec of C.elementary) {
        const isSel = sel && (sel.id === sec.id || (sel.parts && sel.parts.includes(sec.id)) || sel.id === 'FIR');
        this.path(sec.poly);
        if (isSel) { ctx.fillStyle = 'rgba(79,179,217,0.06)'; ctx.fill(); }
        ctx.strokeStyle = isSel ? col['map-hi'] : col.map; ctx.lineWidth = isSel ? 1.6 : 1; ctx.stroke();
      }
      ctx.font = `600 12px ${UI}`; ctx.textAlign = 'center'; ctx.fillStyle = col.map;
      for (const sec of C.elementary) ctx.fillText(sec.name, sx(sec.c), sy(sec.c));
    }
    ctx.font = `11px ${MONO}`; ctx.fillStyle = col.map; ctx.textAlign = 'center';
    for (const n of C.neigh) ctx.fillText(n.label, sx(n.xy), sy(n.xy));
    ctx.textAlign = 'left';

    // TSA
    for (const z of sim.tsa) {
      ctx.beginPath(); ctx.arc(sx([z.x, z.y]), sy([z.x, z.y]), z.r * V.sc, 0, Math.PI * 2);
      ctx.setLineDash(z.active ? [] : [6, 4]); ctx.strokeStyle = z.active ? col.alert : col.warn; ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = z.active ? 'rgba(255,93,79,0.08)' : 'rgba(240,178,60,0.05)'; ctx.fill();
      ctx.fillStyle = z.active ? col.alert : col.warn; ctx.font = `11px ${MONO}`;
      ctx.fillText(`${z.name} FL195+ ${z.active ? 'ACTIVE' : 'ACT ' + fmtT(z.at - sim.t)}`, sx([z.x, z.y]) - 40, sy([z.x, z.y]) - z.r * V.sc - 6);
    }
    // weather
    for (const c of sim.wx) {
      const X = sx([c.x, c.y]), Y = sy([c.x, c.y]), R = c.r * V.sc;
      ctx.save(); ctx.beginPath(); ctx.arc(X, Y, R, 0, Math.PI * 2); ctx.clip();
      ctx.strokeStyle = 'rgba(184,140,255,0.45)'; ctx.lineWidth = 1;
      for (let k = -R * 2; k < R * 2; k += 6) { ctx.beginPath(); ctx.moveTo(X + k, Y - R); ctx.lineTo(X + k + R, Y + R); ctx.stroke(); }
      ctx.restore();
      ctx.beginPath(); ctx.arc(X, Y, R, 0, Math.PI * 2); ctx.strokeStyle = col.wx; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.fillStyle = col.wx; ctx.font = `11px ${MONO}`; ctx.fillText(`CB ${c.top}`, X + R + 4, Y);
    }
    // aerodromes
    if (layers.airports) {
      ctx.font = `10.5px ${MONO}`;
      for (const a of C.airportList) {
        const X = sx(a.xy), Y = sy(a.xy);
        ctx.beginPath(); ctx.arc(X, Y, 3.5, 0, Math.PI * 2); ctx.strokeStyle = col.muted; ctx.lineWidth = 1; ctx.stroke();
        ctx.fillStyle = col.muted; ctx.fillText(a.id, X + 6, Y + 4);
      }
    }
    // VOR/DME
    if (layers.navaids) {
      ctx.font = `10.5px ${MONO}`;
      for (const n of C.navaids) {
        const X = sx(n.xy), Y = sy(n.xy); ctx.beginPath();
        for (let k = 0; k < 6; k++) { const an = Math.PI / 3 * k; const px = X + Math.cos(an) * 5, py = Y + Math.sin(an) * 5; k ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
        ctx.closePath(); ctx.strokeStyle = col['map-hi']; ctx.lineWidth = 1; ctx.stroke();
        ctx.fillStyle = col['map-hi']; ctx.fillText(n.id, X + 7, Y - 5);
      }
    }
    // FRA points
    if (layers.points !== 'off') {
      ctx.font = `10px ${MONO}`;
      const closed = new Set(Object.values(C.traffic.gates).filter(g => g.closed).flatMap(g => g.pts));
      const gates = new Set(Object.values(C.traffic.gates).flatMap(g => g.pts));
      for (const p of C.pointList) {
        // "E/X" layer: upper-level entry/exit points plus every traffic gate
        const ex = p.role === 'E' || p.role === 'X' || p.role === 'EX' || gates.has(p.id);
        if (layers.points === 'ex' && !ex) continue;
        const X = sx(p.xy), Y = sy(p.xy);
        if (X < -20 || Y < -20 || X > W + 20 || Y > H + 20) continue;
        const isClosed = closed.has(p.id);
        ctx.beginPath(); ctx.moveTo(X, Y - 4); ctx.lineTo(X + 3.5, Y + 2.5); ctx.lineTo(X - 3.5, Y + 2.5); ctx.closePath();
        ctx.strokeStyle = isClosed ? col.line : (ex ? col.accent : col.map); ctx.lineWidth = 1;
        if (ex && !isClosed) { ctx.fillStyle = col.accent; ctx.globalAlpha = 0.35; ctx.fill(); ctx.globalAlpha = 1; }
        ctx.stroke();
        if (V.sc > 0.9 || ex) { ctx.fillStyle = isClosed ? col.line : col.map; ctx.fillText(p.id, X + 5, Y + 3); }
      }
    }
    // scale bar
    const nm = V.sc * 50 > 140 ? 20 : 50, bx = W - 18 - nm * V.sc, by = H - 46;
    ctx.strokeStyle = col.muted; ctx.lineWidth = 1; ctx.beginPath();
    ctx.moveTo(bx, by); ctx.lineTo(bx + nm * V.sc, by);
    ctx.moveTo(bx, by - 4); ctx.lineTo(bx, by + 4); ctx.moveTo(bx + nm * V.sc, by - 4); ctx.lineTo(bx + nm * V.sc, by + 4); ctx.stroke();
    ctx.fillStyle = col.muted; ctx.font = `10.5px ${MONO}`; ctx.textAlign = 'right'; ctx.fillText(nm + ' NM', bx + nm * V.sc, by - 7); ctx.textAlign = 'left';

    // selected aircraft route
    const selAc = sim.get(this.sel);
    if (selAc) {
      ctx.setLineDash([4, 4]); ctx.strokeStyle = col.accent; ctx.lineWidth = 1; ctx.beginPath();
      ctx.moveTo(sx([selAc.px, selAc.py]), sy([selAc.px, selAc.py]));
      for (let k = selAc.ri; k < selAc.route.length; k++) ctx.lineTo(sx(selAc.route[k].xy), sy(selAc.route[k].xy));
      ctx.stroke(); ctx.setLineDash([]);
      ctx.font = `10.5px ${MONO}`; ctx.fillStyle = col.accent;
      for (let k = selAc.ri; k < selAc.route.length; k++) ctx.fillText(selAc.route[k].id, sx(selAc.route[k].xy) + 6, sy(selAc.route[k].xy) - 6);
    }
    // STCA pair lines
    for (const c of sim.stca) {
      ctx.strokeStyle = c.level === 'los' ? col.alert : col.warn; ctx.lineWidth = c.level === 'los' ? 2 : 1.2;
      ctx.setLineDash(c.level === 'los' ? [] : [5, 3]);
      ctx.beginPath(); ctx.moveTo(sx([c.a.px, c.a.py]), sy([c.a.px, c.a.py])); ctx.lineTo(sx([c.b.px, c.b.py]), sy([c.b.px, c.b.py])); ctx.stroke();
    }
    ctx.setLineDash([]);
    const stcaIds = new Map();
    for (const c of sim.stca) for (const a of [c.a, c.b]) if (!stcaIds.has(a.id) || c.level === 'los') stcaIds.set(a.id, c.level);

    // aircraft
    ctx.font = `11px ${MONO}`;
    for (const a of sim.ac) {
      a._lb = null;
      const color = this.acColor(a), X = sx([a.px, a.py]), Y = sy([a.px, a.py]);
      if (X < -80 || Y < -60 || X > W + 80 || Y > H + 60) continue;
      ctx.fillStyle = color;
      a.plots.forEach((p, i) => { ctx.globalAlpha = 0.15 + i * 0.07; ctx.fillRect(sx(p) - 1.5, sy(p) - 1.5, 3, 3); });
      ctx.globalAlpha = 1;
      const vl = a.gs / 60 * layers.vec;
      ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(X, Y);
      ctx.lineTo(X + Math.sin(a.hdg * D2R) * vl * V.sc, Y - Math.cos(a.hdg * D2R) * vl * V.sc); ctx.stroke();
      const st = stcaIds.get(a.id);
      ctx.strokeStyle = st === 'los' ? col.alert : st === 'pred' ? col.warn : color; ctx.lineWidth = 1.4;
      ctx.strokeRect(X - 4, Y - 4, 8, 8);
      if (a.lastIn) { ctx.fillStyle = color; ctx.fillRect(X - 2, Y - 2, 4, 4); }
      if (a.id === this.sel) { ctx.strokeStyle = col.accent; ctx.lineWidth = 1; ctx.strokeRect(X - 8, Y - 8, 16, 16); }
      if (!layers.labels && a.id !== this.sel && !a.lastIn) continue;
      const lx = X + 12, ly = Y - 18;
      ctx.strokeStyle = color; ctx.globalAlpha = 0.5; ctx.beginPath(); ctx.moveTo(X + 5, Y - 5); ctx.lineTo(lx - 2, ly + 10); ctx.stroke(); ctx.globalAlpha = 1;
      const trend = Math.abs(a.sfl - a.fl) > 0.3 ? (a.sfl > a.fl ? '↑' : '↓') : ' ';
      const l1 = a.cs + (a.sq === '7700' ? ' EMG' : a.sq === '7600' ? ' RCF' : '') + (a.req ? ' REQ' : '') + (a.popupUntil > sim.t ? ' NEW' : '');
      if (st) { ctx.fillStyle = st === 'los' ? 'rgba(255,93,79,0.18)' : 'rgba(240,178,60,0.14)'; ctx.fillRect(lx - 3, ly - 1, 98, 40); }
      ctx.fillStyle = a.req ? col.pend : color; ctx.fillText(l1, lx, ly + 10);
      ctx.fillStyle = color; ctx.fillText(fmtFL(a.fl) + trend, lx, ly + 23);
      ctx.fillStyle = a.bust ? col.alert : color; ctx.fillText(fmtFL(a.cfl) + (a.bust ? '≠' + fmtFL(a.sfl) : ''), lx + 34, ly + 23);
      ctx.fillStyle = color; ctx.globalAlpha = 0.85; ctx.fillText(String(Math.round(a.gs / 10)).padStart(2, '0') + ' ' + a.type, lx, ly + 36); ctx.globalAlpha = 1;
      a._lb = [lx - 3, ly - 1, 98, 40];
    }
  }
}
