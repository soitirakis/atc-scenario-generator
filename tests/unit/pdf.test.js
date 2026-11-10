import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import RO from '../../data/RO/index.js';
import { loadCountry } from '../../src/country.js';
import { validateRecord, statRows, debriefOf } from '../../src/records.js';
import { buildDebriefPdf, pdfText, TRAINING_MARK } from '../../src/pdf.js';
import { fmtT } from '../../src/geo.js';

// A real session record exported from the app (RO ARGES, 20 min, seed 4127), with three of its
// radar snapshots re-encoded at 240 px to keep the file small, and instructor remarks added.
const fixture = JSON.parse(fs.readFileSync(new URL('../fixtures/session-record.json', import.meta.url), 'utf8'));
const countries = { RO: loadCountry(RO) };
/** The PDF uncompressed, so its text can be searched: jsPDF writes each line as "(text) Tj". */
const pdf = (rec, o = {}) => {
  const doc = buildDebriefPdf(rec, { compress: false, countryName: 'Romania', ...o });
  return { doc, out: doc.output(), pages: doc.getNumberOfPages() };
};
// WinAnsi bytes jsPDF writes for characters above Latin-1
const WINANSI = { '\x80': '€', '\x91': '‘', '\x92': '’', '\x93': '“', '\x94': '”', '\x95': '•', '\x96': '–', '\x97': '—' };
/** All text the PDF shows, lines joined by spaces (wrapping splits at spaces, so wrapped text reads back whole). */
const textOf = out => [...out.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)].map(m => m[1].replace(/\\(.)/g, '$1').replace(/[\x80-\x9f]/g, c => WINANSI[c] || c)).join(' ');
const has = (out, text) => textOf(out).includes(pdfText(text));
const count = (out, re) => (out.match(re) || []).length;

describe('the fixture record', () => {
  it('is a valid version 2 record with snapshots of injects and a loss of separation', () => {
    expect(validateRecord(fixture, countries).ok).toBe(true);
    expect(fixture.snapshots.map(s => s.kind)).toEqual(['inject', 'los', 'inject']);
  });
});

describe('PDF debrief', () => {
  const { doc, out, pages } = pdf(fixture);

  it('is a PDF of a stable number of A4 pages, every page marked as a training aid with its page number', () => {
    expect(out.startsWith('%PDF-')).toBe(true);
    expect(pages).toBe(4); // header, injects, stats and timeline; three snapshots; remarks and signatures
    expect(doc.internal.pageSize.getWidth()).toBeCloseTo(210, 0);
    expect(count(out, /\(Training aid, not an official assessment\) Tj/g)).toBe(pages + 1); // each footer, and the header
    for (let p = 1; p <= pages; p++) expect(has(out, `ATC Scenario Generator · page ${p} of ${pages}`), `page ${p}`).toBe(true);
  });
  it('header: scenario title, country, sector, date, seed, trainee and instructor', () => {
    for (const t of ['Session debrief', fixture.scenario.title, 'Romania (RO)', 'ARGES (ARG)', '2026-11-10 14:32 UTC', String(fixture.seed), 'Ana Pop', 'I. Ionescu', '20 min, intermediate traffic']) expect(has(out, t), t).toBe(true);
  });
  it('the objective and every success criterion', () => {
    expect(has(out, fixture.scenario.objective)).toBe(true);
    for (const c of fixture.scenario.criteria) expect(has(out, `•  ${c}`), c).toBe(true);
  });
  it('every inject with its objective, result, measured time and reason', () => {
    for (const i of fixture.injects) {
      expect(has(out, `${i.label}${i.target ? ` · ${i.target}` : ''}`), i.label).toBe(true);
      expect(has(out, i.objective), i.objective).toBe(true);
      if (i.result) expect(has(out, i.result.reason), i.result.reason).toBe(true);
      if (i.result) expect(has(out, i.result.state), i.result.state).toBe(true);
      if (i.result && i.result.t !== null) expect(has(out, `${i.result.t} s`)).toBe(true);
    }
  });
  it('the debrief statistics', () => {
    for (const [k, v] of statRows(debriefOf(fixture))) {
      expect(has(out, k.toUpperCase()), k).toBe(true);
      expect(has(out, String(v)), `${k} ${v}`).toBe(true);
    }
  });
  it('the event timeline', () => {
    for (const e of fixture.timeline) {
      expect(has(out, fmtT(e.t)), e.text).toBe(true);
      expect(has(out, e.text), e.text).toBe(true);
    }
  });
  it('one image per radar snapshot, each with its time and label', () => {
    expect(count(out, /\/Subtype \/Image/g)).toBe(fixture.snapshots.length);
    for (const s of fixture.snapshots) expect(has(out, `${fmtT(s.t)}  ${s.label}`), s.label).toBe(true);
  });
  it('the instructor remarks (accents outside the PDF fonts dropped) and signature lines for both', () => {
    expect(has(out, fixture.remarks)).toBe(true);
    expect(textOf(out)).toContain('Stefan to repeat with the same seed.');
    expect(has(out, 'Trainee: Ana Pop') && has(out, 'Instructor: I. Ionescu')).toBe(true);
    expect(count(out, /\(Signature and date\) Tj/g)).toBe(2);
  });
  it('compressed by default, and smaller', () => {
    const z = buildDebriefPdf(fixture).output();
    expect(z.length).toBeLessThan(out.length);
    expect(z).not.toContain('(Signature and date) Tj');
  });
});

