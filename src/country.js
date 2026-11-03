// Turns a raw country data module (AIP notation) into the processed form the
// simulator and renderer use: everything projected into the NM plane.
import { dms, makeProjection, centroid, pip } from './geo.js';

export function loadCountry(raw) {
  const { meta, sectors: sectorFile, borders, navaids, points, airports, traffic, map, areas, military } = raw;
  const proj = makeProjection(meta.center[0], meta.center[1]);
  const c = {
    meta, traffic, proj,
    sectors: {}, sectorList: [], elementary: [],
    points: {}, pointList: [], navaids: [], airports: {}, airportList: [], mainAirports: {}, gateOf: {}, areas: []
  };
  for (const [k, g] of Object.entries(traffic.gates)) for (const id of g.pts) c.gateOf[id] = k;

  const toPoly = (list, what) => {
    const ll = [];
    for (const t of list) {
      if (typeof t === 'string') ll.push(dms(t));
      else if (t.b) {
        if (!borders[t.b]) throw new Error(`${what}: unknown border segment ${t.b}`);
        ll.push(...borderPart(borders[t.b], t.upTo, `${what}: ${t.b}`));
      }
    }
    return ll.map(p => proj.toNM(p[0], p[1]));
  };
  for (const s of sectorFile.sectors) {
    const poly = toPoly(s.poly, `Sector ${s.id}`);
    const sec = { ...s, poly, polys: [poly], c: centroid(poly) };
    // vertical limits and delegated airspace; a sector without them is laterally bounded only, as before
    const lower = sectorLimit(s.lower, `Sector ${s.id} lower`), upper = sectorLimit(s.upper, `Sector ${s.id} upper`);
    const deleg = (kind, d, i) => {
      const what = `Sector ${s.id} ${kind} ${i + 1}`, unit = kind === 'include' ? d.from : d.to;
      if (!unit) throw new Error(`${what}: name the unit it is delegated ${kind === 'include' ? 'from' : 'to'}`);
      if (!d.lower || !d.upper) throw new Error(`${what}: give the delegation's own lower and upper limits`);
      return { unit, note: d.note || '', poly: toPoly(d.poly, what), lower: sectorLimit(d.lower, what + ' lower'), upper: sectorLimit(d.upper, what + ' upper') };
    };
    const include = (s.include || []).map((d, i) => deleg('include', d, i)), exclude = (s.exclude || []).map((d, i) => deleg('exclude', d, i));
    if (lower !== null || upper !== null || include.length || exclude.length) {
      if (lower !== null && upper !== null && lower >= upper) throw new Error(`Sector ${s.id}: lower limit FL${lower} is not below upper limit FL${upper}`);
      sec.vol = { lower, upper, include, exclude };
      sec.polys = [poly, ...include.map(d => d.poly)];
      sec.vert = sec.vert || bandText(lower, upper);
    }
    c.sectors[s.id] = sec; c.sectorList.push(sec); c.elementary.push(sec);
  }
  // a collapsed configuration combines elementary sectors, layers or other collapsed configurations
  for (const k of sectorFile.collapsed) {
    const members = [];
    for (const p of k.parts) {
      const m = c.sectors[p];
      if (!m) throw new Error(`Collapsed ${k.id}: unknown part ${p}`);
      for (const e of m.members || [m]) if (!members.includes(e)) members.push(e);
    }
    const sec = { ...k, members, polys: members.flatMap(m => m.polys), vert: k.vert || 'Collapsed configuration' };
    c.sectors[k.id] = sec; c.sectorList.push(sec);
  }
  for (const s of c.sectorList) s.band = sectorBand(s);
  const all = [];
  for (const s of c.elementary) for (const p of s.polys) if (!all.includes(p)) all.push(p);
  c.sectors.FIR = { id: 'FIR', rad: meta.fir, name: meta.firName, polys: all, vert: 'Whole FIR', band: null };
  c.aips = sourceAips(meta);
  c.upperOnly = null;
  if (meta.upperOnly) {
    const lowerFL = sectorLimit(meta.upperOnly.lowerLimit, 'meta.upperOnly.lowerLimit');
    if (lowerFL === null) throw new Error('meta.upperOnly.lowerLimit: give the unit\'s lower limit, e.g. "FL 245"');
    c.upperOnly = { lowerFL, lowerUnit: meta.upperOnly.lowerUnit || null };
  }

  for (const p of points) {
    const ll = dms(p.pos);
    const pt = { id: p.id, lat: ll[0], lon: ll[1], role: p.role, xy: proj.toNM(ll[0], ll[1]) };
    c.points[pt.id] = pt; c.pointList.push(pt);
  }
  for (const n of navaids) {
    const ll = dms(n.pos);
    c.navaids.push({ id: n.id, name: n.name, freq: n.freq, xy: proj.toNM(ll[0], ll[1]) });
  }
  for (const a of airports) {
    const ll = dms(a.pos);
    const ap = { id: a.icao, name: a.name, xy: proj.toNM(ll[0], ll[1]) };
    c.airports[ap.id] = ap; c.airportList.push(ap);
  }
  // Airports with arrival/departure flows. Optional: without any, traffic is transit only.
  for (const m of traffic.mainAirports || []) {
    const ap = c.airports[m.icao];
    if (!ap) throw new Error(`Main airport ${m.icao} is not in airports.json`);
    if (c.upperOnly) {
      // upper airspace only: the airport is controlled below, by a named lower unit
      const L = m.lowerUnit;
      if (m.approach) throw new Error(`Main airport ${m.icao}: an upper-airspace unit has no approach unit; give lowerUnit instead`);
      if (!L || !L.name || !(L.handoffNM > 0) || !(L.arrFL >= c.upperOnly.lowerFL) || !(L.depFL > c.upperOnly.lowerFL))
        throw new Error(`Main airport ${m.icao}: lowerUnit needs name, handoffNM, arrFL (at or above FL${c.upperOnly.lowerFL}) and depFL (above FL${c.upperOnly.lowerFL})`);
      c.mainAirports[ap.id] = { ...ap, unit: L.name, handoffNM: L.handoffNM, lower: { arrFL: L.arrFL, depFL: L.depFL }, arr: m.arr, dep: m.dep };
    } else c.mainAirports[ap.id] = { ...ap, approach: m.approach, unit: m.approach, handoffNM: m.handoffNM, lower: null, arr: m.arr, dep: m.dep };
  }
  for (const a of (areas && areas.areas) || []) c.areas.push(loadArea(a, borders, proj));
  // civil-military training constructs (military.json): QRA bases, formation, fighter performance
  c.military = null;
  if (military) {
    const qra = military.qra.map(q => {
      const ap = q.aerodrome ? c.airports[q.aerodrome] : null;
      if (q.aerodrome && !ap) throw new Error(`QRA base ${q.id}: aerodrome ${q.aerodrome} is not in airports.json`);
      const xy = ap ? ap.xy : (ll => proj.toNM(ll[0], ll[1]))(dms(q.pos));
      if (!military.aircraft[q.aircraft]) throw new Error(`QRA base ${q.id}: no performance for ${q.aircraft}`);
      return { id: q.id, name: q.name, xy, aircraft: q.aircraft, callsign: q.callsign };
    });
    c.military = { qra, formation: military.formation, aircraft: military.aircraft };
  }
  c.coast = map.coast.map(p => proj.toNM(p[0], p[1]));
  c.neigh = map.neighbours.map(n => ({ label: n.label, xy: proj.toNM(n.lat, n.lon) }));

  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  for (const p of all.flat()) {
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
  }
  c.bounds = [minX, minY, maxX, maxY];
  return c;
}

