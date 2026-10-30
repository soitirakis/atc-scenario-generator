import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.__errors = errors;
  await page.goto('/');
  await expect(page.locator('#pausedTag')).toBeVisible();
});
test.afterEach(async ({ page }) => {
  expect(page.__errors, 'uncaught page errors').toEqual([]);
});

test('loads Romania with a ready scenario and no horizontal overflow', async ({ page }) => {
  await expect(page.locator('#firTag')).toContainText('LRBB');
  await expect(page.locator('#sector option')).toHaveCount(14); // 9 + 4 collapsed + FIR
  await expect(page.locator('#injList .inj-row').first()).toBeVisible();
  await expect(page.locator('#debrief')).toBeHidden();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('start, run, select an aircraft and clear a level', async ({ page }) => {
  await page.locator('#pausedStart').click();
  await expect(page.locator('#playBtn')).toHaveText('Pause');
  // pause and advance the clock deterministically, so tracks stay put while we look for one
  await page.locator('#playBtn').click();
  await page.evaluate(() => { for (let i = 0; i < 120; i++) window.__sim.step(); });
  await page.waitForTimeout(100); // one frame to redraw
  // click the canvas on a grid until a track is selected (the same path a mouse click takes)
  const found = await page.evaluate(async () => {
    const cv = document.getElementById('scope'), r = cv.getBoundingClientRect();
    for (let y = 10; y < r.height; y += 6) for (let x = 10; x < r.width; x += 6) {
      const opts = { bubbles: true, clientX: r.left + x, clientY: r.top + y, pointerId: 1 };
      cv.dispatchEvent(new PointerEvent('pointerdown', opts));
      cv.dispatchEvent(new PointerEvent('pointerup', opts));
      if (document.querySelector('#acBox .ac-card')) return true;
    }
    return false;
  });
  expect(found).toBe(true);
  const cs = (await page.locator('#acBox .ac-head b').textContent()).trim();
  await page.locator('#cFl').selectOption('250');
  await page.locator('#bFl').click();
  await expect(page.locator('#log')).toContainText(`${cs} `);
  const cfl = await page.evaluate(cs => window.__sim.ac.find(a => a.cs === cs)?.cfl, cs);
  expect([250, undefined]).toContain(cfl); // undefined only if it left the sector meanwhile
});

test('instructor fires an inject and it lands in the priorities', async ({ page }) => {
  await page.locator('#pausedStart').click();
  await page.evaluate(() => { for (let i = 0; i < 30; i++) window.__sim.step(); });
  const before = await page.locator('#injList .tag.on').count();
  await page.locator('#injList button[data-fire]').first().click();
  await expect(page.locator('#injList .tag.on')).toHaveCount(before + 1);
});

test('scenario tab rebuilds the session for a new sector', async ({ page }) => {
  await page.locator('#tab-scenario').click();
  await page.locator('#sector').selectOption('DIN');
  await expect(page.locator('#secName')).toContainText('DINSI');
  await page.locator('#tab-scenario').click();
  await expect(page.locator('#scnCard h3')).toContainText('DINSI');
});

test('country selector switches to Hungary and back', async ({ page }) => {
  await page.locator('#country').selectOption('HU');
  await expect(page.locator('#firTag')).toContainText('LHCC');
  await expect(page.locator('#sector option')).toHaveCount(5); // 4 lateral sectors + FIR
  await expect(page.locator('#sector')).toHaveValue('EAST');
  await expect(page.locator('#pausedSub')).toContainText('EAST');
  await expect(page.locator('#airacTag')).toContainText('2026-09-03');
  const hu = await page.evaluate(() => ({ fir: window.__sim.C.meta.fir, ac: window.__sim.ac.length }));
  expect(hu).toEqual({ fir: 'LHCC', ac: 13 });
  await page.locator('#pausedStart').click();
  await page.evaluate(() => { for (let i = 0; i < 300; i++) window.__sim.step(); });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.locator('#country').selectOption('RO');
  await expect(page.locator('#firTag')).toContainText('LRBB');
  await expect(page.locator('#sector')).toHaveValue('ARG');
  await expect(page.locator('#sector option')).toHaveCount(14);
});

const nextFrame = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
const labels = page => page.evaluate(() => window.__radar.labelBoxes().map(l => {
  const a = window.__sim.get(l.id), R = window.__radar;
  return { id: l.id, box: l.box, off: [l.box[0] - R.sx([a.px, a.py]), l.box[1] - R.sy([a.px, a.py])] };
}));
const worstOverlap = ls => {
  let worst = 0, pair = null;
  for (let i = 0; i < ls.length; i++) for (let j = i + 1; j < ls.length; j++) {
    const [a, b] = [ls[i].box, ls[j].box];
    const w = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]), h = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
    const f = w > 0 && h > 0 ? (w * h) / Math.min(a[2] * a[3], b[2] * b[3]) : 0;
    if (f > worst) { worst = f; pair = [ls[i].id, ls[j].id]; }
  }
  return { worst, pair };
};

