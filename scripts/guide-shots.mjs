#!/usr/bin/env node
// Regenerate the screenshots in docs/USER-GUIDE.md (docs/img/guide-*.png).
// Builds the app, serves dist/ with `vite preview`, and drives it with Playwright (Chromium).
//
//   npm run guide:shots
//
// Reproducible: every session is built with SEED in ARGES, the page clock is fixed to WHEN (dates in
// the debrief and history), the browser runs in UTC with en-GB formats, and the history and progress
// views use the test fixture records.
// While the clock runs, a scripted trainee works the traffic, as in scripts/screenshots.mjs.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'docs', 'img');
const PORT = 4181, URL = `http://localhost:${PORT}/`;
const VIEW = { width: 1280, height: 800 };
const SEED = 4127, WHEN = new Date('2026-11-14T09:00:00Z');
// times and number formats as in UTC and en-GB, whatever the machine's settings
const CTX = { viewport: VIEW, deviceScaleFactor: 1, timezoneId: 'UTC', locale: 'en-GB' };
const FIXTURE = path.join(root, 'tests', 'fixtures', 'progress-records.json');
const written = [];

function build() {
  const r = spawnSync('npx', ['vite', 'build'], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) throw new Error('build failed');
}

async function serve() {
  const srv = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(URL)).ok) return srv; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  srv.kill();
  throw new Error(`preview server did not start on ${URL}`);
}

/** Advance the paused session by `seconds`, working the traffic like a trainee would. */
const work = (page, seconds) => page.evaluate(seconds => {
  const s = window.__sim;
  for (let i = 0; i < seconds && !s.ended; i++) {
    for (const a of s.ac) {
      if (a.ctl === 'pend' || a.noXfer) s.assume(a.id);
      if (a.req && i % 7 === 0) s.answer(a.id, true);
      if (a.ctl !== 'ass' || a.tExit === null) continue;
      if (a.xfl !== null && Math.round(a.cfl) !== a.xfl && a.tExit <= 400 && !s.freqBusy()) s.clearLevel(a.id, a.xfl);
      if (a.tExit <= 45) s.transfer(a.id);
    }
    s.step();
  }
}, seconds);

const settle = page => page.waitForTimeout(1500); // the side panel refreshes twice a second; let it do so a few times

async function shot(page, name) {
  await settle(page);
  const f = `guide-${name}.png`;
  await page.screenshot({ path: path.join(out, f) });
  written.push(f);
}

