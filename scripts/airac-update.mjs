#!/usr/bin/env node
// AIRAC update for Romania. Downloads ENR 4.1 and ENR 4.4 from the ROMATSA
// eAIP for an edition date, parses them, and reports what changed against
// data/RO. Nothing is written unless --write is given.
//
//   npm run airac                          # current cycle, report only
//   npm run airac -- --edition 2026-10-29  # a specific eAIP edition
//   npm run airac -- --write               # apply coordinate/role changes and add new E/X points
//
// Sector polygons come from the EUROCONTROL NM sector file and are updated by
// hand when NM publishes a new one (see README).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnr44, parseEnr41, diffPoints, diffNavaids, airacDates } from './airac-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'data', 'RO');
const args = process.argv.slice(2);
const arg = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const edition = arg('--edition') || airacDates(new Date())[0];
const write = args.includes('--write');
const base = `https://aisro.ro/aip/${edition}/DOCS/AIP/ENR/ENR4`;
const cacheDir = path.join(root, '.airac-cache', edition);

async function pdfText(url, file) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const local = path.join(cacheDir, file);
  if (!fs.existsSync(local)) {
    process.stdout.write(`Downloading ${url} … `);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}. Is ${edition} a published eAIP edition?`);
    fs.writeFileSync(local, Buffer.from(await res.arrayBuffer()));
    console.log('ok');
  }
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

const readJSON = f => JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8'));
const writeJSON = (f, o) => fs.writeFileSync(path.join(dataDir, f), JSON.stringify(o, null, 2) + '\n');

function print(title, d) {
  console.log(`\n${title}: ${d.changed.length} changed, ${d.removed.length} removed, ${d.added.length} new`);
  for (const c of d.changed) console.log('  ~', JSON.stringify(c));
  for (const r of d.removed) console.log('  -', r.id, '(no longer in the AIP)');
  for (const a of d.added) console.log('  +', a.id, a.pos, a.role || '');
}

const [enr41, enr44] = await Promise.all([
  pdfText(`${base}/LR_ENR_4_1_en.pdf`, 'ENR_4_1.pdf'),
  pdfText(`${base}/LR_ENR_4_4_en.pdf`, 'ENR_4_4.pdf')
]);
const parsedPts = parseEnr44(enr44), parsedNav = parseEnr41(enr41);
console.log(`eAIP edition ${edition}: parsed ${parsedPts.length} significant points, ${parsedNav.length} VOR stations`);
if (parsedPts.length < 100 || parsedNav.length < 10) {
  console.error('Parsed far fewer items than expected. The PDF layout may have changed; check scripts/airac-lib.mjs.');
  process.exit(2);
}

const points = readJSON('points.json'), navaids = readJSON('navaids.json'), traffic = readJSON('traffic.json');
const dp = diffPoints(points, parsedPts), dn = diffNavaids(navaids, parsedNav);
print('Significant points', dp);
print('VOR/DME', dn);

const referenced = new Set([...Object.values(traffic.gates).flatMap(g => g.pts), ...Object.values(traffic.lrop.arr), ...Object.values(traffic.lrop.dep)]);
const blocked = dp.removed.filter(r => referenced.has(r.id));
if (blocked.length) console.log(`\n! Removed points still used by traffic.json: ${blocked.map(b => b.id).join(', ')}. Replace them there first.`);
const lostRole = dp.changed.filter(c => c.role && c.role[1] === null);
if (lostRole.length) console.log(`\n! No longer FRA relevant in the AIP: ${lostRole.map(c => c.id).join(', ')}. --write keeps their old role; drop them or reassign them in traffic.json by hand.`);

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
  meta.airac.edition = edition;
  writeJSON('meta.json', meta);
  console.log('\nWrote data/RO/points.json, navaids.json and meta.json. Run `npm test` before committing.');
} else if (dp.changed.length + dp.removed.length + dp.added.length + dn.changed.length + dn.removed.length + dn.added.length) {
  console.log('\nRe-run with --write to apply.');
} else console.log('\nNo changes. Data is current for this edition.');