test('advanced ARGES: no two data blocks overlap by more than 20%', async ({ page }, info) => {
  // On the phone scope (about 378 px wide) ARGES tracks sit so close that even the best of the four
  // positions exceeds 20% at times, so there the test only guards against a badly broken layout.
  const limit = info.project.name === 'phone' ? 0.5 : 0.2;
  await page.locator('#difficulty').selectOption('advanced');
  await expect(page.locator('#pausedSub')).toContainText('ARGES');
  for (let k = 0; k < 10; k++) {
    if (k) await page.evaluate(() => { for (let i = 0; i < 60; i++) window.__sim.step(); });
    await nextFrame(page);
    const ls = await labels(page);
    expect(ls.length, 'labels drawn').toBeGreaterThan(5);
    const { worst, pair } = worstOverlap(ls);
    expect(worst, `minute ${k}: labels ${pair} overlap ${(worst * 100).toFixed(0)}%`).toBeLessThanOrEqual(limit);
  }
});

test('data blocks keep their position between radar updates', async ({ page }) => {
  await page.locator('#difficulty').selectOption('advanced');
  await page.evaluate(() => { const s = window.__sim; while (s.t % 4 !== 3) s.step(); }); // just before a radar refresh
  await nextFrame(page);
  const before = await labels(page);
  await page.evaluate(() => { window.__sim.step(); }); // radar refresh: plots move
  await nextFrame(page);
  const after = new Map((await labels(page)).map(l => [l.id, l.off]));
  const moved = before.filter(l => after.has(l.id) && after.get(l.id).join() !== l.off.join());
  expect(moved.length, `labels that changed side: ${moved.map(l => l.id)}`).toBeLessThanOrEqual(Math.ceil(before.length * 0.15));
});

test('a dragged data block stays where it was put', async ({ page }) => {
  await page.locator('#pausedStart').click();
  await page.locator('#playBtn').click(); // pause, so tracks only move when the test steps the sim
  await nextFrame(page);
  const box = await page.locator('#scope').boundingBox();
  // a label whose centre is on the canvas itself, not under an overlay or the layer chips
  const ls = await labels(page);
  const free = await page.evaluate(({ ls, bx, by }) => ls.filter(l => document.elementFromPoint(bx + l.box[0] + 50, by + l.box[1] + 20)?.id === 'scope').map(l => l.id), { ls, bx: box.x, by: box.y });
  const first = ls.find(l => free.includes(l.id));
  const [x, y] = [box.x + first.box[0] + 50, box.y + first.box[1] + 20];
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + 30, y + 40, { steps: 5 }); await page.mouse.up();
  await nextFrame(page);
  const want = [first.off[0] + 30, first.off[1] + 40];
  const off = async () => (await labels(page)).find(l => l.id === first.id).off.map(v => Math.round(v));
  expect(await off()).toEqual(want.map(v => Math.round(v)));
  await page.evaluate(() => { for (let i = 0; i < 40; i++) window.__sim.step(); }); // several radar updates
  await nextFrame(page);
  expect(await off()).toEqual(want.map(v => Math.round(v)));
  expect(await page.evaluate(() => window.__radar.sel)).toBe(null); // a drag is not a click
});

test('session ends with a debrief', async ({ page }) => {
  await page.locator('#pausedStart').click();
  await page.evaluate(() => { const s = window.__sim; while (!s.ended) s.step(); });
  await expect(page.locator('#debrief')).toBeVisible();
  await expect(page.locator('#debStats .stat')).toHaveCount(9);
});
