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
  expect(rec).toMatchObject({ kind: 'atc-session-record', schemaVersion: 2, trainee: 'Ana Pop', country: 'RO', sector: 'ARG', completed: true });
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

test('Download PDF from the debrief and from History; remarks and radar snapshots are kept with the session', async ({ page }, info) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await open(page, '/');
  await endSession(page);
  await page.locator('#debRemarks').fill('Good scan. Review the level bust.');
  await page.waitForTimeout(600); // remarks are saved shortly after typing

  const name = /^\d{4}-\d\d-\d\d_Ana-Pop_ARG\.pdf$/;
  const [a] = await Promise.all([page.waitForEvent('download'), page.locator('#debPdf').click()]);
  expect(a.suggestedFilename()).toMatch(name);
  const fa = info.outputPath('debrief.pdf'); await a.saveAs(fa);
  const pdf = fs.readFileSync(fa);
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  expect(pdf.length).toBeGreaterThan(20_000); // with radar snapshots
  await page.locator('#debClose').click();

  await page.reload();
  await fontsReady(page);
  const rows = await history(page);
  const [b] = await Promise.all([page.waitForEvent('download'), rows.first().locator('[data-h="pdf"]').click()]);
  expect(b.suggestedFilename()).toBe(a.suggestedFilename());
  await expect(page.locator('#histMsg')).toContainText(`Downloaded ${a.suggestedFilename()}`);

  await rows.first().locator('[data-h="open"]').click();
  await expect(page.locator('#debRemarks')).toHaveValue('Good scan. Review the level bust.');
  const [j] = await Promise.all([page.waitForEvent('download'), page.locator('#debExport').click()]);
  const fj = info.outputPath('record.json'); await j.saveAs(fj);
  const rec = JSON.parse(fs.readFileSync(fj, 'utf8'));
  expect(rec).toMatchObject({ schemaVersion: 2, remarks: 'Good scan. Review the level bust.' });
  expect(rec.snapshots.length).toBeGreaterThan(0);
  expect(rec.snapshots[0]).toMatchObject({ kind: expect.stringMatching(/^(inject|los)$/), image: expect.stringMatching(/^data:image\/jpeg;base64,/) });
  expect(errors).toEqual([]);
});

test('Progress: per trainee from the stored sessions, weakest objectives and charts; the PDF can add a progress page', async ({ page }, info) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await open(page, '/');
  const records = JSON.parse(fs.readFileSync(new URL('../fixtures/progress-records.json', import.meta.url), 'utf8'));
  const file = info.outputPath('progress.json');
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, kind: 'atc-session-records', records }));
  await page.locator('#tab-history').click();
  await page.locator('#histFile').setInputFiles(file);
  await expect(page.locator('#histMsg')).toContainText('Imported 8 sessions');

  await page.locator('#histSeg [data-v="progress"]').click();
  await expect(page.locator('#histList')).toBeHidden();
  await expect(page.locator('#progTrainee option')).toHaveText(['ANA POP (6 sessions)', 'Ion Rusu (1 session)', 'No trainee name (1 session)']);
  await expect(page.locator('#progWeak li')).toHaveCount(3);
  await expect(page.locator('#progWeak li').first()).toHaveText(/^Assume on time: every flight assumed before it enters\. Met 2 of 6 sessions \(33%\)/);
  await expect(page.locator('#progWeak li').nth(2)).toContainText('Level bust');
  await expect(page.locator('.prog-list li')).toHaveCount(7); // 3 inject types, 4 standing objectives
  await expect(page.locator('.prog-list li[data-obj="LEVEL_BUST"] .prog-nums')).toHaveText('6 sessions · met 3/6 (50%) · median 45 s · getting worse');
  await expect(page.locator('#progBody svg.ch')).toHaveCount(5);
  await expect(page.locator('#progBody svg.ch').first().locator('title').first()).toHaveText(/^2026-11-01 · .*: 2 losses of separation$/);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.locator('#progTrainee').selectOption('ion rusu');
  await expect(page.locator('#progWeak')).toHaveText(/^None yet/);

  // the newest of Ana's sessions as PDF, without and with the progress page
  const pages = async () => {
    const [d] = await Promise.all([page.waitForEvent('download'), page.locator('#histList .hist-row').first().locator('[data-h="pdf"]').click()]);
    const f = info.outputPath(`p${Date.now()}.pdf`); await d.saveAs(f);
    return (fs.readFileSync(f, 'latin1').match(/\/Type \/Page[^s]/g) || []).length;
  };
  await page.locator('#histSeg [data-v="sessions"]').click();
  await expect(page.locator('#histList .hist-row').first()).toContainText('ANA POP');
  const without = await pages();
  await page.locator('#pdfProgress').check();
  const withProgress = await pages();
  expect(withProgress).toBe(without + 1);
  expect(errors).toEqual([]);
});

