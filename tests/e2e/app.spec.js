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

test('session ends with a debrief', async ({ page }) => {
  await page.locator('#pausedStart').click();
  await page.evaluate(() => { const s = window.__sim; while (!s.ended) s.step(); });
  await expect(page.locator('#debrief')).toBeVisible();
  await expect(page.locator('#debStats .stat')).toHaveCount(9);
});
