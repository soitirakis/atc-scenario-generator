import { describe, it, expect } from 'vitest';
import RO from '../../data/RO/index.js';
import { loadCountry, inSector, isVertical, sectorLimit, sectorLabel, bandText } from '../../src/country.js';
import { Sim } from '../../src/sim.js';
import { buildLocalScenario } from '../../src/scenario.js';
import { dist } from '../../src/geo.js';

const C = loadCountry(RO);
const run = (sim, s) => { for (let i = 0; i < s; i++) sim.step(); };
const session = (Cx, sector, seed = 4127) => {
  const sim = new Sim(Cx);
  sim.load(buildLocalScenario(Cx, { sector, difficulty: 'intermediate', duration: 30, seed, objective: 'x' }));
  return sim;
};
/** Decimal degrees to AIP notation, e.g. 44.5, 25.25 -> "443000N 0251500E". */
const D = (lat, lon) => {
  const f = (v, w) => { const s = Math.round(v * 3600); return String(Math.floor(s / 3600)).padStart(w, '0') + String(Math.floor(s / 60) % 60).padStart(2, '0') + String(s % 60).padStart(2, '0'); };
  return `${f(lat, 2)}N ${f(lon, 3)}E`;
};
const box = (lat0, lon0, lat1, lon1) => [D(lat0, lon0), D(lat0, lon1), D(lat1, lon1), D(lat1, lon0)];
const at = (lat, lon) => C.proj.toNM(lat, lon);
/** A copy of the Romanian module to build test variants from. */
const variant = change => { const raw = structuredClone(RO); change(raw); return raw; };

describe('sector limits', () => {
  it('reads published limits; "Lower limit of ATS routes" and a missing limit are open', () => {
    expect(sectorLimit('FL 245')).toBe(245);
    expect(sectorLimit('FL660')).toBe(660);
    expect(sectorLimit('GND')).toBe(0);
    expect(sectorLimit('Lower limit of ATS routes')).toBeNull();
    expect(sectorLimit(undefined)).toBeNull();
  });
  it('anything else is an error, so a typo never opens a sector', () => {
    expect(() => sectorLimit('FL24S', 'KOM1 upper')).toThrow(/KOM1 upper: "FL24S" is not a sector limit/);
    expect(() => sectorLimit('UNL')).toThrow(/not a sector limit/);
    const raw = variant(r => { r.sectors.sectors[0].lower = 'FL 300'; r.sectors.sectors[0].upper = 'FL 200'; });
    expect(() => loadCountry(raw)).toThrow(/Sector ARG: lower limit FL300 is not below upper limit FL200/);
  });
  it('bands read as AIP-style text', () => {
    expect(bandText(365, 660)).toBe('FL365-FL660');
    expect(bandText(null, 245)).toBe('below FL245');
    expect(bandText(245, null)).toBe('FL245 and above');
  });
});

