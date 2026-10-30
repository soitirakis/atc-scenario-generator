#!/usr/bin/env node
// Regenerate the README images: two screenshots and a short GIF of a running session.
// Builds the app, serves dist/ with `vite preview`, and drives it with Playwright (Chromium).
//
//   npm run screenshots        # writes docs/img/romania-arges-advanced.png, hungary-east.png, session.gif
//
// Sessions use the default seed, so the images are the same on every run. While the clock runs,
// a scripted trainee works the traffic (assume, re-clear to the exit level, transfer, answer
// requests) so the pictures show a sector being worked rather than one left alone.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import gifenc from 'gifenc';

const { GIFEncoder, quantize, applyPalette } = gifenc; // CommonJS package

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'docs', 'img');
const PORT = 4180, URL = `http://localhost:${PORT}/`;
const VIEW = { width: 1440, height: 900 };

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
  for (let i = 0; i < seconds; i++) {
    for (const a of s.ac) {
      if (a.ctl === 'pend' || a.noXfer) s.assume(a.id);
      if (a.req && i % 7 === 0) s.answer(a.id, true);
      if (a.ctl !== 'ass' || a.tExit === null) continue;
      if (a.xfl !== null && Math.round(a.cfl) !== a.xfl && a.tExit <= 400) s.clearLevel(a.id, a.xfl);
      if (a.tExit <= 45) s.transfer(a.id);
    }
    s.step();
  }
}, seconds);

const nextFrame = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

/**
 * Start the session, pause it, and work it until STCA predicts a conflict that has not yet become a
 * loss of separation (the scripted trainee does not solve conflicts). Then select a busy assumed aircraft.
 */
async function prepare(page, minSeconds) {
  await page.locator('#pausedStart').click();
  await page.locator('#playBtn').click();
  await work(page, minSeconds);
  for (let i = 0; i < 60; i++) {
    const ok = await page.evaluate(() => { const c = window.__sim.stca; return c.some(x => x.level === 'pred') && !c.some(x => x.level === 'los'); });
    if (ok) break;
    await work(page, 5);
  }
  await page.evaluate(() => {
    const s = window.__sim, mine = s.ac.filter(a => a.ctl === 'ass' && a.lastIn);
    const pick = mine.find(a => a.xfl !== null && Math.round(a.cfl) !== a.xfl) || mine[0];
    if (pick) window.__radar.sel = pick.id;
  });
  await page.waitForTimeout(700); // the side panel refreshes twice a second
}

async function screenshots(browser) {
  const page = await browser.newPage({ viewport: VIEW, deviceScaleFactor: 1 });
  await page.goto(URL);
  await page.locator('#difficulty').selectOption('advanced'); // Romania, ARGES by default
  await prepare(page, 120);
  await page.screenshot({ path: path.join(out, 'romania-arges-advanced.png') });

  await page.goto(URL);
  await page.locator('#country').selectOption('HU');           // Hungary, EAST by default
  await page.locator('#difficulty').selectOption('advanced');
  await prepare(page, 120);
  await page.screenshot({ path: path.join(out, 'hungary-east.png') });
  await page.close();
}

async function gif(browser) {
  const page = await browser.newPage({ viewport: VIEW, deviceScaleFactor: 1 });
  await page.goto(URL);
  await page.locator('#difficulty').selectOption('advanced');
  await page.locator('#pausedStart').click();
  await page.locator('#playBtn').click();
  await work(page, 60);
  const W = 800, H = 560, FRAMES = 60, STEP_S = 4; // one frame per radar refresh: 4 minutes of traffic
  const gifOut = GIFEncoder();
  let palette = null;
  for (let f = 0; f < FRAMES; f++) {
    await work(page, STEP_S);
    await nextFrame(page);
    const b64 = await page.evaluate(({ W, H }) => {
      const cv = document.getElementById('scope'), x = Math.max(0, (cv.width - W) / 2), y = Math.max(0, (cv.height - H) / 2);
      const d = cv.getContext('2d').getImageData(x, y, W, H).data;
      let s = '';
      for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode.apply(null, d.subarray(i, i + 0x8000));
      return btoa(s);
    }, { W, H });
    const rgba = new Uint8Array(Buffer.from(b64, 'base64'));
    palette ||= quantize(rgba, 128); // one palette for the whole clip keeps colours steady and the file small
    gifOut.writeFrame(applyPalette(rgba, palette), W, H, { palette: f === 0 ? palette : undefined, delay: 150 });
  }
  gifOut.finish();
  fs.writeFileSync(path.join(out, 'session.gif'), gifOut.bytes());
  await page.close();
}

fs.mkdirSync(out, { recursive: true });
build();
const srv = await serve();
const browser = await chromium.launch();
try {
  await screenshots(browser);
  await gif(browser);
} finally {
  await browser.close();
  srv.kill();
}
for (const f of ['romania-arges-advanced.png', 'hungary-east.png', 'session.gif']) {
  console.log(`docs/img/${f}  ${(fs.statSync(path.join(out, f)).size / 1024).toFixed(0)} KB`);
}
