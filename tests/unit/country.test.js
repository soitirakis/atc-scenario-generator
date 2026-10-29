import { describe, it, expect } from 'vitest';
import RO from '../../data/RO/index.js';
import { loadCountry, inSector } from '../../src/country.js';
import { pip } from '../../src/geo.js';

const C = loadCountry(RO);

describe('Romania data module', () => {
  it('has the 9 elementary Bucharest ACC sectors and 4 collapsed ones', () => {
    expect(C.elementary.map(s => s.name).sort()).toEqual(['ARGES', 'BACAU', 'BUDOP', 'DINSI', 'KOMAN', 'LOMOS', 'MOPUG', 'NAPOC', 'NERDI']);
    expect(C.sectorList.length - C.elementary.length).toBe(4);
    expect(C.sectors.FIR.polys).toHaveLength(9);
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

  it('collapsed configurations reference existing sectors', () => {
    for (const k of RO.sectors.collapsed) for (const p of k.parts) expect(C.sectors[p], `${k.id}:${p}`).toBeTruthy();
  });

  it('all published aerodromes lie inside the FIR', () => {
    for (const a of C.airportList) expect(inSector(a.xy, C.sectors.FIR), a.id).toBe(true);
  });

  it('Henri Coandă (LROP) lies in ARGES', () => {
    expect(inSector(C.airports.LROP.xy, C.sectors.ARG)).toBe(true);
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
    const T = RO.traffic;
    for (const g of Object.values(T.gates)) for (const id of g.pts) expect(C.points[id], id).toBeTruthy();
    for (const f of T.flows) {
      const ends = f.slice(0, 2);
      for (const e of ends) expect(T.gates[e] || C.mainAirports[e], e).toBeTruthy();
      expect(ends.every(e => C.mainAirports[e]), ends.join('-')).toBe(false); // airport to airport is not modelled
    }
  });

  it('LROP is the only main airport', () => {
    expect(Object.keys(C.mainAirports)).toEqual(['LROP']);
    expect(C.mainAirports.LROP.approach).toBe('Bucharest APP');
  });

  it('main airports declare an approach unit, a hand-off distance and both connection points per flow', () => {
    const T = RO.traffic;
    for (const m of T.mainAirports) {
      expect(C.airports[m.icao], m.icao).toBeTruthy();
      expect(m.approach, m.icao).toMatch(/\S/);
      expect(m.handoffNM, m.icao).toBeGreaterThan(0);
      for (const id of [...Object.values(m.arr), ...Object.values(m.dep)]) expect(C.points[id], `${m.icao}:${id}`).toBeTruthy();
      // flows are flown in both directions, so each linked gate group needs an arrival and a departure connection
      for (const f of T.flows) if (f.slice(0, 2).includes(m.icao)) {
        const g = f[0] === m.icao ? f[1] : f[0];
        expect(m.arr[g], `${m.icao} arr from ${g}`).toBeTruthy();
        expect(m.dep[g], `${m.icao} dep to ${g}`).toBeTruthy();
      }
    }
  });

  it('the loader rejects a main airport missing from airports.json', () => {
    const traffic = { ...RO.traffic, mainAirports: [{ ...RO.traffic.mainAirports[0], icao: 'LRXX' }] };
    expect(() => loadCountry({ ...RO, traffic })).toThrow(/LRXX/);
  });

  it('flows never use the closed Ukrainian gates', () => {
    for (const f of RO.traffic.flows) expect(f.slice(0, 2)).not.toContain('N');
  });

  it('entry-only gates are not used as exits in any gate group by role', () => {
    const entryOnly = C.pointList.filter(p => p.role === 'E').map(p => p.id);
    expect(entryOnly).toEqual(expect.arrayContaining(['VELIP', 'MAVIT', 'OGATA', 'BAGRI', 'IRMAM']));
  });
});