describe('KOMAN 1 / KOMAN 2 (NM RAD LRBBKOM19)', () => {
  const K1 = C.sectors.KOM1, K2 = C.sectors.KOM2, K = C.sectors.KOM;
  const both = at(44.3, 25.6), strip = at(43.8, 25.4); // the strip along the Danube is KOMAN 1 only

  it('KOMAN 1 is below FL245, KOMAN 2 from FL245 to FL660; FL245 itself is KOMAN 2', () => {
    expect([K1.band, K2.band]).toEqual([[null, 245], [245, 660]]);
    expect([inSector(both, K1, 240), inSector(both, K2, 240)]).toEqual([true, false]);
    expect([inSector(both, K1, 245), inSector(both, K2, 245)]).toEqual([false, true]);
    expect([inSector(both, K1, 370), inSector(both, K2, 370)]).toEqual([false, true]);
    expect(inSector(both, K2, 660)).toBe(false);
  });
  it('KOMAN 2 leaves out the strip along the Danube that KOMAN 1 covers', () => {
    expect(inSector(strip, K1, 200)).toBe(true);
    expect(inSector(strip, K2, 300)).toBe(false);
    expect(inSector(strip, K, 300)).toBe(false);
    expect(inSector(strip, K, 200)).toBe(true);
  });
  it('a border segment can stop at a published point: KOMAN 2 follows the Danube only to 435213N 0255833E', () => {
    const border = RO.borders.KOMAN_BG.map(v => C.proj.toNM(v[0], v[1]).join());
    expect(K1.poly.filter(p => border.includes(p.join()))).toHaveLength(6);
    expect(K2.poly.filter(p => border.includes(p.join()))).toHaveLength(1);
    expect(() => loadCountry(variant(r => { r.sectors.sectors.find(s => s.id === 'KOM2').poly[3].upTo = '450000N 0300000E'; }))).toThrow(/KOM2: KOMAN_BG: no border vertex near 450000N 0300000E/);
  });
  it('the selection lists each layer with its band; KOMAN combines the two layers', () => {
    expect(sectorLabel(K1)).toBe('KOMAN 1 below FL245');
    expect(sectorLabel(K2)).toBe('KOMAN 2 FL245-FL660');
    expect(sectorLabel(K)).toBe('KOMAN');
    expect(K.members.map(m => m.id)).toEqual(['KOM1', 'KOM2']);
  });
  it('a collapsed configuration can use another: KNL is KOM (both layers) + LOM + NER, as in the RAD file', () => {
    expect(C.sectors.KNL.members.map(m => m.id)).toEqual(['KOM1', 'KOM2', 'LOM', 'NER']);
    expect(isVertical(C.sectors.KNL)).toBe(true);
    expect(isVertical(C.sectors.ARG)).toBe(false);
    expect(() => loadCountry(variant(r => { r.sectors.collapsed.push({ id: 'X', rad: 'X', name: 'X', parts: ['NOPE'] }); }))).toThrow(/Collapsed X: unknown part NOPE/);
  });
  it('sectors without limits are checked laterally only, whatever the level', () => {
    const p = C.sectors.ARG.c;
    expect([inSector(p, C.sectors.ARG), inSector(p, C.sectors.ARG, 50), inSector(p, C.sectors.ARG, 600)]).toEqual([true, true, true]);
  });
  it('one label for the two layers on the map: they share a group', () => {
    expect([K1.group, K2.group]).toEqual(['KOMAN', 'KOMAN']);
  });
});

describe('sessions in a layer', () => {
  it('in KOMAN 2, an aircraft counts as inside only within the band', () => {
    const sim = session(C, 'KOM2');
    for (const a of sim.ac) expect(a.lastIn, a.cs).toBe(inSector([a.x, a.y], C.sectors.KOM2, a.fl));
    expect(sim.ac.some(a => a.lastIn)).toBe(true);
  });
  it('in KOMAN 1, transits are planned on semicircular levels inside the layer', () => {
    const sim = session(C, 'KOM1');
    const transits = sim.ac.filter(a => a.cat === 'transit' && !a.conflict);
    expect(transits.length).toBeGreaterThan(0);
    expect(transits.filter(a => a.rfl < 245).length / transits.length).toBeGreaterThan(0.5);
    expect(sim.ac.some(a => a.lastIn)).toBe(true);
  });
  it('look-ahead predicts levels: a flight below the layer becomes inbound when its climb takes it in', () => {
    const sim = session(C, 'KOM2');
    sim.ac = [];
    const p = at(44.3, 25.6), a = sim.initKinematics(sim.makeAircraft({ cs: 'CLB1', type: 'A320', x: p[0], y: p[1], fl: 200, cfl: 300, sfl: 300, route: [{ id: 'W', xy: [p[0] + 300, p[1]] }] }));
    sim.ac.push(a);
    sim.computeInbound();
    expect(a.lastIn).toBe(false);
    expect(a.inbound).toBe(true);
    expect(a.tEntry).toBeGreaterThan(0);
    const level = sim.initKinematics(sim.makeAircraft({ cs: 'LVL1', type: 'A320', x: p[0], y: p[1], fl: 200, cfl: 200, sfl: 200, route: [{ id: 'W', xy: [p[0] + 300, p[1]] }] }));
    sim.ac.push(level); sim.computeInbound();
    expect(level.inbound).toBe(false);
  });
  it('injects pick aircraft in a lower layer too', () => {
    const sim = session(C, 'KOM1');
    run(sim, 60);
    expect(sim.sectorAircraft().length).toBeGreaterThan(0);
  });
});

