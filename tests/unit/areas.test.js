import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import RO from '../../data/RO/index.js';
import HU from '../../data/HU/index.js';
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
  it('Hungary: an area whose limits are in a new format is not dropped silently', () => {
    expect(() => parseLhEnr52(hu.replace('FL 285 / FL 245', 'FL 285 / 7500 M'))).toThrow(/could not read LHTRA31A/);
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

describe('ENR 5.2 parser: Hungary (HTML text)', () => {
  const areas = parseLhEnr52(fixture('lh-enr-5-2-excerpt.txt'));
  it('reads id, name, vertices, limits and activation', () => {
    expect(areas[0]).toEqual({
      id: 'LHTRA11A', name: 'PAPA ALPHA', type: 'TRA',
      lateral: ['472959N 0175015E', '472959N 0181529E', '471331N 0181507E', '471259N 0175900E'],
      upper: 'FL 125', lower: 'GND', activation: 'HX'
    });
    expect(areas[1]).toMatchObject({ id: 'LHTRA31A', name: 'UPPER WEST ALPHA', upper: 'FL 285', lower: 'FL 245' });
  });
  it('keeps an "along border" segment as written, even without a dash before it', () => {
    expect(areas[2].name).toBe('BVR EAST HIGH');
    expect(areas[2].lateral).toEqual(['470506N 0212808E', '471210N 0213301E', '472201N 0214313E', '474559N 0213339E', '473630N 0215230E', '472226N 0215659E', 'along border HUNGARY_ROMANIA', '465441N 0213704E', '465250N 0211310E']);
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
  for (const [raw, n] of [[RO, 270], [HU, 39]]) describe(raw.meta.code, () => {
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
    const C = loadCountry(HU), raw = HU.areas.areas.find(a => a.id === 'LHTRA53EH');
    const z = C.areas.find(a => a.id === 'LHTRA53EH');
    expect(z.poly.length).toBeGreaterThan(raw.lateral.length - 1);
    // without the border data the segment is just the straight line between its two points
    const straight = loadArea(raw, {}, C.proj);
    expect(straight.poly).toHaveLength(raw.lateral.length - 1);
  });
  it('a limit the AIP prints as "L280" is used as FL280', () => {
    expect(loadCountry(RO).areas.find(a => a.id === 'LRTRA41')).toMatchObject({ lower: 280, upper: 660 });
  });
});
