import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyRole, parseEnr44, parseEnr41, parseLhEnr441, lhRelevance, diffPoints, diffNavaids, airacDates } from '../../scripts/airac-lib.mjs';
import points from '../../data/RO/points.json';
import huPoints from '../../data/HU/points.json';
import navaids from '../../data/RO/navaids.json';

const fx = f => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', f), 'utf8');

describe('ENR 4.4 parsing', () => {
  const parsed = Object.fromEntries(parseEnr44(fx('enr44-excerpt.txt')).map(p => [p.id, p]));

  it('finds every point in the excerpt', () => {
    expect(Object.keys(parsed)).toEqual(['ABATU', 'ABOLO', 'ADINA', 'AKLEF', 'ARCAZ', 'BAGRI', 'CETUL', 'DIRER', 'MAVIT', 'OSTOV', 'PILAT', 'TALAM', 'KAJNA']);
    expect(parsed.ADINA.pos).toBe('434812N 0303018E');
  });

  it('classifies FRA relevance', () => {
    expect(parsed.ADINA.role).toBe('EX');
    expect(parsed.AKLEF.role).toBe('EX');   // "FRA (X) EVEN" without colon
    expect(parsed.BAGRI.role).toBe('E');
    expect(parsed.DIRER.role).toBe('X');
    expect(parsed.MAVIT.role).toBe('E');    // FL175-FL660 is upper
    expect(parsed.TALAM.role).toBe('X');
    expect(parsed.ARCAZ.role).toBe('L');    // E/X only FL105-FL175
    expect(parsed.OSTOV.role).toBe('L');    // FL165-FL175
    expect(parsed.PILAT.role).toBe('L');
    expect(parsed.CETUL.role).toBe('L');
    expect(parsed.ABOLO.role).toBe('I');
    expect(parsed.ABATU.role).toBeNull();
    expect(parsed.KAJNA.role).toBeNull();
  });

  it('the committed data agrees with the parser for every point in the excerpt', () => {
    for (const p of points) if (parsed[p.id]) {
      expect(p.pos, p.id).toBe(parsed[p.id].pos);
      expect(p.role, p.id).toBe(parsed[p.id].role);
    }
  });

  it('role rule edge case: upper entry plus lower exit is an entry', () => {
    expect(classifyRole('FRA (E): ODD FRA (X): FL105-FL175: EVEN')).toBe('E');
  });
});

describe('Hungary ENR 4.4.1 parsing', () => {
  const parsed = Object.fromEntries(parseLhEnr441(fx('lh-enr441-excerpt.txt')).map(p => [p.id, p]));

  it('finds every point in the excerpt', () => {
    expect(Object.keys(parsed)).toEqual(['ABETI', 'ABULI', 'ALAMU', 'ANIWE', 'ARSIN', 'BABIT', 'BABOX', 'BADOR', 'BAREB', 'DEGET', 'KOPRY', 'ODCIH', 'PARAK', 'VEBAL']);
    expect(parsed.KOPRY.pos).toBe('461425N 0165746E');
  });

  it('rewrites level-banded codes for classifyRole, 9500 FT AMSL as FL095', () => {
    expect(lhRelevance('(I) FL245-FL660 Nil (X) 9500 FT AMSL-FL245')).toBe('FRA (I) FL245-FL660 FRA (X) FL095-FL245');
    expect(lhRelevance('(EXA) Mandatory waypoint')).toBe('FRA (E) FRA (X) FRA (A)');
  });

  it('classifies FRA relevance with the same rule as Romania', () => {
    expect(parsed.ABETI.role).toBe('I');
    expect(parsed.BABIT.role).toBe('EX');
    expect(parsed.PARAK.role).toBe('EX');
    expect(parsed.ABULI.role).toBe('X');   // exit only up to FL245: above FL175, so not L
    expect(parsed.ALAMU.role).toBe('E');
    expect(parsed.BAREB.role).toBe('EX');  // (EXD) up to FL205
    expect(parsed.BADOR.role).toBe('L');   // exit only up to FL105
    expect(parsed.DEGET.role).toBe('L');   // entry only up to FL175
    expect(parsed.ODCIH.role).toBe('L');
    expect(parsed.ARSIN.role).toBe('I');   // (ID)
    expect(parsed.BABOX.role).toBeNull();  // departure connection only
    expect(parsed.ANIWE.role).toBeNull();  // no FRA relevance
  });

  it('reads four-letter codes such as (EXAD)', () => {
    // a {1,3} letter limit once read KOPRY and VEBAL as intermediate only
    expect(parsed.KOPRY.role).toBe('EX');
    expect(parsed.VEBAL.role).toBe('EX');
  });

  it('the committed Hungary data agrees with the parser for every point in the excerpt', () => {
    for (const p of huPoints) if (parsed[p.id]) {
      expect(p.pos, p.id).toBe(parsed[p.id].pos);
      expect(p.role, p.id).toBe(parsed[p.id].role);
    }
    for (const id of ['ANIWE', 'BABOX']) expect(huPoints.find(p => p.id === id), id).toBeUndefined();
  });
});

