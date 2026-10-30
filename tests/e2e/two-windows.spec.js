import { test, expect } from '@playwright/test';

// The instructor and trainee windows are two pages in one browser context, the way two
// windows on one computer share a BroadcastChannel.
async function openBoth(page, context) {
  const errors = [];
  page.on('pageerror', e => errors.push(`instructor: ${e.message}`));
  await page.goto('/?role=instructor');
  const trainee = await context.newPage();
  trainee.on('pageerror', e => errors.push(`trainee: ${e.message}`));
  await trainee.goto('/?role=trainee');
  await expect(trainee.locator('#roleTag')).toHaveText('TRAINEE · linked');
  await expect(page.locator('#roleTag')).toHaveText('INSTRUCTOR · linked');
  return { instructor: page, trainee, errors };
}
const step = (page, s) => page.evaluate(s => { for (let i = 0; i < s; i++) window.__sim.step(); }, s);
const traineeSees = (trainee, fn, arg) => expect.poll(() => trainee.evaluate(fn, arg), { timeout: 5000 });

test('the trainee window follows the instructor session and sees only what a controller would know', async ({ page, context }) => {
  const { instructor, trainee, errors } = await openBoth(page, context);
  await expect(trainee.locator('#pausedTitle')).toHaveText('Session ready');
  const callsigns = await instructor.evaluate(() => window.__sim.ac.map(a => a.cs).sort());
  await traineeSees(trainee, () => window.__sim.ac.map(a => a.cs).sort()).toEqual(callsigns);

  // instructor-only parts are not in the trainee window
  for (const id of ['injList', 'stNext', 'tab-instr', 'speedSeg', 'playBtn', 'restartBtn', 'pausedStart']) await expect(trainee.locator('#' + id)).toBeHidden();
  await expect(trainee.locator('#country')).toBeDisabled();

  // run up to just before the first inject: the instructor is warned, the trainee is not
  await instructor.locator('#pausedStart').click();
  await instructor.locator('#playBtn').click(); // freeze
  const first = await instructor.evaluate(() => window.__sim.scenario.injects[0].min);
  await step(instructor, first * 60 - 90);
  expect(await instructor.evaluate(() => window.__sim.priorities().some(p => /^Inject in/.test(p.h)))).toBe(true);
  await traineeSees(trainee, () => window.__sim.t).toBeGreaterThan(0);
  await expect(trainee.locator('#prio')).not.toContainText('Inject in');
  await expect(trainee.locator('body')).not.toContainText('Session loaded');
  await expect(trainee.locator('#pausedTitle')).toHaveText('Frozen by the instructor');
  expect(errors).toEqual([]);
});

test('a clearance from the trainee window changes the instructor Sim', async ({ page, context }) => {
  const { instructor, trainee, errors } = await openBoth(page, context);
  await instructor.locator('#pausedStart').click();
  await instructor.locator('#playBtn').click();
  const { id, cs } = await instructor.evaluate(() => { const a = window.__sim.ac.find(x => x.ctl === 'ass'); return { id: a.id, cs: a.cs }; });
  await traineeSees(trainee, id => !!window.__sim.get(id), id).toBe(true);
  await trainee.evaluate(id => { window.__radar.sel = id; }, id);
  await expect(trainee.locator('#acBox .ac-head b')).toHaveText(cs);
  await trainee.locator('#cFl').selectOption('250');
  await trainee.locator('#bFl').click();
  await expect.poll(() => instructor.evaluate(id => window.__sim.get(id).cfl, id)).toBe(250);
  await expect(instructor.locator('#log')).toContainText(`${cs} descend FL250`);
  await traineeSees(trainee, id => window.__sim.get(id).cfl, id).toBe(250);
  expect(errors).toEqual([]);
});

test('the pseudo-pilot makes a request the trainee approves, and refuses a clearance', async ({ page, context }) => {
  const { instructor, trainee, errors } = await openBoth(page, context);
  await instructor.locator('#pausedStart').click();
  await instructor.locator('#playBtn').click();
  const [a, b] = await instructor.evaluate(() => window.__sim.ac.filter(x => x.ctl === 'ass' && !x.req).slice(0, 2).map(x => ({ id: x.id, cs: x.cs })));

  // speak as aircraft a: request a climb
  await instructor.evaluate(id => { window.__radar.sel = id; }, a.id);
  await instructor.locator('#tab-instr').click();
  await expect(instructor.locator('#ppFor')).toHaveText(`speaking as ${a.cs}`);
  await instructor.locator('#ppKind').selectOption('climb');
  await instructor.locator('#ppVal').fill('390');
  await instructor.locator('#ppBox button[data-pp="req"]').click();
  const item = trainee.locator('#prio .pi', { hasText: `${a.cs} requests climb FL390` });
  await expect(item).toBeVisible();
  await item.locator('button[data-a="ok"]').click();
  await expect.poll(() => instructor.evaluate(id => window.__sim.get(id).cfl, a.id)).toBe(390);

  // speak as aircraft b: refuse the next clearance
  await instructor.evaluate(id => { window.__radar.sel = id; }, b.id);
  await expect(instructor.locator('#ppFor')).toHaveText(`speaking as ${b.cs}`);
  await instructor.locator('#ppBox button[data-pp="next-refuse"]').click();
  const cfl = await instructor.evaluate(id => window.__sim.get(id).cfl, b.id);
  const r = await trainee.evaluate(id => window.__sim.clearLevel(id, 250), b.id);
  expect(r).toEqual({ ok: false, msg: `${b.cs}: unable ${cfl > 250 ? 'descend' : 'climb'} FL250` });
  expect(await instructor.evaluate(id => window.__sim.get(id).cfl, b.id)).toBe(cfl);
  expect(errors).toEqual([]);
});

test('the instructor holds, edits and fires injects while the session runs', async ({ page, context }) => {
  const { instructor, errors } = await openBoth(page, context);
  await instructor.locator('#pausedStart').click();
  await instructor.locator('#tab-instr').click();
  const rows = instructor.locator('#tlList .inj-row');
  await rows.nth(0).locator('button[data-tl="hold"]').click();
  await expect(rows.nth(0)).toContainText('held');
  expect(await instructor.evaluate(() => window.__sim.scenario.injects[0].status)).toBe('held');

  await rows.nth(1).locator('button[data-tl="edit"]').click();
  await instructor.locator('#tlMin').fill('12');
  await instructor.locator('#tlType').selectOption('COORD_REQUEST');
  await instructor.locator('#tlList button[data-tl="save"]').click();
  expect(await instructor.evaluate(() => window.__sim.scenario.injects[1])).toMatchObject({ min: 12, type: 'COORD_REQUEST' });

  await rows.nth(0).locator('button[data-tl="fire"]').click();
  await expect(rows.nth(0)).toContainText('fired');
  expect(errors).toEqual([]);
});

test('solo mode is unchanged: one window, inject list, no link', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#roleTag')).toBeHidden();
  await expect(page.locator('#injList .inj-row').first()).toBeVisible();
  await expect(page.locator('#tab-instr')).toBeHidden();
  expect(await page.evaluate(() => window.__link)).toBeNull();
});
