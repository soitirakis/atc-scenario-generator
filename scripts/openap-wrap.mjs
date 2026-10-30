#!/usr/bin/env node
// Convert OpenAP WRAP kinematic data into data/performance.json for every aircraft
// type used in data/*/traffic.json.
//
//   node scripts/openap-wrap.mjs
//
// Source: OpenAP (Junzi Sun et al., TU Delft), openap/data/wrap/*.txt at a pinned commit.
// OpenAP's code is LGPL-3.0; its data folder, which holds WRAP, is GPL-3.0. This repository
// is GPL-3.0 for that reason. BADA is not used: it needs a EUROCONTROL licence.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWrap } from './performance-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMMIT = '46753acb988c1e8c9d47ec5ae72d6fb75b9cf260'; // OpenAP master, 2026-06-18
const RAW = `https://raw.githubusercontent.com/TUDelft-CNS-ATM/openap/${COMMIT}/openap/data/wrap`;

// Our ICAO type -> WRAP model, with why. OpenAP's own table is openap/data/wrap/_synonym.csv.
const TYPE_MAP = {
  A320: ['a320', 'WRAP model for this type'],
  A20N: ['a320', 'OpenAP synonym (a20n -> a320)'],
  A321: ['a321', 'WRAP model for this type'],
  A21N: ['a321', 'same airframe size as the A321; OpenAP\'s synonym table maps a21n to a320'],
  A333: ['a333', 'WRAP model for this type'],
  A359: ['b789', 'OpenAP synonym (a359 -> b789)'],
  A388: ['a388', 'WRAP model for this type'],
  B738: ['b738', 'WRAP model for this type'],
  B38M: ['b738', 'same fuselage length as the 737-800; OpenAP\'s synonym table maps b38m to b737'],
  B77W: ['b77w', 'WRAP model for this type'],
  B788: ['b788', 'WRAP model for this type'],
  E195: ['e190', 'OpenAP synonym (e195 -> e190)'],
  BCS3: ['e190', 'not in OpenAP; nearest size class in WRAP']
};

const types = [...new Set(fs.readdirSync(path.join(root, 'data'), { withFileTypes: true })
  .filter(d => d.isDirectory() && fs.existsSync(path.join(root, 'data', d.name, 'traffic.json')))
  .flatMap(d => JSON.parse(fs.readFileSync(path.join(root, 'data', d.name, 'traffic.json'), 'utf8')).operators.flatMap(o => o.types)))].sort();
const missing = types.filter(t => !TYPE_MAP[t]);
if (missing.length) { console.error(`No WRAP mapping for: ${missing.join(', ')}. Add them to TYPE_MAP.`); process.exit(1); }

const models = {};
for (const m of [...new Set(types.map(t => TYPE_MAP[t][0]))].sort()) {
  const res = await fetch(`${RAW}/${m}.txt`);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${m}.txt`);
  models[m] = parseWrap(await res.text());
}

const out = {
  _note: 'Aircraft performance for the simulator, converted from OpenAP WRAP by scripts/openap-wrap.mjs. Each value is { opt, min, max } from WRAP (opt: typical; min/max: the range WRAP gives). Units: speeds in kt (CAS), Mach as a number, vertical rates in ft/min (positive), altitudes in ft. Not BADA. Not for operational use.',
  _source: {
    name: 'OpenAP: WRAP (Wide-Range Aircraft Performance) kinematic model',
    authors: 'Junzi Sun and contributors, TU Delft',
    url: `https://github.com/TUDelft-CNS-ATM/openap/tree/${COMMIT}/openap/data/wrap`,
    commit: COMMIT,
    licence: 'GPL-3.0 (openap/data/LICENSE). OpenAP code is LGPL-3.0.',
    reference: 'Sun, J., Hoekstra, J.M., Ellerbroek, J. (2020). OpenAP: An open-source aircraft performance model for air transportation studies and simulations. Aerospace, 7(8), 104.'
  },
  types: Object.fromEntries(types.map(t => [t, { wrap: TYPE_MAP[t][0], why: TYPE_MAP[t][1], ...models[TYPE_MAP[t][0]] }]))
};
fs.writeFileSync(path.join(root, 'data', 'performance.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`data/performance.json: ${types.length} types from ${Object.keys(models).length} WRAP models (${Object.keys(models).join(', ')})`);
