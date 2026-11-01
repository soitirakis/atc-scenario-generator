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

/* ---------- ENR 5.2 military areas ---------- */
const COORD = /\d{6}[NS] \d{7}[EW]/g;
// A vertical limit in a format we read: FL200, FL 125, 4500 FT AMSL, 9500 FT ALT, 1017 FT MSL, GND, UNL.
// Anything else makes the parse fail, so a new format is looked at instead of read wrongly.
const LIMIT_FORMAT = /^(?:FL ?\d{2,3}|\d{3,5} FT (?:AMSL|MSL|ALT|AGL)|GND|UNL)$/;
const LIMIT_TOKEN = '(?:FL ?\\d{2,3}|\\d{3,5} FT (?:AMSL|MSL|ALT|AGL)|GND|UNL)';

/**
 * Misprinted limits we accept, and how we read them. Keyed "<area> <upper|lower> <as printed>".
 * eAIP Romania ENR 5.2, AIRAC AIP AMDT 04/25 (17 APR 2025), checked on the rendered pages: the "F" of
 * "FL" is missing in the PDF itself, not lost in text extraction.
 */
export const KNOWN_LIMIT_TYPOS = {
  'LRTRA27L upper L200': 'FL200', // page ENR 5.2-5
  'LRTRA41 lower L280': 'FL280', // page ENR 5.2-9
  'LRTRA113B lower L280': 'FL280' // page ENR 5.2-24
};

/** Check one published limit: { value } if we read it, { value, read } for a known typo; throws otherwise. */
export function checkLimit(id, which, value) {
  if (LIMIT_FORMAT.test(value)) return { value };
  const typo = KNOWN_LIMIT_TYPOS[`${id} ${which} ${value}`];
  if (typo) return { value, read: typo };
  throw new Error(`ENR 5.2: unrecognised ${which} limit "${value}" for ${id}. Add the format to scripts/airac-lib.mjs, or to KNOWN_LIMIT_TYPOS if the AIP misprints it.`);
}

/** "FL 125" -> 125, "9500 FT ALT" -> 95, "GND" -> 0, "UNL" -> 999; null when not a limit. */
export function limitToFL(s) {
  if (!s) return null;
  let m;
  if ((m = /^FL ?(\d{2,3})$/.exec(s))) return +m[1];
  if ((m = /^(\d{3,5}) FT (?:AMSL|MSL|ALT|AGL)$/.exec(s))) return +m[1] / 100;
  if (s === 'GND') return 0;
  if (s === 'UNL') return 999;
  return null;
}

/**
 * Parse ROMATSA ENR 5.2 (PDF text) into areas [{ id, name, type, lateral | circle, upper, lower, activation }].
 * lateral: vertices in AIP notation, closing vertex dropped; circle: { centre, radiusNM }.
 * Limits stay as published; null when the AIP says they are issued by NOTAM.
 */
