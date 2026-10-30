import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWrapTable, parseWrap } from '../../scripts/performance-lib.mjs';
import PERF from '../../data/performance.json';
import RO from '../../data/RO/index.js';
import HU from '../../data/HU/index.js';
import { isa, casToMach, machToCas, casToTas, machToTas, tasToMach, windAt, normaliseWind, defaultWind } from '../../src/atmos.js';

// openap-wrap-a320.txt: OpenAP openap/data/wrap/a320.txt at commit 46753ac (GPL-3.0), unchanged.
const fixture = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'openap-wrap-a320.txt'), 'utf8');

describe('OpenAP WRAP conversion', () => {
  it('reads every row of the WRAP table with opt, min and max', () => {
    const r = parseWrapTable(fixture);
    expect(Object.keys(r)).toHaveLength(35); // every data row of the file
    expect(r.cl_vs_avg_mach_const).toEqual({ opt: 5.28, min: 3.6, max: 6.97 });
    expect(r.de_vs_avg_mach_const).toEqual({ opt: -5.76, min: -13.45, max: -2.26 });
  });

  it('converts to kt, ft/min and ft, keeping descent rates positive', () => {
    const p = parseWrap(fixture);
    expect(p.climb.casKt.opt).toBe(Math.round(151 * 1.943844));            // 294 kt
    expect(p.climb.fpm.mach).toEqual({ opt: 1039, min: 709, max: 1372 });   // 5.28 m/s etc.
    expect(p.climb.machFromFt.opt).toBe(Math.round(8.8 * 3280.84));         // 28871 ft
    expect(p.descent.fpm.mach).toEqual({ opt: 1134, min: 445, max: 2648 }); // magnitudes, min <= max
    expect(p.cruise.mach).toEqual({ opt: 0.78, min: 0.75, max: 0.8 });
  });

  it('refuses a table without the en-route rows', () => {
    expect(() => parseWrap(fixture.split('\n').filter(l => !l.startsWith('cl_v_mach_const')).join('\n'))).toThrow(/cl_v_mach_const/);
  });
});

describe('data/performance.json', () => {
  const types = [...new Set([RO, HU].flatMap(c => c.traffic.operators.flatMap(o => o.types)))];

  it('covers every aircraft type in the traffic files', () => {
    for (const t of types) expect(PERF.types[t], t).toBeTruthy();
  });

  it('keeps the source, commit and licence notice', () => {
    expect(PERF._source.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(PERF._source.licence).toMatch(/GPL-3\.0/);
    expect(PERF._source.url).toContain(PERF._source.commit);
    expect(PERF._note).toMatch(/Not BADA/);
  });

  // In OpenAP's own a333.txt the fitted cr_h_max has opt 12.53 km above max 12.48 km. Kept as published;
  // the simulator does not use maximum cruise altitude.
  const SOURCE_QUIRKS = new Set(['A333.cruise.maxFt']);
  it('every value lies inside its own range (bar one quirk in the source), and each mapping says why', () => {
    const walk = (o, where) => {
      if ('opt' in o) {
        expect(o.min, where).toBeLessThanOrEqual(o.max);
        if (!SOURCE_QUIRKS.has(where)) { expect(o.min, where).toBeLessThanOrEqual(o.opt); expect(o.opt, where).toBeLessThanOrEqual(o.max); }
        return;
      }
      for (const [k, v] of Object.entries(o)) if (v && typeof v === 'object') walk(v, `${where}.${k}`);
    };
    for (const [t, d] of Object.entries(PERF.types)) {
      expect(d.why, t).toMatch(/\S/);
      walk({ climb: d.climb, cruise: d.cruise, descent: d.descent }, t);
    }
  });
});

describe('ISA and airspeeds', () => {
  it('matches standard atmosphere reference values', () => {
    expect(isa(0).T).toBeCloseTo(288.15, 2);
    expect(isa(0).p).toBeCloseTo(101325, 0);
    expect(isa(0).a).toBeCloseTo(661.5, 1);          // kt
    expect(isa(36089).T).toBeCloseTo(216.65, 1);     // tropopause
    expect(isa(40000).a).toBeCloseTo(573.6, 1);      // constant above the tropopause
  });

  it('converts CAS, Mach and TAS like the textbook cases', () => {
    expect(casToTas(250, 10000)).toBeCloseTo(288.7, 0); // 250 KIAS at FL100
    expect(machToTas(0.8, 37000)).toBeCloseTo(458.9, 0);
    expect(casToMach(280, 30000)).toBeCloseTo(0.742, 2);
    expect(machToCas(casToMach(300, 25000), 25000)).toBeCloseTo(300, 6);
    expect(tasToMach(machToTas(0.78, 35000), 35000)).toBeCloseTo(0.78, 9);
    expect(casToMach(250, 0)).toBeCloseTo(250 / 661.47, 3); // at sea level CAS = TAS
  });
});

describe('wind field', () => {
  it('is the air velocity from the direction it blows from', () => {
    const [e, s] = windAt([{ fl: 300, dir: 270, kt: 50 }], 300);
    expect(e).toBeCloseTo(50, 9); expect(s).toBeCloseTo(0, 9);       // from the west: air moves east
    const [e2, s2] = windAt([{ fl: 300, dir: 360, kt: 40 }], 300);
    expect(e2).toBeCloseTo(0, 9); expect(s2).toBeCloseTo(40, 9);     // from the north: air moves south (+y)
  });

  it('interpolates between levels and holds the nearest level outside them', () => {
    const W = [{ fl: 100, dir: 270, kt: 20 }, { fl: 300, dir: 270, kt: 60 }];
    expect(windAt(W, 200)[0]).toBeCloseTo(40, 9);
    expect(windAt(W, 50)[0]).toBeCloseTo(20, 9);
    expect(windAt(W, 400)[0]).toBeCloseTo(60, 9);
    expect(windAt([], 300)).toEqual([0, 0]);
  });

  it('validates an edited wind table', () => {
    expect(normaliseWind([{ fl: 300, dir: 370, kt: 40 }, { fl: 100, dir: 90, kt: 10 }])).toEqual([{ fl: 100, dir: 90, kt: 10 }, { fl: 300, dir: 10, kt: 40 }]);
    expect(() => normaliseWind([{ fl: 300, dir: 90, kt: 400 }])).toThrow(/speed/);
    expect(() => normaliseWind([{ fl: 300, dir: 90, kt: 40 }, { fl: 300, dir: 0, kt: 10 }])).toThrow(/one entry per level/);
  });

  it('a scenario wind comes from its seed', () => {
    expect(defaultWind(4127)).toEqual(defaultWind(4127));
    expect(defaultWind(1)).not.toEqual(defaultWind(2));
    for (const w of defaultWind(7)) { expect(w.dir).toBeGreaterThanOrEqual(0); expect(w.dir).toBeLessThan(360); }
  });
});
