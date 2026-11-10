import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import RO from '../../data/RO/index.js';
import { parseLrEnr52, parseLhEnr52, limitToFL, diffAreas, checkLimit, KNOWN_LIMIT_TYPOS } from '../../scripts/airac-lib.mjs';
import { loadCountry, loadArea, limitFL, inSector } from '../../src/country.js';
import { dist, centroid } from '../../src/geo.js';

const fixture = f => fs.readFileSync(new URL(`../fixtures/${f}`, import.meta.url), 'utf8');

describe('ENR 5.2 parser: Romania (PDF text)', () => {
  const areas = parseLrEnr52(fixture('lr-enr-5-2-excerpt.txt'));
  const by = id => areas.find(a => a.id === id);

  it('finds every area in the excerpt, TRA and TSA', () => {
    expect(areas.map(a => [a.id, a.type])).toEqual([['LRTRA1G', 'TRA'], ['LRTRA41', 'TRA'], ['LRTRA100U', 'TRA'], ['LRTSA59', 'TSA']]);
  });
  it('keeps vertices and limits in AIP notation, without the closing vertex', () => {
    expect(by('LRTRA100U')).toEqual({
      id: 'LRTRA100U', name: null, type: 'TRA',
      lateral: ['445359N 0233344E', '443733N 0240409E', '442605N 0241220E', '443422N 0234004E'],
      upper: 'FL350', lower: 'FL280', activation: 'by NOTAM'
    });
    expect(by('LRTRA1G')).toMatchObject({ upper: '4500 FT AMSL', lower: 'GND' });
  });
  it('a limit printed as "L280" is kept as published and read as FL280, with a note', () => {
    expect(by('LRTRA41')).toMatchObject({ upper: 'FL660', lower: 'L280', lowerRead: 'FL280', note: 'AIP prints "L280"; read as FL280.' });
  });
  it('ignores the page header that falls inside an area', () => {
    expect(by('LRTRA41').lateral).toHaveLength(6);
  });
  it('a circle keeps its centre and radius; limits issued by NOTAM are null', () => {
    expect(by('LRTSA59')).toEqual({ id: 'LRTSA59', name: 'BUZĂU', type: 'TSA', circle: { centre: '450738N 0264745E', radiusNM: 6 }, upper: null, lower: null, activation: 'by NOTAM' });
  });
});

describe('ENR 5.2 parser: unrecognised limits fail', () => {
  const ro = fixture('lr-enr-5-2-excerpt.txt'), hu = fixture('lh-enr-5-2-excerpt.txt');
  it('Romania: a limit in a new format stops the parse, naming the area', () => {
    expect(() => parseLrEnr52(ro.replace('FL350\nFL280', 'FL350\n2500 M AMSL'))).toThrow(/unrecognised lower limit "2500 M AMSL" for LRTRA100U/);
    expect(() => parseLrEnr52(ro.replace('4500 FT AMSL', '4500FT'))).toThrow(/unrecognised upper limit "4500FT" for LRTRA1G/);
  });
  it('letter-code format: an area whose limits are in a new format is not dropped silently', () => {
    expect(() => parseLhEnr52(hu.replace('FL 285 / FL 245', 'FL 285 / 7500 M'))).toThrow(/could not read LHTRA92T/);
  });
  it('the three known AIP misprints are allowed, by area and side only', () => {
    expect(Object.keys(KNOWN_LIMIT_TYPOS)).toEqual(['LRTRA27L upper L200', 'LRTRA41 lower L280', 'LRTRA113B lower L280']);
    expect(checkLimit('LRTRA41', 'lower', 'L280')).toEqual({ value: 'L280', read: 'FL280' });
    expect(() => checkLimit('LRTRA41', 'upper', 'L280')).toThrow(/unrecognised/);
    expect(() => checkLimit('LRTRA42L', 'lower', 'L280')).toThrow(/unrecognised/);
    expect(() => parseLrEnr52(ro.replace('FL350\nFL280', 'FL350\nL280'))).toThrow(/LRTRA100U/);
  });
  it('an area that prints no vertical limits is read as such, with a note', () => {
    const text = ro.replace('Vertical limits are issued\nby NOTAM\n', '');
    expect(parseLrEnr52(text).find(a => a.id === 'LRTSA59')).toMatchObject({ upper: null, lower: null, note: 'No vertical limits published.' });
  });
});

