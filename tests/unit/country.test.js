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

  it('every traffic gate and Bucharest connection point exists', () => {
    const T = RO.traffic;
    for (const g of Object.values(T.gates)) for (const id of g.pts) expect(C.points[id], id).toBeTruthy();
    for (const id of [...Object.values(T.lrop.arr), ...Object.values(T.lrop.dep)]) expect(C.points[id], id).toBeTruthy();
    for (const f of T.flows) for (const g of f.slice(0, 2)) expect(g === 'LROP' || T.gates[g], g).toBeTruthy();
  });

  it('flows never use the closed Ukrainian gates', () => {
    for (const f of RO.traffic.flows) expect(f.slice(0, 2)).not.toContain('N');
  });

  it('entry-only gates are not used as exits in any gate group by role', () => {
    const entryOnly = C.pointList.filter(p => p.role === 'E').map(p => p.id);
    expect(entryOnly).toEqual(expect.arrayContaining(['VELIP', 'MAVIT', 'OGATA', 'BAGRI', 'IRMAM']));
  });
});
