import { test, expect } from '@playwright/test';
import { open, fontsReady } from './load.js';
import fs from 'node:fs';

const finish = page => page.evaluate(() => { const s = window.__sim; while (!s.ended) s.step(); });
/** Fill the names, start, run `during` in the page (its result is returned), then run to the end: the page saves the record and shows the debrief. */
async function endSession(page, during = null, trainee = 'Ana Pop', instructor = 'I. Ionescu') {
  await page.locator('#traineeName').fill(trainee);
  await page.locator('#instructorName').fill(instructor);
  await page.locator('#pausedStart').click();
  const r = during && await page.evaluate(during);
  await finish(page);
  await expect(page.locator('#debrief')).toBeVisible();
  return r;
}
const history = async page => { await page.locator('#tab-history').click(); return page.locator('#histList .hist-row'); };

test('a finished session is saved, listed after a reload, re-opened with its debrief and replayed', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await open(page, '/');
  const seed = await page.evaluate(() => window.__sim.scenario.seed);
  await endSession(page);
  await expect(page.locator('#debClearances')).toBeEmpty(); // no clearances given
  await expect(page.locator('#debExport')).toBeVisible();
  await expect(page.locator('#debReplay')).toBeHidden();
  await page.locator('#debClose').click();
  await expect(await history(page)).toHaveCount(1);

  await page.reload();
  await fontsReady(page);
  const rows = await history(page);
  await expect(rows).toHaveCount(1);
  await expect(page.locator('#histStore')).toContainText('Saved in this browser only');
  await expect(rows.first()).toContainText('Ana Pop');
  await expect(rows.first()).toContainText('instructor I. Ionescu');
  await expect(rows.first()).toContainText(`RO ARGES · seed ${seed}`);
  await expect(rows.first()).toContainText(/objectives met|no graded injects/);

  await rows.first().locator('[data-h="open"]').click();
  await expect(page.locator('#debTitle')).toContainText('Session debrief ·');
  await expect(page.locator('#debStats .stat')).toHaveCount(12);
  await expect(page.locator('#debNotes')).toContainText('trainee Ana Pop, instructor I. Ionescu');
  await expect(page.locator('#debRestart')).toBeHidden();
  await page.locator('#debReplay').click();
  await expect(page.locator('#debrief')).toBeHidden();
  await page.locator('#tab-scenario').click();
  await expect(page.locator('#scnSource')).toHaveText('replayed from a saved session');
  await expect(page.locator('#seed')).toHaveValue(String(seed));
  expect(await page.evaluate(() => window.__sim.t)).toBe(0);
  await expect(page.locator('#traineeName')).toHaveValue('Ana Pop');
  expect(errors).toEqual([]);
});

test('export one and all, delete, then import them back; a bad file is refused', async ({ page }, info) => {
  await open(page, '/');
  // one clearance, so the clearance log has something in it
  const cs = await endSession(page, () => { const s = window.__sim, a = s.ac.find(x => x.ctl === 'ass'); s.clearLevel(a.id, a.cfl - 20); return a.cs; });
  await expect(page.locator('#debClearances')).toContainText('Clearances (');
  await expect(page.locator('#debClearances')).toContainText(`${cs} descend FL`);
  await page.locator('#debClose').click();
  const rows = await history(page);
  await expect(rows).toHaveCount(1);

  const [one] = await Promise.all([page.waitForEvent('download'), rows.first().locator('[data-h="export"]').click()]);
  expect(one.suggestedFilename()).toMatch(/^session-ro-arg-\d+-\d{4}-\d\d-\d\d-\d{4}\.json$/);
  const oneFile = info.outputPath('one.json'); await one.saveAs(oneFile);
  const rec = JSON.parse(fs.readFileSync(oneFile, 'utf8'));
  expect(rec).toMatchObject({ kind: 'atc-session-record', schemaVersion: 1, trainee: 'Ana Pop', country: 'RO', sector: 'ARG', completed: true });
  for (const k of ['scenario', 'stats', 'injects', 'timeline', 'clearances']) expect(rec, k).toHaveProperty(k);
  expect(rec.clearances[0]).toMatchObject({ cs, text: expect.stringMatching(/^descend FL\d{3}$/), result: 'ok' });

  const [all] = await Promise.all([page.waitForEvent('download'), page.locator('#histExportAll').click()]);
  expect(all.suggestedFilename()).toMatch(/^sessions-\d{4}-\d\d-\d\d\.json$/);
  const allFile = info.outputPath('all.json'); await all.saveAs(allFile);
  expect(JSON.parse(fs.readFileSync(allFile, 'utf8'))).toMatchObject({ kind: 'atc-session-records', records: [{ id: rec.id }] });

  // delete takes two clicks
  const del = rows.first().locator('[data-h="del"]');
  await del.click();
  await expect(del).toHaveText('Confirm delete');
  await del.click();
  await expect(page.locator('#histList .hist-row')).toHaveCount(0);
  await expect(page.locator('#histList')).toContainText('No sessions yet');

  await page.locator('#histFile').setInputFiles(allFile);
  await expect(page.locator('#histMsg')).toContainText('Imported 1 session from all.json.');
  await expect(page.locator('#histList .hist-row')).toHaveCount(1);
  await page.locator('#histFile').setInputFiles(oneFile); // the same record again replaces it
  await expect(page.locator('#histList .hist-row')).toHaveCount(1);

  const bad = info.outputPath('bad.json');
  fs.writeFileSync(bad, JSON.stringify({ ...rec, seed: 'x', clearances: 'none' }));
  await page.locator('#histFile').setInputFiles(bad);
  await expect(page.locator('#histMsg')).toContainText('Nothing was imported from bad.json');
  await expect(page.locator('#histMsg')).toContainText('seed must be a whole number');
  await expect(page.locator('#histList .hist-row')).toHaveCount(1);
});

test('without storage (private mode) the history says so, and the record can still be exported', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true }));
  await open(page, '/');
  await endSession(page);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#debExport').click()]);
  expect(dl.suggestedFilename()).toMatch(/^session-ro-arg-/);
  await page.locator('#debClose').click();
  await history(page);
  await expect(page.locator('#histStore')).toContainText('Session history is not available');
  await expect(page.locator('#histStore')).toContainText('only until this page closes');
  await expect(page.locator('#histList .hist-row')).toHaveCount(1); // kept for this page
});
