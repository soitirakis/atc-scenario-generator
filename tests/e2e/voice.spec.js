import { test, expect } from '@playwright/test';
import { open } from './load.js';
import fs from 'node:fs';

// The browser's speech synthesis is replaced by a recorder: two local English voices, one online
// voice and one French voice (neither may be used). What would be spoken lands in window.__spoken.
const fakeSpeech = (voices = [{ name: 'Local A', lang: 'en-GB', localService: true }, { name: 'Local B', lang: 'en-US', localService: true }, { name: 'Online C', lang: 'en-US', localService: false }, { name: 'Local FR', lang: 'fr-FR', localService: true }]) => {
  window.__spoken = []; window.__cancels = 0;
  class U { constructor(text) { this.text = text; } }
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: U, configurable: true });
  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    value: { getVoices: () => voices, speak: u => window.__spoken.push({ text: u.text, rate: u.rate, volume: u.volume, pitch: u.pitch, voice: u.voice && u.voice.name, t: window.__sim && window.__sim.t }), cancel: () => { window.__cancels++; }, addEventListener() {} }
  });
};
const TEL = JSON.parse(fs.readFileSync(new URL('../../data/telephony.json', import.meta.url), 'utf8')).operators;
const DIG = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'niner'];
const said = cs => `${TEL[cs.slice(0, 3)].say} ${[...cs.slice(3)].map(d => DIG[+d]).join(' ')}`;
const level = fl => (fl % 100 ? `flight level ${[...String(fl).padStart(3, '0')].map(d => DIG[+d]).join(' ')}` : `flight level ${DIG[fl / 100]} hundred`);
/** A clearance to one of your aircraft, then the clock run to its readback slot (and one frame for the voice). */
async function clearAndReadBack(page, sim = page) {
  const r = await sim.evaluate(() => {
    const s = window.__sim, a = s.ac.find(x => x.ctl === 'ass' && !x.rcf), fl = Math.round(a.cfl) + 20;
    s.clearLevel(a.id, fl);
    return { cs: a.cs, fl, tx: s.tx[s.tx.length - 1] };
  });
  await sim.evaluate(t => { const s = window.__sim; while (s.t < t) s.step(); }, r.tx.t);
  return r;
}
const frames = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

test('solo: the readback is spoken in ICAO phraseology in its slot, with a local English voice; mute and volume work and are remembered', async ({ page }) => {
  await page.addInitScript(fakeSpeech);
  await open(page, '/');
  await expect(page.locator('#voiceBtn')).toHaveText('Voice on');
  await expect(page.locator('#voiceBtn')).toHaveAttribute('title', /2 local English voices, nothing is sent online/);
  await page.locator('#pausedStart').click();
  await page.locator('#speedSeg [data-s="1"]').click();

  const r = await clearAndReadBack(page);
  await frames(page);
  const spoken = await page.evaluate(() => window.__spoken);
  expect(spoken).toHaveLength(1);
  expect(spoken[0]).toMatchObject({ text: `climb ${level(r.fl)}, ${said(r.cs)}`, volume: 0.8, t: r.tx.t });
  expect(['Local A', 'Local B']).toContain(spoken[0].voice);
  expect(spoken[0].rate).toBeGreaterThanOrEqual(0.95);

  // the same callsign gets the same voice and pitch next time
  await page.evaluate(t => { const s = window.__sim; while (s.t < t) s.step(); }, r.tx.until);
  const r2 = await clearAndReadBack(page);
  await frames(page);
  const two = await page.evaluate(() => window.__spoken);
  if (r2.cs === r.cs) expect([two[1].voice, two[1].pitch]).toEqual([two[0].voice, two[0].pitch]);

  // volume, then mute
  await page.locator('#voiceVol').fill('0.3');
  await page.evaluate(t => { const s = window.__sim; while (s.t < t) s.step(); }, r2.tx.until);
  await clearAndReadBack(page);
  await frames(page);
  expect((await page.evaluate(() => window.__spoken)).at(-1).volume).toBeCloseTo(0.3);
  await page.locator('#voiceBtn').click();
  await expect(page.locator('#voiceBtn')).toHaveText('Voice off');
  const n = await page.evaluate(() => window.__spoken.length);
  await page.evaluate(() => { const s = window.__sim; while (s.freqBusy()) s.step(); });
  await clearAndReadBack(page);
  await frames(page);
  expect(await page.evaluate(() => window.__spoken.length)).toBe(n);

  await page.reload();
  await expect(page.locator('#voiceBtn')).toHaveText('Voice off');
  await expect(page.locator('#voiceVol')).toHaveValue('0.3');
});

test('a pilot request is spoken callsign first', async ({ page }) => {
  await page.addInitScript(fakeSpeech);
  await open(page, '/');
  await page.locator('#pausedStart').click();
  const cs = await page.evaluate(() => { const s = window.__sim, a = s.ac.find(x => x.ctl === 'ass' && !x.req && !x.rcf); s.pilotRequest(a.id, 'climb', 390); return a.cs; });
  await frames(page);
  await expect.poll(() => page.evaluate(() => window.__spoken.map(x => x.text))).toContain(`${said(cs)}, request climb flight level three niner zero`);
});

test('two windows: only the trainee window speaks, and only it has the voice controls', async ({ page, context }) => {
  await context.addInitScript(fakeSpeech);
  await open(page, '/?role=instructor');
  const trainee = await context.newPage();
  await open(trainee, '/?role=trainee');
  await expect(page.locator('#roleTag')).toHaveText('INSTRUCTOR · linked');
  await expect(page.locator('#voiceCtl')).toBeHidden();
  await expect(trainee.locator('#voiceCtl')).toBeVisible();
  await page.locator('#pausedStart').click();
  const r = await clearAndReadBack(page);
  await expect.poll(() => trainee.evaluate(() => window.__spoken.map(x => x.text)), { timeout: 8000 }).toContain(`climb ${level(r.fl)}, ${said(r.cs)}`);
  expect(await page.evaluate(() => window.__spoken)).toEqual([]);
});

test('without an English voice installed nothing is spoken, and the button says why', async ({ page }) => {
  await page.addInitScript(fakeSpeech, [{ name: 'Online', lang: 'en-US', localService: false }, { name: 'FR', lang: 'fr-FR', localService: true }]);
  await open(page, '/');
  await expect(page.locator('#voiceBtn')).toHaveAttribute('title', /No English voice is installed on this computer/);
  await page.locator('#pausedStart').click();
  await clearAndReadBack(page);
  await frames(page);
  expect(await page.evaluate(() => window.__spoken)).toEqual([]);
});