/** "FL 125" -> 125, "9500 FT ALT" -> 95, "GND" -> 0, "UNL" -> 999; null if issued by NOTAM. */
export function limitFL(s) {
  if (!s) return null;
  let m;
  if ((m = /^FL ?(\d{2,3})$/.exec(s))) return +m[1];
  if ((m = /^(\d{3,5}) FT (?:AMSL|MSL|ALT|AGL)$/.exec(s))) return +m[1] / 100;
  return s === 'GND' ? 0 : s === 'UNL' ? 999 : null;
}

// "along border HUNGARY_ROMANIA" -> the borders.json segments ending in _RO
const BORDER_ISO = { ROMANIA: 'RO', HUNGARY: 'HU', SLOVAKREPUBLIC: 'SK', UKRAINE: 'UA', SERBIA: 'RS', CROATIA: 'HR', SLOVENIA: 'SI', AUSTRIA: 'AT', BULGARIA: 'BG', MOLDOVA: 'MD' };

/**
 * One ENR 5.2 area in the NM plane: { id, name, type, poly, lower, upper (FL, null if by NOTAM), activation }.
 * A circle becomes a 36-sided polygon. An "along border" segment takes the border vertices that lie
 * between the published points before and after it (borders.json is approximated, so is that part).
 */
export function loadArea(a, borders, proj) {
  let ll;
  if (a.circle) {
    const [lat, lon] = dms(a.circle.centre), r = a.circle.radiusNM / 60;
    ll = Array.from({ length: 36 }, (_, i) => { const t = (i * 10 * Math.PI) / 180; return [lat + r * Math.cos(t), lon + (r * Math.sin(t)) / Math.cos((lat * Math.PI) / 180)]; });
  } else {
    ll = [];
    a.lateral.forEach((t, i) => {
      const m = /^along border [A-Z]+_([A-Z]+)$/.exec(t);
      if (!m) { ll.push(dms(t)); return; }
      const iso = BORDER_ISO[m[1]], from = dms(a.lateral[i - 1]), to = dms(a.lateral[(i + 1) % a.lateral.length]);
      const verts = Object.entries(borders).filter(([k, v]) => iso && Array.isArray(v) && k.endsWith('_' + iso)).flatMap(([, v]) => v);
      const dx = to[1] - from[1], dy = to[0] - from[0], L2 = dx * dx + dy * dy || 1;
      const along = verts.map(v => ({ v, s: ((v[1] - from[1]) * dx + (v[0] - from[0]) * dy) / L2, off: Math.abs((v[1] - from[1]) * dy - (v[0] - from[0]) * dx) / Math.sqrt(L2) }))
        .filter(p => p.s > 0 && p.s < 1 && p.off < 0.25).sort((p, q) => p.s - q.s);
      ll.push(...along.map(p => p.v));
    });
  }
  const read = k => a[k + 'Read'] || a[k];
  return { id: a.id, name: a.name, type: a.type, activation: a.activation, poly: ll.map(p => proj.toNM(p[0], p[1])), lower: limitFL(read('lower')), upper: limitFL(read('upper')) };
}