export function parseLrEnr52(text) {
  const lines = text.split('\n');
  const head = /^(LR(?:TRA|TSA)[0-9A-Z]+)(?: \(([^)]*)\))?\s*$/;
  const starts = [];
  lines.forEach((l, i) => { if (head.test(l.trim())) starts.push(i); });
  return starts.map((s, k) => {
    const [, id, name] = head.exec(lines[s].trim());
    const own = lines.slice(s + 1, k + 1 < starts.length ? starts[k + 1] : lines.length).map(l => l.trim())
      .filter(l => l && !/^=== page|^A ?IP\b|^ROMANIA\b|^ENR 5\.2-\d+|^\d{2} [A-Z]{3} \d{4}|^ROMATSA\b|^A ?IRAC AIP AMDT|^1 +2 +3$|^(TEMPORARY|AIR DEFENCE)/.test(l));
    const block = own.join(' ').replace(/\s+/g, ' ');
    const coords = block.match(COORD) || [];
    const area = { id, name: name || null, type: id.slice(2, 5) };
    const circle = /Circle of ([\d.]+) NM radius centred on point of coordinates: (\d{6}[NS] \d{7}[EW])/.exec(block);
    let rest;
    if (circle) { area.circle = { centre: circle[2], radiusNM: +circle[1] }; rest = block.slice(circle.index + circle[0].length); }
    else {
      const last = block.lastIndexOf(coords[coords.length - 1]);
      area.lateral = coords[0] === coords[coords.length - 1] ? coords.slice(0, -1) : coords;
      rest = block.slice(last + coords[coords.length - 1].length);
    }
    // the upper and lower limits are the two lines after the last line of the lateral limits
    let lastGeo = -1;
    own.forEach((l, i) => { if (COORD.test(l)) lastGeo = i; COORD.lastIndex = 0; });
    const after = own.slice(lastGeo + 1);
    if (/^Vertical limits are issued/.test(after[0] || '')) { area.upper = null; area.lower = null; }
    // some lower-airspace TSAs print no vertical limits at all: the next line is already "Active: ..."
    else if (/^Active:/.test(after[0] || '')) { area.upper = null; area.lower = null; area.note = 'No vertical limits published.'; }
    else for (const [i, which] of [[0, 'upper'], [1, 'lower']]) {
      const c = checkLimit(id, which, (after[i] || '').replace(/\s+/g, ' '));
      area[which] = c.value;
      if (c.read) { area[which + 'Read'] = c.read; area.note = `AIP prints "${c.value}"; read as ${c.read}.`; }
    }
    const act = /Active: (by [A-Z]+)/.exec(rest);
    area.activation = act ? act[1] : null;
    return area;
  });
}

/**
 * Parse HungaroControl ENR 5.2 (HTML text) the same way. Lateral limits may include
 * "along border HUNGARY_ROMANIA"-style segments, kept as written. Names have no digits, so one
 * area's match cannot run on into the next.
 */
export function parseLhEnr52(text) {
  const t = text.replace(/\s+/g, ' ');
  const re = new RegExp(`\\b(LH(?:TRA|TSA)[0-9A-Z]+) \\/ ([^\\d/]+?) (\\d{6}[NS] \\d{7}[EW](?:(?: - | )(?:\\d{6}[NS] \\d{7}[EW]|along border [A-Z_]+))+) (${LIMIT_TOKEN}) \\/ (${LIMIT_TOKEN}) (\\S+)`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(t))) {
    const lateral = m[3].match(/\d{6}[NS] \d{7}[EW]|along border [A-Z_]+/g);
    if (lateral[0] === lateral[lateral.length - 1]) lateral.pop();
    out.push({ id: m[1], name: m[2], type: m[1].slice(2, 5), lateral, upper: m[4], lower: m[5], activation: m[6] });
  }
  // an area whose limits are in a format we do not read would not match above: fail instead of dropping it
  const listed = [...new Set([...t.matchAll(/\b(LH(?:TRA|TSA)[0-9A-Z]+) \//g)].map(x => x[1]))];
  const missing = listed.filter(id => !out.some(a => a.id === id));
  if (missing.length) {
    const at = t.indexOf(missing[0] + ' /');
    throw new Error(`ENR 5.2: could not read ${missing.join(', ')}; unrecognised format near "${t.slice(at, at + 160)}…". Update parseLhEnr52 in scripts/airac-lib.mjs.`);
  }
  return out;
}

/** Compare stored areas with freshly parsed ones by id: geometry, limits or activation changed. */
export function diffAreas(stored, parsed) {
  const key = a => JSON.stringify([a.lateral || null, a.circle || null, a.upper, a.lower, a.activation]);
  const old = new Map(stored.map(a => [a.id, a])), now = new Map(parsed.map(a => [a.id, a]));
  return {
    changed: parsed.filter(a => old.has(a.id) && key(old.get(a.id)) !== key(a)).map(a => ({ id: a.id, was: { upper: old.get(a.id).upper, lower: old.get(a.id).lower }, now: { upper: a.upper, lower: a.lower } })),
    removed: stored.filter(a => !now.has(a.id)).map(a => ({ id: a.id })),
    added: parsed.filter(a => !old.has(a.id)).map(a => ({ id: a.id, pos: a.circle ? a.circle.centre : a.lateral[0], role: `${a.upper || 'NOTAM'}/${a.lower || 'NOTAM'}` }))
  };
}
