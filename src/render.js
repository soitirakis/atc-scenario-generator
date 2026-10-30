// Canvas radar display. Reads a Sim; never changes simulation state.
import { D2R, fmtFL, fmtT } from './geo.js';

const MONO = '"IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace';
const UI = '"Barlow Semi Condensed", "Arial Narrow", system-ui, sans-serif';

// Data block geometry (screen px). Candidate positions, as box top-left relative to the plot: NE, SE, SW, NW.
const LW = 98, LH = 40, GAP = 10;
const SLOTS = [[GAP, -GAP - LH], [GAP, GAP], [-GAP - LW, GAP], [-GAP - LW, -GAP - LH]];
const PLOT = 7;              // half-size of the area a track symbol occupies
const HYST = 0.05 * LW * LH; // a label only moves if another slot is better by more than this (px²)

const overlap = (a, b) => Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));

export class Renderer {
  constructor(canvas, sim) {
    this.cv = canvas; this.ctx = canvas.getContext('2d'); this.sim = sim;
    this.V = { cx: 0, cy: 0, sc: 1, w: 0, h: 0, dpr: 1 };
    this.layers = { sectors: true, points: 'ex', navaids: true, airports: true, labels: true, vec: 2 };
    this.sel = null; this.col = {};
    // label state per aircraft id: { slot, user: [dx, dy] | null, box: [x, y, w, h] | null }
    this.lab = new Map(); this.labSig = '';
    this.readColors(); this.resize();
  }

  /** Forget label positions, including dragged ones (aircraft ids restart with each session). */
  resetLabels() { this.lab.clear(); this.labSig = ''; }

  /** Drawn data blocks, for hit tests and e2e checks: [{ id, box }]. */
  labelBoxes() { return [...this.lab].filter(([, l]) => l.box).map(([id, l]) => ({ id, box: l.box })); }

  labelAt(mx, my) {
    for (const { id, box: b } of this.labelBoxes()) if (mx >= b[0] && mx <= b[0] + b[2] && my >= b[1] && my <= b[1] + b[3]) return id;
    return null;
  }
  /** Current label offset from the plot (screen px), used as the start of a drag. */
  labelOffset(id) {
    const l = this.lab.get(id), a = this.sim.get(id);
    if (!l || !l.box || !a) return null;
    return [l.box[0] - this.sx([a.px, a.py]), l.box[1] - this.sy([a.px, a.py])];
  }
  /** Pin a label at an offset from its plot; kept for that aircraft until the session restarts. */
  moveLabel(id, dx, dy) {
    const l = this.lab.get(id) || { slot: 0, user: null, box: null };
    l.user = [dx, dy]; this.lab.set(id, l); this.labSig = '';
  }