describe('delegated airspace', () => {
  // ARGES with a box delegated to it from a neighbour (FL300-FL660) and one delegated away (FL245-FL660)
  const raw = variant(r => {
    const arg = r.sectors.sectors.find(s => s.id === 'ARG');
    arg.include = [{ from: 'Test ACC', poly: box(43.30, 26.0, 43.50, 26.4), lower: 'FL 300', upper: 'FL 660', note: 'test' }];
    arg.exclude = [{ to: 'Other ACC', poly: box(44.40, 26.3, 44.60, 26.6), lower: 'FL 245', upper: 'FL 660' }];
  });
  const X = loadCountry(raw), arg = X.sectors.ARG;
  const inc = X.proj.toNM(43.4, 26.2), exc = X.proj.toNM(44.5, 26.45);

  it('an included area is part of the sector only within its own band', () => {
    expect(inSector(inc, arg, 350)).toBe(true);
    expect(inSector(inc, arg, 250)).toBe(false);
    expect(arg.vol.include[0]).toMatchObject({ unit: 'Test ACC', lower: 300, upper: 660 });
  });
  it('an excluded area is cut out only within its own band', () => {
    expect(inSector(exc, arg, 350)).toBe(false);
    expect(inSector(exc, arg, 200)).toBe(true);
    expect(inSector(exc, X.sectors.DNR, 350)).toBe(false); // and from collapsed configurations using ARGES
  });
  it('without a level, the lateral footprint: own polygon and included areas', () => {
    expect([inSector(inc, arg), inSector(exc, arg)]).toEqual([true, true]);
    expect(arg.polys).toHaveLength(2);
    expect(X.sectors.FIR.polys).toContain(arg.vol.include[0].poly);
  });
  it('a delegation must name its unit and give its own band', () => {
    const bad = change => () => loadCountry(variant(r => change(r.sectors.sectors.find(s => s.id === 'ARG'))));
    expect(bad(s => { s.include = [{ poly: box(43.3, 26, 43.5, 26.4), lower: 'FL 300', upper: 'FL 660' }]; })).toThrow(/Sector ARG include 1: name the unit it is delegated from/);
    expect(bad(s => { s.exclude = [{ to: 'X', poly: box(43.3, 26, 43.5, 26.4), lower: 'FL 300' }]; })).toThrow(/Sector ARG exclude 1: give the delegation's own lower and upper limits/);
  });
  it('a session follows the delegation: an aircraft in the excluded area above FL245 is not ours', () => {
    const sim = session(X, 'ARG');
    sim.ac = [];
    const a = sim.initKinematics(sim.makeAircraft({ cs: 'DLG1', type: 'A320', x: exc[0], y: exc[1], fl: 350, cfl: 350, sfl: 350, route: [{ id: 'E', xy: [exc[0] + 1, exc[1] - 300] }] }));
    sim.ac.push(a); sim.step();
    expect(a.lastIn).toBe(false);
  });
});

describe('several source AIPs', () => {
  it('a single-state module lists its own eAIP', () => {
    expect(C.aips).toEqual([{ state: 'Romania', url: RO.meta.sources[0].url, edition: RO.meta.airac.edition, amendment: RO.meta.airac.enr41 }]);
  });
  it('meta.aips lists each state with its own eAIP, edition and amendment', () => {
    const aips = [
      { state: 'Romania', url: 'https://aisro.ro/', edition: '2026-10-29', amendment: 'AIRAC AMDT 11/26' },
      { state: 'Bulgaria', url: 'https://example.invalid/bg', edition: '2026-10-01', amendment: 'AIRAC AMDT 10/26' }
    ];
    expect(loadCountry(variant(r => { r.meta.aips = aips; })).aips).toEqual(aips);
  });
  it('each entry needs state, url, a dated edition and the amendment', () => {
    const bad = aips => () => loadCountry(variant(r => { r.meta.aips = aips; }));
    expect(bad([])).toThrow(/list at least one source AIP/);
    expect(bad([{ state: 'X', url: 'u', edition: '2026-10-01' }])).toThrow(/meta.aips\[0\]: missing amendment/);
    expect(bad([{ state: 'X', url: 'u', edition: '29 OCT 2026', amendment: 'a' }])).toThrow(/edition "29 OCT 2026" is not a date/);
  });
});

describe('upper-airspace-only unit', () => {
  // ARGES from FL245 up, LROP controlled below by a lower unit
  const lowerUnit = { name: 'Test ACC', handoffNM: 60, arrFL: 250, depFL: 260 };
  const upperRaw = (L = lowerUnit) => variant(r => {
    r.meta.upperOnly = { lowerLimit: 'FL 245', lowerUnit: 'Test ACC' };
    r.sectors.sectors = r.sectors.sectors.filter(s => s.id !== 'KOM1'); // below the unit
    r.sectors.collapsed.find(k => k.id === 'KOM').parts = ['KOM2'];
    for (const s of r.sectors.sectors) s.lower = 'FL 245';
    r.traffic.mainAirports = r.traffic.mainAirports.map(({ approach, handoffNM, ...m }) => ({ ...m, lowerUnit: L }));
  });
  const U = loadCountry(upperRaw()), apt = U.mainAirports.LROP;

  it('the airport is handed to and taken from the named lower unit, not an approach unit', () => {
    expect(U.upperOnly).toEqual({ lowerFL: 245, lowerUnit: 'Test ACC' });
    expect(apt).toMatchObject({ unit: 'Test ACC', handoffNM: 60, lower: { arrFL: 250, depFL: 260 } });
    expect(apt.approach).toBeUndefined();
  });
  it('the loader rejects an approach unit or an incomplete lower unit', () => {
    expect(() => loadCountry(variant(r => { r.meta.upperOnly = { lowerLimit: 'FL 245' }; }))).toThrow(/LROP: an upper-airspace unit has no approach unit/);
    expect(() => loadCountry(upperRaw({ ...lowerUnit, depFL: 240 }))).toThrow(/LROP: lowerUnit needs .*depFL \(above FL245\)/);
    expect(() => loadCountry(variant(r => { r.meta.upperOnly = {}; }))).toThrow(/give the unit's lower limit/);
  });
  it('departures appear at the hand-off boundary climbing through the lower limit to the agreed level', () => {
    const sim = session(U, 'ARG');
    sim.ac = [];
    // one that stays under the sector's footprint for the next 2 minutes, so the climb takes it in
    let dep = null, a = null;
    for (let i = 0; i < 400 && !a; i++) {
      const p = sim.planFlight({ mustCross: sim.sector });
      if (!p || p.cat !== 'dep') continue;
      const b = sim.spawnFromPlan(p, 0);
      if (sim.lookAhead(b, 120, 10, (s, q) => !inSector(q, sim.sector)).s === null) { dep = p; a = b; } else sim.ac.pop();
    }
    expect(a).toBeTruthy();
    expect(dist(dep.start, apt.xy)).toBeCloseTo(60, 5);
    expect([a.fl, a.cfl]).toEqual([235, 260]);
    expect(a.lastIn).toBe(false); // below the sector until it climbs through FL245
    sim.computeInbound();
    expect(a.inbound).toBe(true); // the look-ahead sees the climb take it in: the lower unit transfers it
    expect(a.ctl).toBe('pend');
    run(sim, 60);
    expect(a.fl).toBeGreaterThan(245);
    expect(a.lastIn).toBe(true);
  });
  it('arrivals have the agreed level as exit level, ask for it and go to the lower unit at its boundary', () => {
    const sim = session(U, 'ARG');
    sim.ac = [];
    const p = [apt.xy[0] + 62, apt.xy[1]];
    const a = sim.initKinematics(sim.makeAircraft({ cs: 'ARR1', type: 'A320', cat: 'arr', x: p[0], y: p[1], fl: 250, cfl: 250, sfl: 250, route: [{ id: 'LROP', xy: apt.xy }], entry: 'X', exit: 'LROP' }));
    a.xfl = sim.xflOf(a); a.ctl = 'xfer';
    sim.ac.push(a);
    expect(a.xfl).toBe(250);
    run(sim, 60);
    expect(sim.ac).not.toContain(a);
    expect(sim.logs.some(l => l.text === 'ARR1 transferred to Test ACC')).toBe(true);
  });
  it('an emergency descending below the lower limit goes to the lower unit', () => {
    const sim = session(U, 'ARG');
    const a = sim.ac.find(x => x.lastIn);
    a.emg = true; a.fl = 245.5; a.cfl = a.sfl = 100;
    run(sim, 5);
    expect(sim.logs.some(l => l.text === `${a.cs} below FL245, transferred to Test ACC`)).toBe(true);
  });
});
