import { test, expect } from '@playwright/test';
import { open } from './load.js';
import { bestWorstOverlap } from './best-layout.js';

test.beforeEach(async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.__errors = errors;
  await open(page, '/');
  await expect(page.locator('#pausedTag')).toBeVisible();
});
test.afterEach(async ({ page }) => {
  expect(page.__errors, 'uncaught page errors').toEqual([]);
});

test('loads Romania with a ready scenario and no horizontal overflow', async ({ page }) => {
  await expect(page.locator('#firTag')).toContainText('LRBB');
  await expect(page.locator('#sector option')).toHaveCount(16); // 10 elementary (KOMAN as two layers) + 5 collapsed + FIR
  await expect(page.locator('#injList .inj-row').first()).toBeVisible();
  await expect(page.locator('#debrief')).toBeHidden();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  // the map overlays (layer chips, legend, tool and zoom chips) do not cover each other
  const boxes = await page.evaluate(() => ['#layerChips', '#legend', '#mapTools'].map(q => { const r = document.querySelector(q).getBoundingClientRect(); return { q, l: r.left, r: r.right, t: r.top, b: r.bottom }; }));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const [p, q] = [boxes[i], boxes[j]];
    expect(p.r <= q.l || q.r <= p.l || p.b <= q.t || q.b <= p.t, `${p.q} overlaps ${q.q}`).toBe(true);
  }
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
      // only an aircraft on our frequency (assumed) takes clearances
      if (document.querySelector('#acBox .ac-card') && window.__sim.get(window.__radar.sel)?.ctl === 'ass') return true;
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

test('Hungary is listed as withdrawn, pending permission from HungaroControl, and cannot be selected', async ({ page }) => {
  const hu = page.locator('#country option[value="HU"]');
  await expect(hu).toBeDisabled();
  await expect(hu).toHaveText('Hungary · LHCC — pending permission from HungaroControl');
  await expect(page.locator('#country option:not([disabled])')).toHaveText(['Romania · LRBB']);
  await page.locator('#tab-data').click();
  await expect(page.locator('#roadmap')).toContainText('Hungary · LHCC pending permission from HungaroControl');
  await expect(page.locator('#dataList')).toContainText('Source: AIP Romania © ROMATSA. The AIP-derived files in data/RO');
  await expect(page.locator('#dataList')).toContainText('will be removed on request');
  await page.locator('#pausedStart').click();
  await page.evaluate(() => { for (let i = 0; i < 300; i++) window.__sim.step(); });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
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

test('advanced ARGES: data blocks overlap no more than 20%, or 10 points above the best layout possible', async ({ page }, info) => {
  // Where tracks bunch, no choice of the four positions gets every pair under 20%; then the layout
  // must be within 10 points of the best one possible (computed each minute by best-layout.js).
  // On the phone scope (about 378 px wide) the floor is 65%: labels stacked on each other would be near 100%.
  const base = info.project.name === 'phone' ? 0.65 : 0.2;
  await page.locator('#difficulty').selectOption('advanced');
  await expect(page.locator('#pausedSub')).toContainText('ARGES');
  for (let k = 0; k < 10; k++) {
    if (k) await page.evaluate(() => { for (let i = 0; i < 60; i++) window.__sim.step(); });
    await nextFrame(page);
    const ls = await labels(page);
    expect(ls.length, 'labels drawn').toBeGreaterThan(5);
    const { worst, pair } = worstOverlap(ls);
    const best = bestWorstOverlap(ls.map(l => [l.box[0] - l.off[0], l.box[1] - l.off[1]]));
    const limit = Math.max(base, best + 0.1);
    const pct = x => (x * 100).toFixed(0) + '%';
    expect(worst, `minute ${k}: labels ${pair} overlap ${pct(worst)}; best possible ${pct(best)}, limit ${pct(limit)}`).toBeLessThanOrEqual(limit);
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

// advance the paused session until a priority item with this action is in the visible top 10
const stepUntilPriority = (page, act) => page.evaluate(act => {
  const s = window.__sim;
  for (let i = 0; i < 1500; i++) {
    const it = s.priorities().slice(0, 10).find(p => p.act === act);
    if (it) return it.ac.id;
    s.step();
  }
  return null;
}, act);
const fireInject = (page, type) => page.evaluate(type => {
  const s = window.__sim;
  s.scenario.injects.push({ min: 99, type, text: '', status: 'pending' });
  s.fireNow(s.scenario.injects.length - 1);
  return s.scenario.injects.at(-1).target;
}, type);
const pauseSession = async page => { await page.locator('#pausedStart').click(); await page.locator('#playBtn').click(); };

test('assume a pending flight, then transfer one at its agreed exit level', async ({ page }) => {
  await pauseSession(page);
  const pend = await stepUntilPriority(page, 'assume');
  expect(pend).not.toBeNull();
  await page.locator(`#prio button[data-a="assume"][data-id="${pend}"]`).click();
  expect(await page.evaluate(id => window.__sim.get(id).ctl, pend)).toBe('ass');

  const out = await stepUntilPriority(page, 'xfer');
  expect(out).not.toBeNull();
  const { cs, xfl } = await page.evaluate(id => { const a = window.__sim.get(id); return { cs: a.cs, xfl: a.xfl }; }, out);
  await page.locator(`#prio .pi[data-ac="${out}"] .t`).click(); // select it
  await expect(page.locator('#acBox .ac-head b')).toHaveText(cs);
  await expect(page.locator('#acCtl')).toContainText(`agreed exit FL${xfl}`);
  await page.locator('#cFl').selectOption(String(xfl));
  await page.locator('#bFl').click();
  await page.locator('#acCtl button[data-a="xfer"]').click();
  await expect(page.locator('#log')).toContainText(`${cs} transferred at FL${xfl}`);
  expect(await page.evaluate(id => [window.__sim.get(id)?.ctl, window.__sim.stats.wrongXfl], out)).toEqual(['xfer', 0]);
});

test('the next sector asks for another exit level and the trainee accepts', async ({ page }) => {
  await pauseSession(page);
  const cs = await fireInject(page, 'COORD_REQUEST');
  expect(cs).toBeTruthy();
  const want = await page.evaluate(cs => window.__sim.ac.find(a => a.cs === cs).req.value, cs);
  const item = page.locator('#prio .pi', { hasText: `${cs} next sector requests exit FL${want}` });
  await expect(item.locator('button[data-a="ok"]')).toHaveText('Accept');
  await item.locator('button[data-a="ok"]').click();
  await expect(page.locator('#log')).toContainText(`${cs} exit level FL${want} agreed with the next sector`);
  expect(await page.evaluate(cs => window.__sim.ac.find(a => a.cs === cs).xfl, cs)).toBe(want);
});

test('a flight arrives without transfer; the trainee coordinates and assumes it', async ({ page }) => {
  await pauseSession(page);
  const cs = await fireInject(page, 'LATE_TRANSFER');
  expect(cs).toBeTruthy();
  await page.evaluate(cs => { const s = window.__sim, a = s.ac.find(x => x.cs === cs); for (let i = 0; i < 300 && !a.lastIn; i++) s.step(); }, cs);
  const item = page.locator('#prio .pi', { hasText: `${cs} in sector without transfer` });
  await expect(item).toBeVisible();
  await item.locator('button[data-a="assume"]').click();
  await expect(page.locator('#log')).toContainText(`${cs} assumed`);
  expect(await page.evaluate(cs => window.__sim.ac.find(a => a.cs === cs).ctl, cs)).toBe('ass');
});

test('Mach and rate clearances and the wind editor work from the panels', async ({ page }) => {
  await page.locator('#pausedStart').click();
  await page.locator('#playBtn').click(); // pause
  await page.evaluate(() => { for (let i = 0; i < 30; i++) window.__sim.step(); });
  const { id, cs, cfl } = await page.evaluate(() => {
    const a = window.__sim.ac.find(x => x.ctl === 'ass' && x.fl >= 300 && x.fl <= 360);
    window.__radar.sel = a.id;
    return { id: a.id, cs: a.cs, cfl: a.cfl };
  });
  await expect(page.locator('#acBox .ac-head b')).toHaveText(cs);
  await page.locator('#cMach').fill('0.74');
  await page.locator('#bMach').click();
  await expect(page.locator('#log')).toContainText(`${cs} maintain M.74`);
  expect(await page.evaluate(id => window.__sim.get(id).spd, id)).toEqual({ mode: 'mach', v: 0.74 });

  await page.evaluate(() => { const s = window.__sim; while (s.freqBusy()) s.step(); }); // wait for the readback: a clearance on a busy frequency gets "say again"
  await page.locator('#cFl').selectOption(String(cfl + 20));
  await page.locator('#bFl').click();
  await page.evaluate(() => { const s = window.__sim; while (s.freqBusy()) s.step(); });
  await page.locator('#cRate').fill('800');
  await page.locator('#cRateKind').selectOption('max');
  await page.locator('#bRate').click();
  await expect(page.locator('#log')).toContainText(`${cs} climb at 800 ft/min or less`);

  await page.locator('#tab-scenario').click();
  const row = k => page.locator(`#windTable input[data-w="${k}"][data-i="0"]`);
  await row('fl').fill('300'); await row('dir').fill('90'); await row('kt').fill('60');
  await page.locator('#windApply').click();
  await expect(page.locator('#toast')).toHaveText('Wind applied');
  expect(await page.evaluate(() => window.__sim.wind.find(w => w.fl === 300))).toEqual({ fl: 300, dir: 90, kt: 60 });
});

test('session ends with a debrief', async ({ page }) => {
  await page.locator('#pausedStart').click();
  await page.evaluate(() => { const s = window.__sim; while (!s.ended) s.step(); });
  await expect(page.locator('#debrief')).toBeVisible();
  await expect(page.locator('#debStats .stat')).toHaveCount(12);
  // nobody assumed or transferred anything, so the routine counters show it
  const stat = k => page.locator('#debStats .stat', { hasText: k }).locator('.v');
  for (const k of ['Late assumes', 'Late transfers']) expect(+(await stat(k).textContent()), k).toBeGreaterThan(0);
  await expect(stat('Wrong exit levels')).toHaveText(/^\d+$/);
  // per-inject results under the totals, then the timeline
  const n = await page.evaluate(() => window.__sim.scenario.injects.length);
  await expect(page.locator('#debInjects tbody tr')).toHaveCount(n);
  await expect(page.locator('#debInjects')).toContainText(/objectives met/);
  expect(await page.locator('#debTimeline .deb-tl > div').count()).toBeGreaterThan(n);
});

test('RBL and SEP tools on the radar, and the level probe on the selected aircraft', async ({ page }) => {
  await page.locator('#pausedStart').click();
  await page.locator('#playBtn').click(); // freeze, so tracks stay where we click
  await page.locator('#fitSector').click();
  const box = await page.locator('#scope').boundingBox();
  // two assumed tracks on screen, well apart
  const pts = await page.evaluate(() => {
    // on screen and clickable: the radar itself is under the point, not a chip or the legend
    const R = window.__radar, s = window.__sim, cv = document.querySelector('#scope').getBoundingClientRect();
    const on = a => { const x = R.sx([a.x, a.y]), y = R.sy([a.x, a.y]); return x > 40 && y > 40 && x < R.V.w - 40 && y < R.V.h - 40 && document.elementFromPoint(cv.left + x, cv.top + y).id === 'scope'; };
    const mine = s.ac.filter(a => a.ctl === 'ass' && on(a));
    const a = mine[0], b = mine.find(m => Math.hypot(m.x - a.x, m.y - a.y) > 30);
    return [a, b].map(m => ({ id: m.id, x: R.sx([m.x, m.y]), y: R.sy([m.x, m.y]) }));
  });
  const click = p => page.mouse.click(box.x + p.x, box.y + p.y);

  await page.locator('#toolRbl').click();
  await expect(page.locator('#toolRbl')).toHaveAttribute('aria-pressed', 'true');
  await click(pts[0]); await click(pts[1]);
  expect(await page.evaluate(() => window.__radar.tools.rbl.map(l => [l.a.ac, l.b.ac]))).toEqual([[pts[0].id, pts[1].id]]);
  await expect(page.locator('#toolRbl')).toHaveAttribute('aria-pressed', 'false');

  await page.locator('#toolSep').click();
  await click(pts[0]); await click(pts[1]);
  expect(await page.evaluate(() => window.__radar.tools.sep)).toEqual([{ a: pts[0].id, b: pts[1].id }]);
  expect(await page.evaluate(() => window.__radar.sel)).toBeNull(); // tool clicks do not select

  await page.locator('#toolClear').click();
  expect(await page.evaluate(() => [window.__radar.tools.rbl.length, window.__radar.tools.sep.length])).toEqual([0, 0]);

  // probe: select a track, pick a level, probe
  await click(pts[0]);
  await expect(page.locator('#cFl')).toBeVisible();
  await page.locator('#bProbe').click();
  await expect(page.locator('#probeOut')).toBeVisible();
  await expect(page.locator('#probeOut')).toContainText(/^FL\d{3}/);
});

test('command line: Tab completes the callsign, Enter sends, the pilot reads back and the frequency is busy', async ({ page }) => {
  await page.locator('#pausedStart').click();
  await page.locator('#playBtn').click(); // freeze, so the test drives the clock
  const [a, b] = await page.evaluate(() => window.__sim.ac.filter(x => x.ctl === 'ass' && !x.rcf).slice(0, 2).map(x => ({ id: x.id, cs: x.cs, cfl: Math.round(x.cfl) })));
  const line = page.locator('#cmdLine'), hint = page.locator('#cmdHint');
  const step = s => page.evaluate(s => { for (let i = 0; i < s; i++) window.__sim.step(); }, s);

  // completion: type all but the last character, Tab fills it in when only one callsign matches
  const others = await page.evaluate(cs => window.__sim.ac.filter(x => x.cs.startsWith(cs)).length, a.cs.slice(0, -1));
  await line.fill(a.cs.slice(0, -1).toLowerCase());
  await line.press('Tab');
  if (others === 1) await expect(line).toHaveValue(a.cs + ' ');
  else await line.fill(a.cs + ' ');

  const fl = a.cfl + 20;
  await line.pressSequentially(`${fl} H120`);
  await line.press('Enter');
  await expect(line).toHaveValue('');
  expect(await page.evaluate(id => { const x = window.__sim.get(id); return [x.cfl, x.thdg]; }, a.id)).toEqual([fl, 120]);
  await expect(page.locator('#freqState')).toHaveText(`frequency busy · ${a.cs}`);

  // a clearance while the frequency is busy gets "say again"
  await line.fill(`${b.cs} ${b.cfl + 20}`);
  await line.press('Enter');
  await expect(hint).toHaveText(`Frequency busy: ${b.cs} say again`);
  await expect(page.locator('#log')).toContainText(`${b.cs} say again`);

  await step(10);
  await expect(page.locator('#log .p').first()).toHaveText(new RegExp(`climb FL${fl}, turn heading 120, ${a.cs}$`));
  await expect(page.locator('#freqState')).toHaveText('frequency free');

  // malformed input is answered at once and nothing is sent
  await line.fill(`${b.cs} H400`);
  await line.press('Enter');
  await expect(hint).toHaveText('Heading 400 is outside 001-360');
  await expect(line).toHaveValue(`${b.cs} H400`);
});

test('COMLOSS: Notify MIL from the priorities, the QRA pair scrambles, its coordination is acknowledged', async ({ page }) => {
  await page.locator('#pausedStart').click();
  await page.locator('#playBtn').click(); // freeze
  const step = s => page.evaluate(s => { for (let i = 0; i < s; i++) window.__sim.step(); }, s);
  await page.evaluate(() => { const s = window.__sim; s.scenario.injects.unshift({ min: 1, type: 'COMLOSS', text: '' }); s.scenario.injects[0].status = 'pending'; s.fireNow(0); });
  const { cs, wait } = await page.evaluate(() => { const g = window.__sim.scenario.injects[0].g; return { cs: g.ac.cs, wait: g.declareAt - window.__sim.t }; });
  await step(wait + 1);
  const item = page.locator('#prio .pi', { hasText: `${cs} COMLOSS` });
  await expect(item).toBeVisible();
  await item.locator('button[data-a="notify"]').click();
  await expect(page.locator('#log')).toContainText(`Military notified: ${cs} COMLOSS`);

  await step(200);
  const qra = await page.evaluate(() => { const q = window.__sim.scenario.injects[0].g.qra; return { id: q.id, cs: q.cs }; });
  const call = page.locator('#prio .pi', { hasText: `${qra.cs} (MIL) QRA pair airborne` });
  await expect(call).toBeVisible();
  await call.locator('button[data-a="ok"]').click();
  await expect(page.locator('#log')).toContainText(`${qra.cs} coordination with the military acknowledged`);

  // the military track: shown for awareness, no clearances
  await page.evaluate(id => { window.__radar.sel = id; }, qra.id);
  await expect(page.locator('#acBox')).toContainText('Operational air traffic under military control');
  await expect(page.locator('#acBox #cFl')).toHaveCount(0);
});

test('loads nothing from other hosts; the fonts are the bundled ones', async ({ context, baseURL }) => {
  const page = await context.newPage(), own = new URL(baseURL).host, external = [];
  page.on('request', r => {
    const u = new URL(r.url());
    if (!['data:', 'blob:'].includes(u.protocol) && u.host !== own) external.push(r.url());
  });
  await open(page, '/');
  // use the page: run the session, every tab, an export
  await page.locator('#pausedStart').click();
  await page.waitForTimeout(1500);
  for (const tab of ['scenario', 'data', 'live']) await page.locator(`#tab-${tab}`).click();
  await page.locator('#tab-scenario').click();
  await Promise.all([page.waitForEvent('download'), page.locator('#scnExport').click()]);
  expect(external, 'requests to other hosts').toEqual([]);
  const fonts = await page.evaluate(() => [...document.fonts].filter(f => f.status === 'loaded').map(f => `${f.family.replace(/"/g, '')} ${f.weight}`));
  for (const f of ['Barlow Semi Condensed 600', 'IBM Plex Mono 400']) expect(fonts, f).toContain(f);
  await page.close();
});
