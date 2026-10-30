#!/usr/bin/env node
// AIRAC update. Downloads ENR 4.1 and the ENR 4.4 significant points for an
// eAIP edition, parses them, and reports what changed against data/<CODE>.
// Nothing is written unless --write is given.
//
//   npm run airac                                  # Romania, current cycle, report only
//   npm run airac -- --country HU                  # Hungary, edition in force today
//   npm run airac -- --edition 2026-10-29          # a specific eAIP edition
//   npm run airac -- --country HU --date 2026-11-26  # Hungary, edition in force on a date
//   npm run airac -- --write                       # apply coordinate/role changes and add new points
//
// Romania: ROMATSA eAIP PDFs (ENR 4.1, ENR 4.4), a new edition every AIRAC cycle.
// Hungary: HungaroControl eAIP HTML (ENR 4.1, ENR 4.4.1), amended on some cycles only,
// so the edition in force is read from the eAIP index.
//
// Sector polygons are updated by hand (see README).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnr44, parseEnr41, parseLhEnr441, parseLhEnr41, lhEditionOn, htmlText, diffPoints, diffNavaids, airacDates } from './airac-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const code = (arg('--country') || 'RO').toUpperCase();
const write = args.includes('--write');
const today = arg('--date') || new Date().toISOString().slice(0, 10);

async function download(url, local) {
  if (fs.existsSync(local)) return;
  process.stdout.write(`Downloading ${url} … `);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}. Is this a published eAIP edition?`);
  fs.mkdirSync(path.dirname(local), { recursive: true });
  fs.writeFileSync(local, Buffer.from(await res.arrayBuffer()));
  console.log('ok');
}

async function pdfText(local) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(local)), useSystemFonts: true }).promise;
  let text = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    text += tc.items.map(it => it.str + (it.hasEOL ? '\n' : ' ')).join('') + '\n';
  }
  return text;
}

const COUNTRIES = {
  RO: {
    cache: ed => path.join(root, '.airac-cache', ed),
    async edition() { return { edition: arg('--edition') || airacDates(new Date(today))[0] }; },
    async fetch(ed, cache) {
      const base = `https://aisro.ro/aip/${ed}/DOCS/AIP/ENR/ENR4`;
      await download(`${base}/LR_ENR_4_1_en.pdf`, path.join(cache, 'ENR_4_1.pdf'));
      await download(`${base}/LR_ENR_4_4_en.pdf`, path.join(cache, 'ENR_4_4.pdf'));
      const [enr41, enr44] = await Promise.all([pdfText(path.join(cache, 'ENR_4_1.pdf')), pdfText(path.join(cache, 'ENR_4_4.pdf'))]);
      return { points: parseEnr44(enr44), navaids: parseEnr41(enr41) };
    },
    min: { points: 100, navaids: 10 },
    addRoles: ['E', 'X', 'EX'],
    updateMeta(meta, ed) {
      const old = meta.airac.edition;
      meta.airac.edition = ed.edition;
      for (const s of meta.sources) s.url = s.url.split(`/aip/${old}/`).join(`/aip/${ed.edition}/`);
    }
  },
  HU: {
    cache: ed => path.join(root, '.airac-cache', 'HU', ed),
    async edition() {
      const index = 'https://ais-en.hungarocontrol.hu/aip/';
      const res = await fetch(index);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${index}`);
      const text = htmlText(await res.text()).replace(/\s+/g, ' ');
      const want = arg('--edition');
      if (want) {
        const ed = lhEditionOn(text, want);
        if (!ed || ed.edition !== want) throw new Error(`No HungaroControl eAIP edition effective ${want}. The index lists AMDTs effective on: ${[...text.matchAll(/Effective date (\d{4}-\d{2}-\d{2})/g)].map(m => m[1]).join(', ')}. Use --date ${want} for the edition in force on that day.`);
        return ed;
      }
      const ed = lhEditionOn(text, today);
      if (!ed) throw new Error(`The HungaroControl eAIP index lists no edition in force on ${today}`);
      return ed;
    },
    async fetch(ed, cache) {
      const base = `https://ais-en.hungarocontrol.hu/aip/${ed}/${ed}-AIRAC/html/eAIP`;
      await download(`${base}/LH-ENR-4.1-en-HU.html`, path.join(cache, 'ENR_4_1.html'));
      await download(`${base}/LH-ENR-4.4.1-en-HU.html`, path.join(cache, 'ENR_4_4_1.html'));
      const txt = f => htmlText(fs.readFileSync(path.join(cache, f), 'utf8'));
      return { points: parseLhEnr441(txt('ENR_4_4_1.html')), navaids: parseLhEnr41(txt('ENR_4_1.html')) };
    },
    min: { points: 100, navaids: 5 },
    // data/HU keeps every point with an FRA role, so any new one is added
    addRoles: ['E', 'X', 'EX', 'L', 'I'],
    updateMeta(meta, ed) {
      const old = meta.airac.edition;
      meta.airac.edition = ed.edition;
      meta.airac.enr41 = `AIRAC AMDT ${ed.amdt}`;
      meta.airac.enr44 = `ENR 4.4.1, AIRAC AMDT ${ed.amdt}`;
      for (const s of meta.sources) { s.url = s.url.split(old).join(ed.edition); s.title = s.title.replace(/AIRAC AMDT \d{3}\/\d{4}/, `AIRAC AMDT ${ed.amdt}`); }
    }
  }
};