/** A page at the fixed time, with the fonts loaded and the session built with SEED. */
async function open(context, url = URL) {
  const page = await context.newPage();
  await page.clock.setFixedTime(WHEN);
  await page.goto(url);
  await page.evaluate(() => document.fonts.ready);
  return page;
}
async function seeded(page, difficulty = 'advanced') {
  await page.locator('#difficulty').selectOption(difficulty);
  await page.locator('#tab-scenario').click();
  await page.locator('#seed').fill(String(SEED));
  await page.locator('#buildLocal').click();
  await page.locator('#tab-live').click();
}
/** Start, then freeze so the script drives the clock: both clicks in one task, so no frame runs the clock in between. */
const startFrozen = page => page.evaluate(() => { document.getElementById('pausedStart').click(); document.getElementById('playBtn').click(); });
/** Work the traffic for 2 minutes, then on until STCA predicts a conflict that is not yet a loss of separation (the script does not solve conflicts). */
async function toConflict(page) {
  await work(page, 120);
  for (let i = 0; i < 60; i++) {
    const ok = await page.evaluate(() => { const c = window.__sim.stca; return c.some(x => x.level === 'pred') && !c.some(x => x.level === 'los'); });
    if (ok) break;
    await work(page, 5);
  }
}
const selectBusy = page => page.evaluate(() => {
  const s = window.__sim, mine = s.ac.filter(a => a.ctl === 'ass' && a.lastIn);
  const pick = mine.find(a => a.xfl !== null && Math.round(a.cfl) !== a.xfl) || mine[0];
  if (pick) window.__radar.sel = pick.id;
  return pick && pick.id;
});
async function importFixture(page) {
  const records = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  await page.locator('#tab-history').click();
  await page.locator('#histFile').setInputFiles({ name: 'records.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ schemaVersion: 2, kind: 'atc-session-records', records })) });
}

async function solo(browser) {
  const context = await browser.newContext(CTX);
  const page = await open(context);
  await seeded(page);
  await page.locator('#traineeName').fill('Ana Pop');
  await page.locator('#instructorName').fill('I. Ionescu');
  await shot(page, 'start');

  await startFrozen(page);
  await toConflict(page);
  await selectBusy(page);
  await shot(page, 'radar');

  // command line: a clearance in shorthand, the readback, the busy frequency
  const cs = await page.evaluate(() => { const s = window.__sim; while (s.freqBusy()) s.step(); const a = s.ac.find(x => x.ctl === 'ass' && x.lastIn && !x.rcf); return a.cs; });
  await page.locator('#cmdLine').fill(`${cs} H090`);
  await page.locator('#cmdLine').press('Enter');
  await page.evaluate(() => { const s = window.__sim, tx = s.tx[s.tx.length - 1]; while (s.t < tx.t) s.step(); });
  await page.locator('#cmdLine').fill(`${cs} 370 S250`); // the next one, typed while the frequency is busy
  await shot(page, 'command');
  await page.locator('#cmdLine').fill('');

  // tools: an RBL and a SEP between the two assumed tracks that come closest, then a level probe
  const box = await page.locator('#scope').boundingBox();
  const pts = await page.evaluate(() => {
    const s = window.__sim, R = window.__radar, mine = s.ac.filter(a => a.ctl === 'ass' && a.lastIn);
    let best = null;
    for (const a of mine) for (const b of mine) {
      if (a.id >= b.id) continue;
      const va = s.groundVel(a), vb = s.groundVel(b), dx = b.x - a.x, dy = b.y - a.y, vx = (vb[0] - va[0]) / 3600, vy = (vb[1] - va[1]) / 3600;
      const t = Math.max(0, -(dx * vx + dy * vy) / (vx * vx + vy * vy || 1)), d = Math.hypot(dx + vx * t, dy + vy * t);
      if (Math.hypot(dx, dy) > 25 && (!best || d < best.d)) best = { d, pair: [a, b] };
    }
    return best.pair.map(m => ({ id: m.id, x: R.sx([m.x, m.y]), y: R.sy([m.x, m.y]) }));
  });
  const click = p => page.mouse.click(box.x + p.x, box.y + p.y);
  await page.locator('#toolRbl').click(); await click(pts[0]); await click(pts[1]);
  await page.locator('#toolSep').click(); await click(pts[0]); await click(pts[1]);
  await click(pts[0]);
  await page.locator('#bProbe').click();
  await page.locator('#probeOut').waitFor();
  await page.waitForTimeout(2000); // the tool's toast goes after 2.6 s
  await shot(page, 'tools');

  await page.locator('#tab-scenario').click();
  await shot(page, 'scenario');
  await page.locator('#tab-data').click();
  await shot(page, 'data');

  // run to the end: the record is saved and the debrief shown
  await page.locator('#toolClear').click();
  await page.locator('#tab-live').click();
  await work(page, 3600);
  await page.locator('#debrief').waitFor();
  await shot(page, 'debrief');
  await context.close();
}

async function history(browser) {
  const context = await browser.newContext(CTX);
  const page = await open(context);
  await importFixture(page);
  await page.locator('#histMsg').getByText('Imported').waitFor();
  await shot(page, 'history');
  await page.locator('#histSeg [data-v="progress"]').click();
  await shot(page, 'progress');
  await page.locator('#progSuggest').click();
  await page.locator('#suggestBox').waitFor();
  await page.locator('#suggestBox').scrollIntoViewIfNeeded();
  await shot(page, 'suggest');
  await context.close();
}

async function twoWindows(browser) {
  const context = await browser.newContext(CTX);
  const instr = await open(context, URL + '?role=instructor');
  const trainee = await open(context, URL + '?role=trainee');
  await seeded(instr);
  await startFrozen(instr);
  await toConflict(instr);
  await instr.evaluate(() => window.__sim.fireNow(0));
  await instr.locator('#tab-instr').click();
  await shot(instr, 'instructor');
  // the frozen instructor window still sends a snapshot every second
  await trainee.waitForFunction(t => window.__sim && window.__sim.t === t, await instr.evaluate(() => window.__sim.t));
  await shot(trainee, 'trainee');
  await context.close();
}

fs.mkdirSync(out, { recursive: true });
build();
const srv = await serve();
const browser = await chromium.launch();
try {
  await solo(browser);
  await history(browser);
  await twoWindows(browser);
} finally {
  await browser.close();
  srv.kill();
}
for (const f of written) console.log(`docs/img/${f}  ${(fs.statSync(path.join(out, f)).size / 1024).toFixed(0)} KB`);