describe('ENR 4.1 parsing', () => {
  it('reads VOR/DME stations and skips DME-only entries', () => {
    const v = parseEnr41(fx('enr41-excerpt.txt'));
    expect(v.map(n => n.id)).toEqual(['ARD', 'BRV', 'STJ']);
    expect(v[0]).toEqual({ id: 'ARD', freq: '109.000', pos: '461103N 0210837E' });
  });
  it('the committed navaids agree with the excerpt', () => {
    for (const n of parseEnr41(fx('enr41-excerpt.txt'))) {
      const c = navaids.find(x => x.id === n.id);
      expect(c.pos).toBe(n.pos); expect(c.freq).toBe(n.freq);
    }
  });
});

describe('diffs', () => {
  it('reports moved, removed and new entry/exit points', () => {
    const cur = [{ id: 'AAAAA', pos: '450000N 0250000E', role: 'I' }, { id: 'BBBBB', pos: '450000N 0250000E', role: 'E' }];
    const par = [{ id: 'AAAAA', pos: '450001N 0250000E', role: 'I' }, { id: 'CCCCC', pos: '460000N 0260000E', role: 'X' }, { id: 'DDDDD', pos: '460000N 0260000E', role: 'I' }];
    const d = diffPoints(cur, par);
    expect(d.changed).toEqual([{ id: 'AAAAA', pos: ['450000N 0250000E', '450001N 0250000E'] }]);
    expect(d.removed.map(r => r.id)).toEqual(['BBBBB']);
    expect(d.added.map(r => r.id)).toEqual(['CCCCC']); // intermediate points are not auto-added
  });
  it('reports role changes, including a point that loses its FRA role', () => {
    const cur = [{ id: 'AAAAA', pos: 'p', role: 'I' }, { id: 'BBBBB', pos: 'p', role: 'E' }, { id: 'CCCCC', pos: 'p', role: 'L' }];
    const par = [{ id: 'AAAAA', pos: 'p', role: 'EX' }, { id: 'BBBBB', pos: 'p', role: null }, { id: 'CCCCC', pos: 'p', role: 'L' }];
    expect(diffPoints(cur, par).changed).toEqual([
      { id: 'AAAAA', role: ['I', 'EX'] },
      { id: 'BBBBB', role: ['E', null] }
    ]);
  });
  it('navaid frequency change is reported', () => {
    const d = diffNavaids([{ id: 'XXX', pos: 'p', freq: '110.000' }], [{ id: 'XXX', pos: 'p', freq: '110.200' }]);
    expect(d.changed).toHaveLength(1);
  });
});

describe('AIRAC calendar', () => {
  it('cycles every 28 days from 01 OCT 2026', () => {
    expect(airacDates(new Date(Date.UTC(2026, 9, 28)))).toEqual(['2026-10-01', '2026-10-29', '2026-11-26']);
    expect(airacDates(new Date(Date.UTC(2026, 9, 29)))[0]).toBe('2026-10-29');
    expect(airacDates(new Date(Date.UTC(2026, 8, 20)))[0]).toBe('2026-09-03');
  });
});
