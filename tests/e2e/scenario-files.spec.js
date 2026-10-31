import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const step = (page, s) => page.evaluate(s => { for (let i = 0; i < s; i++) window.__sim.step(); }, s);
const traffic = page => page.evaluate(() => window.__sim.ac.map(a => [a.cs, a.x.toFixed(6), a.y.toFixed(6), a.fl.toFixed(3)]));

test('export, reload, import: the same callsigns and positions after 120 simulated seconds', async ({ page }, info) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/?role=instructor');
  await page.locator('#tab-scenario').click();
  await page.locator('#seed').fill('7781');
  await page.locator('#buildLocal').click();
  await page.locator('#tab-scenario').click();

  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#scnExport').click()]);
  expect(download.suggestedFilename()).toBe('scenario-ro-arg-7781.json');
  const file = info.outputPath('exported.json');
  await download.saveAs(file);
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect(json).toMatchObject({ schemaVersion: 1, country: 'RO', sector: 'ARG', seed: 7781 });
  for (const k of ['difficulty', 'duration', 'objective', 'conflicts', 'wind', 'injects']) expect(json, k).toHaveProperty(k);
  expect(json.injects[0]).toHaveProperty('objective');

  await step(page, 120);
  const before = await traffic(page);
  expect(before.length).toBeGreaterThan(5);

  await page.reload();
  await page.locator('#tab-scenario').click();
  await page.locator('#seed').fill('1');
  await page.locator('#buildLocal').click(); // a different session, so the import has to replace it
  await page.locator('#tab-scenario').click();
  await page.locator('#scnFile').setInputFiles(file);
  await expect(page.locator('#scnSource')).toHaveText('imported from a file');
  expect(await page.evaluate(() => window.__sim.t)).toBe(0);
  await step(page, 120);
  expect(await traffic(page)).toEqual(before);
  expect(errors).toEqual([]);
});

test('a library scenario loaded in the instructor window reaches the trainee window', async ({ page, context }) => {
  await page.goto('/?role=instructor');
  const trainee = await context.newPage();
  await trainee.goto('/?role=trainee');
  await expect(page.locator('#roleTag')).toHaveText('INSTRUCTOR · linked');
  await expect(trainee.locator('#libSel')).toBeHidden(); // the trainee cannot load or export scenarios

  await page.locator('#tab-scenario').click();
  await page.locator('#libSel').selectOption('hu-east-intermediate');
  await page.locator('#libLoad').click();
  await expect(page.locator('#country')).toHaveValue('HU');
  await expect(page.locator('#sector')).toHaveValue('EAST');
  const callsigns = await page.evaluate(() => window.__sim.ac.map(a => a.cs).sort());
  await expect.poll(() => trainee.evaluate(() => window.__sim.C && window.__sim.C.meta.code), { timeout: 5000 }).toBe('HU');
  await expect.poll(() => trainee.evaluate(() => window.__sim.ac.map(a => a.cs).sort()), { timeout: 5000 }).toEqual(callsigns);
});

test('an invalid file is not loaded and the reasons are shown in plain words', async ({ page }, info) => {
  await page.goto('/');
  await page.locator('#tab-scenario').click();
  const before = await page.evaluate(() => window.__sim.ac.map(a => a.cs));
  const bad = info.outputPath('bad.json');
  fs.writeFileSync(bad, JSON.stringify({ schemaVersion: 1, country: 'RO', sector: 'ZZZ', difficulty: 'advanced', duration: 30, seed: 5, conflicts: 2, wind: [], injects: [{ min: 40, type: 'LEVEL_BUST', text: '' }, { min: 5, type: 'ENGINE_FIRE', text: '' }] }));
  await page.locator('#scnFile').setInputFiles(bad);
  const msg = page.locator('#scnIoMsg');
  await expect(msg).toBeVisible();
  await expect(msg).toContainText('This scenario was not loaded');
  await expect(msg).toContainText('Unknown sector "ZZZ" for Romania');
  await expect(msg).toContainText('Inject 1 at minute 40 is outside the 30-minute session');
  await expect(msg).toContainText('Inject 2: unknown type "ENGINE_FIRE"');
  expect(await page.evaluate(() => window.__sim.ac.map(a => a.cs))).toEqual(before);

  const notJson = info.outputPath('notes.json');
  fs.writeFileSync(notJson, 'not json');
  await page.locator('#scnFile').setInputFiles(notJson);
  await expect(msg).toContainText('notes.json is not a JSON file');
});
