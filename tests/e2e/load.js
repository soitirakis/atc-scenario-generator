// Page loads for the e2e tests: wait for the bundled fonts, so text measurement (data blocks,
// overlays) is the same on every run and every machine.
export const fontsReady = page => page.evaluate(() => document.fonts.ready.then(() => document.fonts.size));
export async function open(page, url) {
  await page.goto(url);
  await fontsReady(page);
}