  /**
   * Choose a slot for each data block. Recomputed only when screen positions change
   * (radar refresh, zoom, pan, aircraft added or removed), starting from the previous
   * choice, so labels stay put between radar updates. items: [{ id, X, Y }].
   */
  layoutLabels(items, W, H) {
    const sig = items.map(i => `${i.id}:${Math.round(i.X)},${Math.round(i.Y)}`).join(';') + `|${W}x${H}`;
    if (sig === this.labSig) return;
    this.labSig = sig;
    const ids = new Set(items.map(i => i.id));
    for (const id of this.lab.keys()) if (!ids.has(id) && !this.sim.get(id)) this.lab.delete(id);
    for (const l of this.lab.values()) l.box = null;
    const plots = items.map(i => [i.X - PLOT, i.Y - PLOT, PLOT * 2, PLOT * 2]);
    const boxAt = (it, slot) => [it.X + SLOTS[slot][0], it.Y + SLOTS[slot][1], LW, LH];
    const L = items.map(it => {
      const l = this.lab.get(it.id), fresh = !l;
      const e = l || { slot: 0, user: null, box: null };
      this.lab.set(it.id, e);
      e.box = e.user ? [it.X + e.user[0], it.Y + e.user[1], LW, LH] : fresh ? null : boxAt(it, e.slot);
      return { it, l: e };
    });
    // label-label overlap counts squared, so one large overlap costs more than several slight ones
    const cost = (k, box) => {
      let c = 0;
      for (let j = 0; j < L.length; j++) {
        if (j === k) continue;
        const b = L[j].l.box;
        if (b) { const o = overlap(box, b); c += o + o * o / (LW * LH); }
        c += overlap(box, plots[j]);
      }
      const inside = overlap(box, [0, 0, W, H]);
      return c + (LW * LH - inside) * 0.5; // prefer slots that stay on screen
    };
    // new labels take the best slot given the labels already placed
    L.forEach(({ it, l }, k) => {
      if (l.box) return;
      let best = 0, bc = Infinity;
      for (let s = 0; s < SLOTS.length; s++) { const c = cost(k, boxAt(it, s)); if (c < bc) { bc = c; best = s; } }
      l.slot = best; l.box = boxAt(it, best);
    });
    // local search: each pass moves a label to its best slot if that is clearly better
    for (let pass = 0; pass < 8; pass++) {
      let changed = false;
      L.forEach(({ it, l }, k) => {
        if (l.user) return;
        const cur = cost(k, l.box);
        let best = l.slot, bc = cur;
        for (let s = 0; s < SLOTS.length; s++) { if (s === l.slot) continue; const c = cost(k, boxAt(it, s)); if (c < bc) { bc = c; best = s; } }
        if (best !== l.slot && bc < cur - HYST) { l.slot = best; l.box = boxAt(it, best); changed = true; }
      });
      if (!changed) break;
    }
    // pair moves: two overlapping labels where neither can improve alone try all slot combinations together
    for (let pass = 0; pass < 3; pass++) {
      let changed = false;
      for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
        const A = L[i].l, B = L[j].l;
        if (A.user || B.user || !overlap(A.box, B.box)) continue;
        const keep = [A.box, B.box], cur = cost(i, A.box) + cost(j, B.box);
        let best = null, bc = cur;
        for (let sa = 0; sa < SLOTS.length; sa++) for (let sb = 0; sb < SLOTS.length; sb++) {
          A.box = boxAt(L[i].it, sa); B.box = boxAt(L[j].it, sb);
          const c = cost(i, A.box) + cost(j, B.box);
          if (c < bc) { bc = c; best = [sa, sb]; }
        }
        [A.box, B.box] = keep;
        if (best && bc < cur - HYST) {
          A.slot = best[0]; A.box = boxAt(L[i].it, best[0]); B.slot = best[1]; B.box = boxAt(L[j].it, best[1]); changed = true;
        }
      }
      if (!changed) break;
    }
    // repair the worst overlap directly: move one label of the worst pair if that lowers the worst overlap overall
    const worst = () => {
      let w = 0, pr = null;
      for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) { const o = overlap(L[i].l.box, L[j].l.box); if (o > w) { w = o; pr = [i, j]; } }
      return [w, pr];
    };
    for (let n = 0; n < 30; n++) {
      const [w, pr] = worst();
      if (!pr || w <= 0.1 * LW * LH) break;
      let best = null;
      for (const k of pr) {
        const l = L[k].l, keep = l.box;
        if (l.user) continue;
        for (let s = 0; s < SLOTS.length; s++) { l.box = boxAt(L[k].it, s); const [nw] = worst(); if (nw < w - HYST && (!best || nw < best[2])) best = [k, s, nw]; }
        l.box = keep;
      }
      if (!best) break;
      const l = L[best[0]].l; l.slot = best[1]; l.box = boxAt(L[best[0]].it, best[1]);
    }
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

  /** Aircraft whose plot symbol is under a screen point. */
  plotAt(mx, my) {
    let best = null, bd = 16;
    for (const a of this.sim.ac) {
      const d = Math.hypot(this.sx([a.px, a.py]) - mx, this.sy([a.px, a.py]) - my);
      if (d < bd) { bd = d; best = a; }
    }
    return best;
  }

  /** Aircraft under a screen point (plot symbol or label block). */
  hitTest(mx, my) {
    const a = this.plotAt(mx, my);
    if (a) return a;
    const id = this.labelAt(mx, my);
    return id === null ? null : this.sim.get(id);
  }

  acColor(a) {
    const c = this.col;
    if (a.emg) return c.alert;
    if (a.rcf && a.sq === '7600') return c.warn; // a silent pilot without 7600 looks normal on radar
    if (a.ctl === 'ass') return c.assumed;
    if (a.ctl === 'pend' || a.noXfer) return c.pend;
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

    // aircraft: tracks first, then data blocks placed around them
    ctx.font = `11px ${MONO}`;
    const labelled = [];
    for (const a of sim.ac) {
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
      labelled.push({ id: a.id, X, Y, a, color, st });
    }
    this.layoutLabels(labelled, W, H);
    for (const { a, X, Y, color, st } of labelled) {
      const [bx, by] = this.lab.get(a.id).box, lx = bx + 3, ly = by + 1;
      // leader line from the track symbol to the nearest point of the data block
      const qx = Math.max(bx, Math.min(X, bx + LW)), qy = Math.max(by, Math.min(Y, by + LH));
      const d = Math.hypot(qx - X, qy - Y);
      if (d > 6) {
        ctx.strokeStyle = color; ctx.globalAlpha = 0.5; ctx.lineWidth = 1; ctx.beginPath();
        ctx.moveTo(X + (qx - X) / d * 5, Y + (qy - Y) / d * 5); ctx.lineTo(qx, qy); ctx.stroke(); ctx.globalAlpha = 1;
      }
      const trend = Math.abs(a.sfl - a.fl) > 0.3 ? (a.sfl > a.fl ? '↑' : '↓') : ' ';
      const l1 = a.cs + (a.sq === '7700' ? ' EMG' : a.sq === '7600' ? ' RCF' : '') + (a.req ? ' REQ' : '') + (a.popupUntil > sim.t ? ' NEW' : '');
      if (st) { ctx.fillStyle = st === 'los' ? 'rgba(255,93,79,0.18)' : 'rgba(240,178,60,0.14)'; ctx.fillRect(bx, by, LW, LH); }
      ctx.fillStyle = a.req ? col.pend : color; ctx.fillText(l1, lx, ly + 10);
      ctx.fillStyle = color; ctx.fillText(fmtFL(a.fl) + trend, lx, ly + 23);
      ctx.fillStyle = a.bust ? col.alert : color; ctx.fillText(fmtFL(a.cfl) + (a.bust ? '≠' + fmtFL(a.sfl) : ''), lx + 34, ly + 23);
      // agreed exit level, amber while the cleared level differs from it
      if (!a.bust && a.xfl !== null && (a.ctl === 'ass' || a.ctl === 'pend')) {
        ctx.fillStyle = a.ctl === 'ass' && Math.round(a.cfl) !== a.xfl ? col.warn : color;
        ctx.fillText('X' + fmtFL(a.xfl), lx + 62, ly + 23);
      }
      ctx.fillStyle = color; ctx.globalAlpha = 0.85; ctx.fillText(String(Math.round(a.gs / 10)).padStart(2, '0') + ' ' + a.type, lx, ly + 36); ctx.globalAlpha = 1;
    }
  }
}