// lh-enr-5-2-excerpt.txt is synthetic (invented areas) in the layout of the HungaroControl eAIP table
describe('ENR 5.2 parser: HTML table text', () => {
  const areas = parseLhEnr52(fixture('lh-enr-5-2-excerpt.txt'));
  it('reads id, name, vertices, limits and activation', () => {
    expect(areas[0]).toEqual({
      id: 'LHTRA91T', name: 'TEST ALPHA', type: 'TRA',
      lateral: ['010000N 0010000E', '010000N 0012000E', '005000N 0012000E', '005000N 0010500E'],
      upper: 'FL 125', lower: 'GND', activation: 'HX'
    });
    expect(areas[1]).toMatchObject({ id: 'LHTRA92T', name: 'TEST UPPER BRAVO', upper: 'FL 285', lower: 'FL 245' });
  });
  it('keeps an "along border" segment as written, even without a dash before it', () => {
    expect(areas[2].name).toBe('TEST BORDER HIGH');
    expect(areas[2].lateral).toEqual(['030000N 0030000E', '030500N 0030500E', '031000N 0031500E', '032000N 0031000E', '031500N 0032000E', '030800N 0032500E', 'along border HUNGARY_ROMANIA', '025500N 0032000E', '025000N 0030500E']);
  });
});

describe('vertical limits', () => {
  for (const f of [limitToFL, limitFL]) it(`${f.name} reads every form the AIPs use`, () => {
    expect(['FL350', 'FL 125', '4500 FT AMSL', '9500 FT ALT', '1017 FT MSL', 'GND', 'UNL', null, 'L280'].map(f)).toEqual([350, 125, 45, 95, 10.17, 0, 999, null, null]);
  });
});

describe('AIRAC diff for areas', () => {
  it('reports changed limits, removed and new areas', () => {
    const a = { id: 'A', lateral: ['1'], upper: 'FL350', lower: 'FL280', activation: 'by NOTAM' };
    const d = diffAreas([a, { ...a, id: 'B' }], [{ ...a, upper: 'FL360' }, { ...a, id: 'C' }]);
    expect(d.changed).toEqual([{ id: 'A', was: { upper: 'FL350', lower: 'FL280' }, now: { upper: 'FL360', lower: 'FL280' } }]);
    expect(d.removed.map(x => x.id)).toEqual(['B']);
    expect(d.added.map(x => x.id)).toEqual(['C']);
  });
});

describe('areas in the country data', () => {
  for (const [raw, n] of [[RO, 270]]) describe(raw.meta.code, () => {
    const C = loadCountry(raw);

    it(`loads all ${n} areas from areas.json, each a polygon inside the FIR`, () => {
      expect(C.areas).toHaveLength(n);
      for (const a of C.areas) {
        expect(a.poly.length, a.id).toBeGreaterThanOrEqual(3);
        expect(inSector(centroid(a.poly), C.sectors.FIR) || a.poly.some(p => inSector(p, C.sectors.FIR)), a.id).toBe(true);
      }
    });
    it('every limit is a flight level with upper above lower, or null when issued by NOTAM', () => {
      for (const a of C.areas) {
        if (a.upper === null) { expect(a.lower, a.id).toBeNull(); continue; }
        expect(a.upper, a.id).toBeGreaterThan(a.lower);
      }
    });
    it('the file says where it comes from', () => {
      expect(raw.areas._source.doc).toMatch(/ENR 5\.2/);
      expect(raw.areas._source.url).toMatch(/^https:\/\//);
    });
  });

  it('a circle becomes a 36-sided polygon of the published radius', () => {
    const C = loadCountry(RO), z = C.areas.find(a => a.id === 'LRTSA59');
    expect(z.poly).toHaveLength(36);
    const c = centroid(z.poly);
    for (const p of z.poly) expect(dist(p, c)).toBeCloseTo(6, 0);
  });
  it('an "along border" segment follows the border vertices between its published points', () => {
    // a test area along Romania's (approximated) border with Bulgaria, from a KOMAN corner to another
    const C = loadCountry(RO), raw = { id: 'TEST', name: 'TEST', type: 'TRA', lateral: ['440350N 0263945E', 'along border ROMANIA_BULGARIA', '434153N 0244148E', '441000N 0250000E'], upper: 'FL 300', lower: 'FL 100' };
    const z = loadArea(raw, RO.borders, C.proj);
    expect(z.poly.length).toBe(raw.lateral.length - 1 + RO.borders.KOMAN_BG.length);
    // without the border data the segment is just the straight line between its two points
    const straight = loadArea(raw, {}, C.proj);
    expect(straight.poly).toHaveLength(raw.lateral.length - 1);
  });
  it('a limit the AIP prints as "L280" is used as FL280', () => {
    expect(loadCountry(RO).areas.find(a => a.id === 'LRTRA41')).toMatchObject({ lower: 280, upper: 660 });
  });
});
