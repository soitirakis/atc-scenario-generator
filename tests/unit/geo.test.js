import { describe, it, expect } from 'vitest';
import { dms, makeProjection, pip, brg, angDiff, segInt, centroid, mulberry32, fmtFL, fmtT } from '../../src/geo.js';

describe('dms', () => {
  it('parses AIP coordinates', () => {
    const [lat, lon] = dms('462314N 0253920E');
    expect(lat).toBeCloseTo(46 + 23 / 60 + 14 / 3600, 6);
    expect(lon).toBeCloseTo(25 + 39 / 60 + 20 / 3600, 6);
  });
  it('accepts the no-space form used in the NM sector file', () => {
    expect(dms('442627N0260924E')).toEqual(dms('442627N 0260924E'));
  });
  it('handles southern and western hemispheres', () => {
    const [lat, lon] = dms('100000S 0200000W');
    expect(lat).toBe(-10); expect(lon).toBe(-20);
  });
  it('rejects malformed input', () => {
    expect(() => dms('46N 25E')).toThrow(/Bad AIP coordinate/);
  });
});

describe('projection', () => {
  it('round-trips and uses 60 NM per degree of latitude', () => {
    const p = makeProjection(45.9, 25);
    const [x, y] = p.toNM(46.9, 25);
    expect(x).toBeCloseTo(0, 9); expect(y).toBeCloseTo(-60, 9);
    const [lat, lon] = p.fromNM(...p.toNM(44.5, 26.1));
    expect(lat).toBeCloseTo(44.5, 9); expect(lon).toBeCloseTo(26.1, 9);
  });
});

describe('plane geometry', () => {
  const square = [[0, 0], [10, 0], [10, 10], [0, 10]];
  it('point in polygon', () => {
    expect(pip([5, 5], square)).toBe(true);
    expect(pip([15, 5], square)).toBe(false);
  });
  it('bearings: north is up (negative y), east is +x', () => {
    expect(brg([0, 0], [0, -1])).toBeCloseTo(0);
    expect(brg([0, 0], [1, 0])).toBeCloseTo(90);
    expect(brg([0, 0], [0, 1])).toBeCloseTo(180);
    expect(brg([0, 0], [-1, 0])).toBeCloseTo(270);
  });
  it('angDiff takes the short way round', () => {
    expect(angDiff(350, 10)).toBe(20);
    expect(angDiff(10, 350)).toBe(-20);
  });
  it('segment intersection', () => {
    const i = segInt([0, 0], [10, 10], [0, 10], [10, 0]);
    expect(i[0]).toBeCloseTo(5); expect(i[1]).toBeCloseTo(5);
    expect(segInt([0, 0], [1, 1], [5, 0], [6, 1])).toBeNull();
  });
  it('centroid of a square', () => {
    const c = centroid(square);
    expect(c[0]).toBeCloseTo(5); expect(c[1]).toBeCloseTo(5);
  });
});

describe('utilities', () => {
  it('seeded RNG is deterministic', () => {
    const a = mulberry32(42), b = mulberry32(42);
    for (let i = 0; i < 5; i++) expect(a()).toBe(b());
  });
  it('formats flight levels and times', () => {
    expect(fmtFL(95)).toBe('095');
    expect(fmtT(125)).toBe('02:05');
  });
});
