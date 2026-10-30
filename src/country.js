// Turns a raw country data module (AIP notation) into the processed form the
// simulator and renderer use: everything projected into the NM plane.
import { dms, makeProjection, centroid, pip } from './geo.js';

export function loadCountry(raw) {
  const { meta, sectors: sectorFile, borders, navaids, points, airports, traffic, map } = raw;
  const proj = makeProjection(meta.center[0], meta.center[1]);
  const c = {
    meta, traffic, proj,
    sectors: {}, sectorList: [], elementary: [],
    points: {}, pointList: [], navaids: [], airports: {}, airportList: [], mainAirports: {}, gateOf: {}
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

export const inSector = (xy, sec) => sec.polys.some(p => pip(xy, p));
