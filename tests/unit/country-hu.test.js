import { describe, it, expect } from 'vitest';
import HU from '../../data/HU/index.js';
import RO from '../../data/RO/index.js';
import { loadCountry, inSector } from '../../src/country.js';
import { pip } from '../../src/geo.js';

const C = loadCountry(HU);

describe('Hungary data module', () => {
  it('has the 4 Budapest ACC lateral sectors and no collapsed ones', () => {
    expect(C.elementary.map(s => s.name).sort()).toEqual(['EAST', 'NORTH', 'SOUTH', 'WEST']);
    expect(C.sectorList.length - C.elementary.length).toBe(0);
    expect(C.sectors.FIR.polys).toHaveLength(4);
  });

  it('every elementary sector polygon contains its own label point', () => {
    for (const s of C.elementary) expect(pip(s.c, s.poly), s.name).toBe(true);
  });

  it('elementary sectors do not overlap (label points sit in exactly one sector)', () => {
    for (const s of C.elementary) {
      const owners = C.elementary.filter(o => pip(s.c, o.poly)).map(o => o.name);
      expect(owners, s.name).toEqual([s.name]);
    }
  });

  it('sector outlines use the published ENR 2.1 FIR corners', () => {
    const corners = ['480024N 0170939E', '482412N 0220919E', '475733N 0225422E', '460702N 0201602E', '455515N 0185324E', '462901N 0163358E', '465209N 0160650E'];
    const used = HU.sectors.sectors.flatMap(s => s.poly.filter(t => typeof t === 'string'));
    for (const c of corners) expect(used, c).toContain(c);
  });

  it('approximated geometry is labelled as such', () => {
    expect(HU.sectors._note).toMatch(/NOT published as coordinates/);
    expect(HU.borders._note).toMatch(/Approximated/);
  });

  it('all published aerodromes lie inside the FIR', () => {
    for (const a of C.airportList) expect(inSector(a.xy, C.sectors.FIR), a.id).toBe(true);
  });

  it('Budapest Liszt Ferenc (LHBP) lies in EAST', () => {
    expect(inSector(C.airports.LHBP.xy, C.sectors.EAST)).toBe(true);
  });

  it('points use a known FRA role and unique names', () => {
    const ids = new Set();
    for (const p of C.pointList) {
      expect(['E', 'X', 'EX', 'L', 'I'], p.id).toContain(p.role);
      expect(ids.has(p.id), p.id).toBe(false);
      ids.add(p.id);
    }
  });

  it('every traffic gate exists and flows run between gates or main airports', () => {
    const T = HU.traffic;
    for (const g of Object.values(T.gates)) for (const id of g.pts) expect(C.points[id], id).toBeTruthy();
    for (const f of T.flows) {
      const ends = f.slice(0, 2);
      for (const e of ends) expect(T.gates[e] || C.mainAirports[e], e).toBeTruthy();
      expect(ends.every(e => C.mainAirports[e]), ends.join('-')).toBe(false); // airport to airport is not modelled
    }
  });

  it('every gate group used in a flow has an entry and an exit point', () => {
    const T = HU.traffic;
    for (const g of new Set(T.flows.flatMap(f => f.slice(0, 2)).filter(e => T.gates[e]))) {
      const roles = T.gates[g].pts.map(id => C.points[id].role);
      expect(roles.some(r => r !== 'X'), `${g} entry`).toBe(true);
      expect(roles.some(r => r !== 'E'), `${g} exit`).toBe(true);
    }
  });

  it('LHBP is the only main airport', () => {
    expect(Object.keys(C.mainAirports)).toEqual(['LHBP']);
    expect(C.mainAirports.LHBP.approach).toBe('Budapest APP');
  });

  it('main airports declare an approach unit, a hand-off distance and both connection points per flow', () => {
    const T = HU.traffic;
    for (const m of T.mainAirports) {
      expect(C.airports[m.icao], m.icao).toBeTruthy();
      expect(m.approach, m.icao).toMatch(/\S/);
      expect(m.handoffNM, m.icao).toBeGreaterThan(0);
      for (const id of [...Object.values(m.arr), ...Object.values(m.dep)]) expect(C.points[id], `${m.icao}:${id}`).toBeTruthy();
      for (const f of T.flows) if (f.slice(0, 2).includes(m.icao)) {
        const g = f[0] === m.icao ? f[1] : f[0];
        expect(m.arr[g], `${m.icao} arr from ${g}`).toBeTruthy();
        expect(m.dep[g], `${m.icao} dep to ${g}`).toBeTruthy();
      }
    }
  });

  it('flows never use closed gates', () => {
    const closed = Object.entries(HU.traffic.gates).filter(([, g]) => g.closed).map(([k]) => k);
    expect(closed).toEqual(['UA']);
    for (const f of HU.traffic.flows) for (const k of closed) expect(f.slice(0, 2)).not.toContain(k);
  });
});

describe('Hungary-Romania border consistency', () => {
  const huPt = id => HU.points.find(p => p.id === id), roPt = id => RO.points.find(p => p.id === id);

  it('the Romania gate uses the HU-border points of Romania’s west gate, with identical coordinates', () => {
    const roWestHu = RO.traffic.gates.W.pts.filter(id => huPt(id));
    expect(HU.traffic.gates.E.pts.slice().sort()).toEqual(roWestHu.slice().sort());
    for (const id of HU.traffic.gates.E.pts) expect(huPt(id).pos, id).toBe(roPt(id).pos);
  });

  it('points published by both AIPs have the same coordinates', () => {
    for (const p of HU.points) { const r = roPt(p.id); if (r) expect(p.pos, p.id).toBe(r.pos); }
  });

  it('the HU-RO border reuses Romania’s border vertices', () => {
    const hu = [...HU.borders.NORTH_RO, ...HU.borders.EAST_RO].map(p => p.join(','));
    const ro = new Set([...RO.borders.BUDOP_HU_UA, ...RO.borders.MOPUG_RS_HU].map(p => p.join(',')));
    const roCorner = [46 + 25 / 60, 21 + 17 / 60 + 40 / 3600].join(','); // RO sector corner 462500N 0211740E
    for (const v of hu) expect(ro.has(v) || v === roCorner, v).toBe(true);
  });
});