describe('records without the optional parts', () => {
  it('no injects, snapshots, remarks or names: each section says so', () => {
    const rec = { ...fixture, injects: [], snapshots: [], timeline: [], remarks: '  ', trainee: '', instructor: '', completed: false, elapsedS: 600, sectorBand: 'FL245-FL660' };
    const { out, pages } = pdf(rec, { countryName: undefined });
    for (const t of ['No injects in this scenario.', 'No events.', 'No snapshots: none were taken in this session.', 'No remarks.', 'Trainee', 'Instructor', '20 min, intermediate traffic, ended early at 10:00', 'ARGES (ARG), FL245-FL660', 'RO']) expect(has(out, t), t).toBe(true);
    expect(pages).toBe(1);
    expect(count(out, /\/Subtype \/Image/g)).toBe(0);
  });
  it('a long timeline and many snapshots break across pages', () => {
    const rec = { ...fixture, timeline: Array.from({ length: 200 }, (_, i) => ({ t: i * 5, text: `Event ${i}`, cls: ['', 'a', 'w', 'ok'][i % 4] })), snapshots: Array(12).fill(fixture.snapshots[0]) };
    const { out, pages } = pdf(rec);
    expect(pages).toBeGreaterThan(8);
    expect(has(out, 'Event 199')).toBe(true);
    expect(has(out, `ATC Scenario Generator · page ${pages} of ${pages}`)).toBe(true);
  });
  it('an inject table longer than a page repeats its header', () => {
    const rec = { ...fixture, injects: Array(30).fill(fixture.injects[0]) };
    const { out } = pdf(rec);
    expect(count(out, /\(MEASURED\) Tj/g)).toBeGreaterThanOrEqual(2);
  });
});

describe('text for the PDF fonts', () => {
  it('keeps Latin-1 and WinAnsi, drops other accents, replaces what is left', () => {
    expect(pdfText('BUCUREȘTI · Ștefan Țăran — Győr, Zürich “ok” €5')).toBe('BUCURESTI · Stefan Taran — Gyor, Zürich “ok” €5');
    expect(pdfText('Ж → ✓')).toBe('? ? ?');
    expect(pdfText(null)).toBe('');
  });
});

describe('licence notices in the page', () => {
  // the minifier drops jsPDF's licence comment, so index.html carries it (and the font licences) itself
  const read = p => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
  const html = read('index.html');
  it("index.html has jsPDF's MIT licence for the installed version", () => {
    expect(html).toContain(read('node_modules/jspdf/LICENSE').trim());
    expect(html).toContain(`jsPDF ${JSON.parse(read('node_modules/jspdf/package.json')).version} (https://github.com/parallax/jsPDF)`);
  });
  it('and the copyright lines and the SIL Open Font License of both fonts', () => {
    expect(html).toContain('Copyright 2017 The Barlow Project Authors');
    expect(html).toContain('Copyright 2017 IBM Corp.');
    expect(html).toContain(read('src/fonts/OFL-IBMPlexMono.txt').split('\n').slice(2).join('\n').trim());
  });
});
