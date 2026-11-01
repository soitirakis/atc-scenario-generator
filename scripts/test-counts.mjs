#!/usr/bin/env node
// Test counts in docs/TEST-STRATEGY.md, taken from the test runners so they cannot go stale.
//
//   node scripts/test-counts.mjs           rewrite the counts in the table
//   node scripts/test-counts.mjs --check   exit 1 if the table and the real counts differ (CI)
//
// Unit tests: Vitest's JSON reporter (runs the suite). End-to-end tests: Playwright's --list with
// the JSON reporter (lists, does not run, needs no browser). Each row of the table between the
// test-counts markers is one test file; its description is kept, its count is replaced.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOC = path.join(root, 'docs', 'TEST-STRATEGY.md');
const START = '<!-- test-counts:start -->', END = '<!-- test-counts:end -->';
const npx = (args, opts = {}) => execFileSync('npx', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...opts });

/** { 'tests/unit/x.test.js': n } from the Vitest JSON reporter. */
export function unitCounts(json) {
  const out = {};
  for (const r of json.testResults) out[path.relative(root, r.name).split(path.sep).join('/')] = r.assertionResults.length;
  return out;
}
/** { 'tests/e2e/x.spec.js': tests per project } and the number of projects, from `playwright test --list --reporter=json`. */
export function e2eCounts(json) {
  // Playwright lists each test once per project: count each title and line once
  const seen = {}, projects = new Set();
  const walk = (suite, file) => {
    for (const spec of suite.specs || []) {
      (seen[file] ||= new Set()).add(`${spec.line}:${spec.title}`);
      for (const t of spec.tests || []) projects.add(t.projectName);
    }
    for (const s of suite.suites || []) walk(s, file);
  };
  for (const s of json.suites) walk(s, `tests/e2e/${s.file}`);
  return { counts: Object.fromEntries(Object.entries(seen).map(([f, set]) => [f, set.size])), projects: projects.size };
}

/** Replace the counts in the table; returns the new document and a list of problems. */
export function updateDoc(doc, unit, e2e) {
  const a = doc.indexOf(START), b = doc.indexOf(END);
  if (a < 0 || b < a) return { doc, problems: [`markers ${START} … ${END} not found`] };
  const real = { ...unit, ...e2e.counts }, seen = new Set(), problems = [];
  const lines = doc.slice(a + START.length, b).split('\n').map(line => {
    const m = /^\| `([^`]+)` \|(.*)\| (\d+)( × \d+ viewports)? \|$/.exec(line);
    if (m) {
      const [, file, mid] = m;
      seen.add(file);
      if (!(file in real)) { problems.push(`${file} is in the table but has no tests`); return line; }
      return `| \`${file}\` |${mid}| ${real[file]}${file.startsWith('tests/e2e/') ? ` × ${e2e.projects} viewports` : ''} |`;
    }
    const t = /^\| \*\*Total\*\* \|.*$/.exec(line);
    if (t) {
      const u = Object.values(unit).reduce((s, n) => s + n, 0), e = Object.values(e2e.counts).reduce((s, n) => s + n, 0);
      return `| **Total** | ${Object.keys(unit).length} unit files, ${Object.keys(e2e.counts).length} end-to-end files | ${u} unit, ${e} end-to-end × ${e2e.projects} viewports |`;
    }
    return line;
  });
  for (const file of Object.keys(real)) if (!seen.has(file)) problems.push(`${file} has ${real[file]} tests but no row in the table`);
  return { doc: doc.slice(0, a + START.length) + lines.join('\n') + doc.slice(b), problems };
}

async function main() {
  const check = process.argv.includes('--check');
  const tmp = path.join(os.tmpdir(), `vitest-${process.pid}.json`);
  try { npx(['vitest', 'run', '--reporter=json', `--outputFile=${tmp}`]); } catch (e) { if (!fs.existsSync(tmp)) throw e; } // failing tests still report
  const unit = unitCounts(JSON.parse(fs.readFileSync(tmp, 'utf8')));
  fs.rmSync(tmp, { force: true });
  const e2e = e2eCounts(JSON.parse(npx(['playwright', 'test', '--list', '--reporter=json'])));
  const doc = fs.readFileSync(DOC, 'utf8');
  const { doc: next, problems } = updateDoc(doc, unit, e2e);
  if (problems.length) { console.error(problems.map(p => '  ' + p).join('\n')); process.exit(1); }
  if (check) {
    if (next !== doc) { console.error('docs/TEST-STRATEGY.md test counts are out of date. Run `node scripts/test-counts.mjs` and commit the result.'); process.exit(1); }
    console.log('docs/TEST-STRATEGY.md test counts match the suites.');
  } else {
    fs.writeFileSync(DOC, next);
    console.log(next === doc ? 'Test counts already current.' : 'Updated the test counts in docs/TEST-STRATEGY.md.');
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
