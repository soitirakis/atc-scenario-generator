import { describe, it, expect } from 'vitest';
import { barsSvg, closestSvg, squaresSvg } from '../../src/charts.js';

const count = (s, re) => (s.match(re) || []).length;
const pts = vals => vals.map((v, k) => ({ label: `11-0${k + 1}`, value: v, title: `session ${k + 1}: ${v}` }));

describe('progress charts (inline SVG strings)', () => {
  it('bars: one bar per non-zero session, a tick for zero, value and date on each, a hover title on each', () => {
    const s = barsSvg(pts([2, 0, 1]), 'Losses of separation per session');
    expect(s).toMatch(/^<svg class="ch" viewBox="0 0 300 96" role="img" aria-label="Losses of separation per session">/);
    expect(count(s, /class="ch-bar"/g)).toBe(2);
    expect(count(s, /class="ch-zero"/g)).toBe(1);
    expect(count(s, /<title>/g)).toBe(3);
    for (const t of ['>2<', '>0<', '>1<', '>11-01<', '>11-03<', '<title>session 2: 0</title>']) expect(s, t).toContain(t);
  });
  it('bars scale to the largest value: it is the tallest, from the baseline', () => {
    const s = barsSvg(pts([4, 2]), 'x'), h = [...s.matchAll(/class="ch-bar" x="[\d.]+" y="([\d.]+)" width="[\d.]+" height="([\d.]+)"/g)].map(m => [+m[1], +m[2]]);
    expect(h[0][1]).toBeCloseTo(h[1][1] * 2, 1);
    expect(h[0][0] + h[0][1]).toBeCloseTo(h[1][0] + h[1][1], 1); // same baseline
  });
  it('closest pair: a dot with its value where separation was lost, an open circle on the 5 NM line where not', () => {
    const s = closestSvg(pts([0.1, null, 3.2]), 'Closest pair per session');
    expect(count(s, /class="ch-dot"/g)).toBe(2);
    expect(count(s, /class="ch-open"/g)).toBe(1);
    expect(s).toContain('>5 NM<');
    expect(s).toContain('>0.1<');
    const ref = +s.match(/class="ch-ref" x1="[\d.]+" x2="[\d.]+" y1="([\d.]+)"/)[1], open = +s.match(/class="ch-open" cx="[\d.]+" cy="([\d.]+)"/)[1];
    expect(open).toBe(ref);
  });
  it('squares: met, partly met, not met, oldest first, each with its date', () => {
    const s = squaresSvg([{ savedAt: '2026-11-01T10:00:00Z', met: 0, graded: 1 }, { savedAt: '2026-11-02T10:00:00Z', met: 1, graded: 2 }, { savedAt: '2026-11-03T10:00:00Z', met: 2, graded: 2 }]);
    expect([...s.matchAll(/class="ch-sq ch-(\w+)"/g)].map(m => m[1])).toEqual(['miss', 'part', 'met']);
    expect(s).toContain('aria-label="not met, partly met, met"');
    expect(s).toContain('<title>2026-11-02: partly met (1/2)</title>');
    expect(squaresSvg([])).toContain('aria-label="no sessions"');
  });
  it('text is escaped', () => {
    expect(barsSvg([{ label: '<b>', value: 1, title: 'a & "b"' }], 'x<y')).toContain('aria-label="x&lt;y"');
    expect(barsSvg([{ label: '<b>', value: 1, title: 'a & "b"' }], 'x')).toContain('<title>a &amp; &quot;b&quot;</title>');
  });
});
