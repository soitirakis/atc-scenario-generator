// Pure parsing helpers for the AIRAC update. Kept separate from the network
// code so they can be unit tested against fixture text.

/**
 * Classify a significant point's FRA relevance from its ENR 4.4 remarks text.
 *  E / X / EX  horizontal entry and/or exit at upper levels (FIR boundary)
 *  L           entry or exit only in a band topping out at FL175 or below
 *  I           intermediate point only
 *  null        not FRA relevant (SID/STAR/IAC only, "NIL")
 */
export function classifyRole(remarks) {
  const txt = remarks.replace(/\s+/g, ' ');
  const re = /FRA \((E|X|I|A|D|AD)\)\s*:?\s*([\s\S]*?)(?=FRA \(|$)/g;
  let upE = false, upX = false, low = false, inter = false, m;
  while ((m = re.exec(txt))) {
    const kind = m[1], qual = m[2] || '';
    if (kind === 'I') { inter = true; continue; }
    if (kind !== 'E' && kind !== 'X') continue;
    const band = qual.match(/FL\s?(\d{3})\s*-\s*FL\s?(\d{3})/);
    const lowerOnly = band && +band[2] <= 175;
    if (lowerOnly) low = true;
    else if (kind === 'E') upE = true;
    else upX = true;
  }
  if (upE && upX) return 'EX';
  if (upE) return 'E';
  if (upX) return 'X';
  if (low) return 'L';
  if (inter) return 'I';
  return null;
}

/** Parse ENR 4.4 text into [{id, pos, role}] (role may be null). */
export function parseEnr44(text, classify = classifyRole) {
  const re = /\b([A-Z]{5})\s+(\d{6}[NS])\s*(\d{7}[EW])\b/g;
  const hits = [];
  let m;
  while ((m = re.exec(text))) hits.push({ id: m[1], pos: `${m[2]} ${m[3]}`, start: m.index, end: re.lastIndex });
  return hits.map((h, i) => {
    const remarks = text.slice(h.end, i + 1 < hits.length ? hits[i + 1].start : text.length);
    return { id: h.id, pos: h.pos, role: classify(remarks) };
  });
}

/**
 * Hungary publishes FRA relevance as letter codes with an optional level band,
 * e.g. "(I) FL245-FL660 Nil (X) 9500 FT AMSL-FL245". Rewrite it in the
 * "FRA (X) FL095-FL245" form classifyRole reads; 9500 FT AMSL counts as FL095.
 */
export function lhRelevance(text) {
  const txt = text.replace(/\s+/g, ' ');
  const re = /\(([EXIAD]{1,5})\)(?:\s*(?:(\d{4,5})\s*FT\s*AMSL|FL\s?(\d{3}))\s*-\s*FL\s?(\d{3}))?/g;
  let out = '', m;
  while ((m = re.exec(txt))) {
    const band = m[4] ? ` FL${m[2] ? String(Math.round(+m[2] / 100)).padStart(3, '0') : m[3]}-FL${m[4]}` : '';
    for (const k of m[1]) out += `FRA (${k})${band} `;
  }
  return out.trim();
}

/** Parse Hungary ENR 4.4.1 text into [{id, pos, role}] (role may be null). */
export function parseLhEnr441(text) {
  return parseEnr44(text, remarks => classifyRole(lhRelevance(remarks)));
}

/** Parse Hungary ENR 4.1 text into DVOR/DME stations [{id, name, freq, pos}]. */
export function parseLhEnr41(text) {
  const txt = text.replace(/\s+/g, ' ');
  const re = /([A-ZÁÉÍÓÖŐÚÜŰ]+) DVOR\/DME \(decl\.: [^)]*\) ([A-Z]{3}) (\d{3}\.\d+) ?MHZ \S+ H24 (\d{6}N) ?(\d{7}E)/g;
  return [...txt.matchAll(re)].map(m => ({ id: m[2], name: m[1], freq: (+m[3]).toFixed(3), pos: `${m[4]} ${m[5]}` }));
}

/**
 * The HungaroControl eAIP is not amended every AIRAC cycle. From the text of its index page
 * ("AIRAC AMDT 006/2026 … Effective date 2026-09-03"), return the edition in force on `date`
 * (YYYY-MM-DD): { edition, amdt }, or null if none is listed for that date.
 */
export function lhEditionOn(indexText, date) {
  const txt = indexText.replace(/\s+/g, ' ');
  const eds = [...txt.matchAll(/AIRAC AMDT (\d{3}\/\d{4})[^]*?Effective date (\d{4}-\d{2}-\d{2})/g)].map(m => ({ amdt: m[1], edition: m[2] }));
  return eds.filter(e => e.edition <= date).sort((a, b) => b.edition.localeCompare(a.edition))[0] || null;
}

/** Strip an eAIP HTML page down to its text. */
export function htmlText(html) {
  const ent = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return html.replace(/<script[^]*?<\/script>|<style[^]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ent[e.toLowerCase()] ?? m)
    .replace(/[ \t\r]+/g, ' ');
}

/** Parse ENR 4.1 text into VOR / VOR-DME stations [{id, freq, pos}]. DME-only (4-digit MHz) are skipped. */
export function parseEnr41(text) {
  const re = /\b([A-Z]{3})\s+(1[01]\d\.\d{3})\s*MHz[\s\S]{0,60}?H24\s+(\d{6}[NS])\s*(\d{7}[EW])/g;
  const out = [];
  let m;
  while ((m = re.exec(text))) out.push({ id: m[1], freq: m[2], pos: `${m[3]} ${m[4]}` });
  return out;
}

/**
 * Compare current data with freshly parsed AIP data. Points not yet in the data are
 * reported as new only if their role is in `addRoles` (Romania's point set is curated:
 * only entry/exit points are added automatically).
 */
export function diffPoints(current, parsed, addRoles = ['E', 'X', 'EX']) {
  const byId = new Map(parsed.map(p => [p.id, p]));
  const changed = [], removed = [], added = [];
  for (const c of current) {
    const p = byId.get(c.id);
    if (!p) { removed.push(c); continue; }
    const d = {};
    if (p.pos !== c.pos) d.pos = [c.pos, p.pos];
    // A null parsed role means the AIP no longer lists the point as FRA relevant; report it too.
    if (p.role !== c.role) d.role = [c.role, p.role];
    if (Object.keys(d).length) changed.push({ id: c.id, ...d });
  }
  const have = new Set(current.map(c => c.id));
  for (const p of parsed) if (!have.has(p.id) && addRoles.includes(p.role)) added.push(p);
  return { changed, removed, added };
}

export function diffNavaids(current, parsed) {
  const byId = new Map(parsed.map(p => [p.id, p]));
  const changed = [], removed = [], added = [];
  for (const c of current) {
    const p = byId.get(c.id);
    if (!p) { removed.push(c); continue; }
    if (p.pos !== c.pos || p.freq !== c.freq) changed.push({ id: c.id, pos: [c.pos, p.pos], freq: [c.freq, p.freq] });
  }
  const have = new Set(current.map(c => c.id));
  for (const p of parsed) if (!have.has(p.id)) added.push(p);
  return { changed, removed, added };
}

/** AIRAC effective dates are every 28 days from a known cycle start. */
export function airacDates(from, count = 3, ref = Date.UTC(2026, 9, 1)) {
  let t = ref;
  const day = 864e5;
  while (t > from.getTime()) t -= 28 * day;
  while (t + 28 * day <= from.getTime()) t += 28 * day;
  const out = [];
  for (let i = 0; i < count; i++) out.push(new Date(t + i * 28 * day).toISOString().slice(0, 10));
  return out; // [current, next, after]
}