const K = COUNTRIES[code];
if (!K) { console.error(`Unknown --country ${code}. Known: ${Object.keys(COUNTRIES).join(', ')}`); process.exit(1); }
const dataDir = path.join(root, 'data', code);
const readJSON = f => JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8'));
const writeJSON = (f, o) => fs.writeFileSync(path.join(dataDir, f), JSON.stringify(o, null, 2) + '\n');

function print(title, d) {
  console.log(`\n${title}: ${d.changed.length} changed, ${d.removed.length} removed, ${d.added.length} new`);
  for (const c of d.changed) console.log('  ~', JSON.stringify(c));
  for (const r of d.removed) console.log('  -', r.id, '(no longer in the AIP)');
  for (const a of d.added) console.log('  +', a.id, a.pos, a.role || '');
}

let ed, parsedPts, parsedNav;
try {
  ed = await K.edition();
  ({ points: parsedPts, navaids: parsedNav } = await K.fetch(ed.edition, K.cache(ed.edition)));
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
const meta0 = readJSON('meta.json');
console.log(`${code} eAIP edition ${ed.edition}${ed.amdt ? ` (AIRAC AMDT ${ed.amdt})` : ''}: parsed ${parsedPts.length} significant points, ${parsedNav.length} VOR stations. data/${code} is on ${meta0.airac.edition}.`);
if (parsedPts.length < K.min.points || parsedNav.length < K.min.navaids) {
  console.error('Parsed far fewer items than expected. The page layout may have changed; check scripts/airac-lib.mjs.');
  process.exit(2);
}

const points = readJSON('points.json'), navaids = readJSON('navaids.json'), traffic = readJSON('traffic.json');
const dp = diffPoints(points, parsedPts, K.addRoles), dn = diffNavaids(navaids, parsedNav);
print('Significant points', dp);
print('VOR/DME', dn);

const referenced = new Set([...Object.values(traffic.gates).flatMap(g => g.pts), ...(traffic.mainAirports || []).flatMap(m => [...Object.values(m.arr), ...Object.values(m.dep)])]);
const blocked = dp.removed.filter(r => referenced.has(r.id));
if (blocked.length) console.log(`\n! Removed points still used by traffic.json: ${blocked.map(b => b.id).join(', ')}. Replace them there first.`);
const lostRole = dp.changed.filter(c => c.role && c.role[1] === null);
if (lostRole.length) console.log(`\n! No longer FRA relevant in the AIP: ${lostRole.map(c => c.id).join(', ')}. --write keeps their old role; drop them or reassign them in traffic.json by hand.`);

const changes = dp.changed.length + dp.removed.length + dp.added.length + dn.changed.length + dn.removed.length + dn.added.length;
if (write) {
  const byId = new Map(parsedPts.map(p => [p.id, p]));
  const keep = points
    .filter(p => byId.has(p.id) || referenced.has(p.id))
    .map(p => { const n = byId.get(p.id); return n ? { id: p.id, pos: n.pos, role: n.role || p.role } : p; });
  for (const a of dp.added) keep.push({ id: a.id, pos: a.pos, role: a.role });
  writeJSON('points.json', keep);
  const navById = new Map(parsedNav.map(n => [n.id, n]));
  writeJSON('navaids.json', navaids.map(n => { const p = navById.get(n.id); return p ? { ...n, pos: p.pos, freq: p.freq } : n; }));
  const meta = readJSON('meta.json');
  K.updateMeta(meta, ed);
  writeJSON('meta.json', meta);
  console.log(`\nWrote data/${code}/points.json, navaids.json and meta.json. Run \`npm test\` before committing.`);
} else if (changes) {
  console.log('\nRe-run with --write to apply.');
} else console.log(`\nNo changes. Data is current for this edition${meta0.airac.edition !== ed.edition ? ` (--write would only move meta.json from ${meta0.airac.edition} to ${ed.edition})` : ''}.`);
