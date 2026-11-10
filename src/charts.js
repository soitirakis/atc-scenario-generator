// Small inline SVG charts for the Progress view, as strings (DOM-free). One measure per chart, so
// every chart has one axis. Colours come from CSS classes (styles.css .ch-*); each mark has a
// <title>, which the browser shows on hover, and the same numbers are in the tables beside them.
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const W = 300, H = 96, PAD = { l: 6, r: 6, t: 14, b: 16 };

/**
 * Bars, one per session, oldest on the left, with the value above each bar.
 * @param points [{ label (shown under the bar), value, title (hover text) }]
 */
export function barsSvg(points, aria) {
  const max = Math.max(1, ...points.map(p => p.value)), n = Math.max(1, points.length);
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b, slot = iw / n, bw = Math.min(26, slot * 0.7), base = PAD.t + ih;
  const marks = points.map((p, k) => {
    const x = PAD.l + slot * k + (slot - bw) / 2, h = (p.value / max) * ih;
    // the bar is drawn from the baseline; a zero value is a short tick so the session still shows
    return `<g><title>${esc(p.title)}</title><rect class="ch-hit" x="${(PAD.l + slot * k).toFixed(1)}" y="${PAD.t}" width="${slot.toFixed(1)}" height="${ih + PAD.b}"/>`
      + (p.value > 0 ? `<rect class="ch-bar" x="${x.toFixed(1)}" y="${(base - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2"/>` : `<rect class="ch-zero" x="${x.toFixed(1)}" y="${base - 1}" width="${bw.toFixed(1)}" height="1"/>`)
      + `<text class="ch-val" x="${(x + bw / 2).toFixed(1)}" y="${(base - h - 3).toFixed(1)}">${esc(p.value)}</text>`
      + `<text class="ch-lab" x="${(x + bw / 2).toFixed(1)}" y="${H - 3}">${esc(p.label)}</text></g>`;
  }).join('');
  return `<svg class="ch" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria)}"><line class="ch-axis" x1="${PAD.l}" x2="${W - PAD.r}" y1="${base}" y2="${base}"/>${marks}</svg>`;
}

/**
 * Closest pair per session against the separation minimum: a dot where separation was lost (value
 * in NM), an open circle on the minimum line where it was not (value null).
 * @param points [{ label, value (NM or null), title }]
 */
export function closestSvg(points, aria, minNM = 5) {
  const max = Math.max(minNM, ...points.filter(p => p.value !== null).map(p => p.value)), n = Math.max(1, points.length);
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b, slot = iw / n, base = PAD.t + ih, y = v => base - (v / max) * ih;
  const marks = points.map((p, k) => {
    const cx = PAD.l + slot * (k + 0.5);
    return `<g><title>${esc(p.title)}</title><rect class="ch-hit" x="${(PAD.l + slot * k).toFixed(1)}" y="${PAD.t}" width="${slot.toFixed(1)}" height="${ih + PAD.b}"/>`
      + (p.value === null ? `<circle class="ch-open" cx="${cx.toFixed(1)}" cy="${y(minNM).toFixed(1)}" r="4"/>`
        : `<circle class="ch-dot" cx="${cx.toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="4"/><text class="ch-val" x="${cx.toFixed(1)}" y="${(y(p.value) - 7).toFixed(1)}">${p.value.toFixed(1)}</text>`)
      + `<text class="ch-lab" x="${cx.toFixed(1)}" y="${H - 3}">${esc(p.label)}</text></g>`;
  }).join('');
  return `<svg class="ch" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria)}"><line class="ch-axis" x1="${PAD.l}" x2="${W - PAD.r}" y1="${base}" y2="${base}"/>`
    + `<line class="ch-ref" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(minNM).toFixed(1)}" y2="${y(minNM).toFixed(1)}"/><text class="ch-ref-lab" x="${PAD.l}" y="${(y(minNM) - 7).toFixed(1)}">${minNM} NM</text>${marks}</svg>`;
}

/**
 * The last sessions of one objective as squares, oldest on the left: met, partly met, not met.
 * @param last [{ savedAt, met, graded }]
 */
export function squaresSvg(last) {
  const state = s => (s.met === s.graded ? 'met' : s.met ? 'part' : 'miss');
  const words = { met: 'met', part: 'partly met', miss: 'not met' };
  const cells = last.map((s, k) => `<rect class="ch-sq ch-${state(s)}" x="${k * 14}" y="1" width="11" height="11" rx="2"><title>${esc(s.savedAt.slice(0, 10))}: ${words[state(s)]} (${s.met}/${s.graded})</title></rect>`).join('');
  return `<svg class="ch-sqs" viewBox="0 0 ${Math.max(1, last.length * 14 - 3)} 13" width="${Math.max(1, last.length * 14 - 3)}" height="13" role="img" aria-label="${esc(last.map(s => words[state(s)]).join(', ') || 'no sessions')}">${cells}</svg>`;
}