/**
 * Sector or layer limit as published: "FL 245" -> 245, "GND" -> 0; "Lower limit of ATS routes" and
 * a missing limit -> null (no limit on that side). Anything else is an error, so a typo never
 * silently opens a sector.
 */
export function sectorLimit(s, what = 'limit') {
  if (s === undefined || s === null || /^lower limit of ats routes$/i.test(s)) return null;
  const fl = limitFL(s);
  if (fl === null || fl === 999) throw new Error(`${what}: "${s}" is not a sector limit (use "FL nnn", "GND" or "Lower limit of ATS routes")`);
  return fl;
}
/** "FL245-FL660", "below FL245", "FL365 and above". */
export function bandText(lower, upper) {
  const f = n => `FL${String(n).padStart(3, '0')}`;
  return lower === null ? (upper === null ? 'all levels' : `below ${f(upper)}`) : upper === null ? `${f(lower)} and above` : `${f(lower)}-${f(upper)}`;
}
/** [lower, upper] over a sector's volumes (null on an open side), or null if it has no vertical limits. */
function sectorBand(sec) {
  const vols = (sec.members || [sec]).flatMap(m => (m.vol ? [m.vol, ...m.vol.include] : [{ lower: null, upper: null }]));
  if (!vols.some(v => v.lower !== null || v.upper !== null)) return null;
  const lo = vols.some(v => v.lower === null) ? null : Math.min(...vols.map(v => v.lower));
  const hi = vols.some(v => v.upper === null) ? null : Math.max(...vols.map(v => v.upper));
  return lo === null && hi === null ? null : [lo, hi];
}
/** Sector selection label: the band is part of the name of a layer, e.g. "KOMAN 2 FL245-FL660". */
export const sectorLabel = s => (s.band && !s.members ? `${s.name} ${bandText(s.band[0], s.band[1])}` : s.name);

/**
 * The border vertices of a segment up to (not including) the one at upTo, a published point on the
 * border where the sector leaves it (within 0.05°: the border is approximated). Without upTo, all of them.
 */
function borderPart(verts, upTo, what) {
  if (!upTo) return verts;
  const [lat, lon] = dms(upTo), i = verts.findIndex(v => Math.hypot(v[0] - lat, v[1] - lon) < 0.05);
  if (i < 0) throw new Error(`${what}: no border vertex near ${upTo}`);
  return verts.slice(0, i);
}

/**
 * The source AIPs of a module: meta.aips [{ state, url, edition, amendment }] for a module built
 * from several states' AIPs, else the single eAIP of meta.airac and the first source link.
 */
function sourceAips(meta) {
  if (!meta.aips) return [{ state: meta.name, url: (meta.sources && meta.sources[0] && meta.sources[0].url) || '', edition: meta.airac.edition, amendment: meta.airac.enr41 || '' }];
  if (!Array.isArray(meta.aips) || !meta.aips.length) throw new Error('meta.aips: list at least one source AIP');
  return meta.aips.map((a, i) => {
    for (const k of ['state', 'url', 'edition', 'amendment']) if (!a[k]) throw new Error(`meta.aips[${i}]: missing ${k}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(a.edition)) throw new Error(`meta.aips[${i}] (${a.state}): edition "${a.edition}" is not a date (YYYY-MM-DD)`);
    return { state: a.state, url: a.url, edition: a.edition, amendment: a.amendment };
  });
}

const inBand = (v, fl) => (v.lower === null || fl >= v.lower) && (v.upper === null || fl < v.upper);
/**
 * Inside the sector at level fl. Lower limits are inclusive, upper limits exclusive, so a level on a
 * layer boundary belongs to the upper layer. A sector without vertical limits or delegations is
 * checked laterally only. Without fl, the lateral footprint (own polygon and included areas).
 */
export function inSector(xy, sec, fl) {
  if (sec.members) return sec.members.some(m => inSector(xy, m, fl));
  const v = sec.vol;
  if (!v) return sec.polys.some(p => pip(xy, p));
  if (fl === undefined) return sec.polys.some(p => pip(xy, p));
  if (v.exclude.some(d => inBand(d, fl) && pip(xy, d.poly))) return false;
  return (inBand(v, fl) && pip(xy, sec.poly)) || v.include.some(d => inBand(d, fl) && pip(xy, d.poly));
}
/** True if a sector needs levels to tell inside from outside (vertical limits or delegations). */
export const isVertical = sec => (sec.members || [sec]).some(m => m.vol);
