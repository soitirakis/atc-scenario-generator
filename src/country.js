// Turns a raw country data module (AIP notation) into the processed form the
// simulator and renderer use: everything projected into the NM plane.
import { dms, makeProjection, centroid, pip } from './geo.js';

export function loadCountry(raw) {
  const { meta, sectors: sectorFile, borders, navaids, points, airports, traffic, map, areas } = raw;
  const proj = makeProjection(meta.center[0], meta.center[1]);
  const c = {
    meta, traffic, proj,
    sectors: {}, sectorList: [], elementary: [],
    points: {}, pointList: [], navaids: [], airports: {}, airportList: [], mainAirports: {}, gateOf: {}, areas: []
  };
  for (const [k, g] of Object.entries(traffic.gates)) for (const id of g.pts) c.gateOf[id] = k;

  for (const s of sectorFile.sectors) {
    const ll = [];
    for (const t of s.poly) {
      if (typeof t === 'string') ll.push(dms(t));
      else if (t.b) {
        if (!borders[t.b]) throw new Error(`Sector ${s.id}: unknown border segment ${t.b}`);
        ll.push(...borders[t.b]);
      }
    }
    const poly = ll.map(p => proj.toNM(p[0], p[1]));
    const sec = { ...s, poly, polys: [poly], c: centroid(poly) };
    c.sectors[s.id] = sec; c.sectorList.push(sec); c.elementary.push(sec);
  }
  for (const k of sectorFile.collapsed) {
    const polys = k.parts.map(p => c.sectors[p].poly);
    const sec = { ...k, polys, vert: 'Collapsed configuration' };
    c.sectors[k.id] = sec; c.sectorList.push(sec);
  }
  const all = c.elementary.map(s => s.poly);
  c.sectors.FIR = { id: 'FIR', rad: meta.fir, name: meta.firName, polys: all, vert: 'Whole FIR' };

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
    c.mainAirports[ap.id] = { ...ap, approach: m.approach, handoffNM: m.handoffNM, arr: m.arr, dep: m.dep };
  }
  for (const a of (areas && areas.areas) || []) c.areas.push(loadArea(a, borders, proj));
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

export const inSector = (xy, sec) => sec.polys.some(p => pip(xy, p));
