#!/usr/bin/env node
// Turn the Vitest coverage summary into a shields.io endpoint badge.
// CI writes it next to the site on GitHub Pages, and the README badge reads it from there.
//
//   node scripts/coverage-badge.mjs [coverage/coverage-summary.json] [dist/coverage.json]
import fs from 'node:fs';
import path from 'node:path';

const [src = 'coverage/coverage-summary.json', out = 'dist/coverage.json'] = process.argv.slice(2);
const total = JSON.parse(fs.readFileSync(src, 'utf8')).total;
const pct = total.lines.pct, branches = total.branches.pct;
const color = pct >= 95 ? 'brightgreen' : pct >= 85 ? 'green' : pct >= 70 ? 'yellow' : 'red';
const badge = { schemaVersion: 1, label: 'coverage (sim, scenario)', message: `${Math.floor(pct)}% lines · ${Math.floor(branches)}% branches`, color };
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(badge) + '\n');
console.log(`${out}: ${badge.message}`);