test('Suggest next scenario: shown with its reasons, editable, loaded only on Accept', async ({ page }, info) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await open(page, '/');
  const records = JSON.parse(fs.readFileSync(new URL('../fixtures/progress-records.json', import.meta.url), 'utf8'));
  const file = info.outputPath('progress.json');
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, kind: 'atc-session-records', records }));
  await page.locator('#tab-history').click();
  await page.locator('#histFile').setInputFiles(file);
  await page.locator('#histSeg [data-v="progress"]').click();
  const before = await page.evaluate(() => ({ sector: window.__sim.scenario.sector, seed: window.__sim.scenario.seed }));

  await page.locator('#progSuggest').click();
  await expect(page.locator('#sgWhy li')).toHaveCount(5);
  await expect(page.locator('#sgWhy li[data-rule="sector"]')).toHaveText('Sector. BACAU: not flown yet; the last session was in ARGES.');
  await expect(page.locator('#sgWhy li[data-rule="difficulty"]')).toContainText('Stay at intermediate traffic');
  await expect(page.locator('#sgSector')).toHaveValue('BAC');
  await expect(page.locator('#sgDiff')).toHaveValue('intermediate');
  // nothing is loaded yet
  expect(await page.evaluate(() => ({ sector: window.__sim.scenario.sector, seed: window.__sim.scenario.seed }))).toEqual(before);

  // edit: more traffic, and an inject outside the session, which Accept refuses with the reason
  await page.locator('#sgDiff').selectOption('advanced');
  await page.locator('#sgInj .sg-min').first().fill('99');
  await page.locator('#sgAccept').click();
  await expect(page.locator('#sgErr')).toContainText('Inject 1 at minute 99 is outside the 20-minute session');
  expect(await page.evaluate(() => window.__sim.scenario.sector)).toBe(before.sector);
  await page.locator('#sgInj .sg-min').first().fill('5');
  await page.locator('#sgInj .sg-type').first().selectOption('EMERGENCY_DESCENT');
  await page.locator('#sgAccept').click();

  await expect(page.locator('#suggestBox')).toBeHidden();
  await expect(page.locator('#sector')).toHaveValue('BAC');
  await expect(page.locator('#difficulty')).toHaveValue('advanced');
  await expect(page.locator('#traineeName')).toHaveValue('ANA POP');
  const loaded = await page.evaluate(() => ({ t: window.__sim.t, injects: window.__sim.scenario.injects.map(i => [i.min, i.type]) }));
  expect(loaded.t).toBe(0);
  expect(loaded.injects).toContainEqual([5, 'EMERGENCY_DESCENT']);
  await page.locator('#tab-scenario').click();
  await expect(page.locator('#scnSource')).toHaveText('suggested from progress');

  // Discard closes it without loading anything
  await page.locator('#tab-history').click();
  await page.locator('#progSuggest').click();
  await page.locator('#sgDiscard').click();
  await expect(page.locator('#suggestBox')).toBeHidden();
  await expect(page.locator('#sector')).toHaveValue('BAC');
  expect(errors).toEqual([]);
});
