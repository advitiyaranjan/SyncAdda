import { test, expect, type Page, type Route } from '@playwright/test';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const base = process.env.SYNCADDA_URL || '';
const mediaBytes = readFileSync(path.resolve('tests/fixtures/flower.mp4'));
async function serveMedia(route: Route) {
  const range = route.request().headers().range;
  const [, from, to] = /bytes=(\d+)-(\d*)/.exec(range || '') || [];
  const start = from ? Number(from) : 0,
    end = to ? Math.min(Number(to), mediaBytes.length - 1) : mediaBytes.length - 1;
  await route.fulfill({
    status: range ? 206 : 200,
    body: mediaBytes.subarray(start, end + 1),
    contentType: 'video/mp4',
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes',
      'Content-Length': String(end - start + 1),
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${mediaBytes.length}` } : {}),
    },
  });
}
async function enter(page: Page, name: string, url?: string) {
  await page.route('https://media.example.test/flower.mp4', serveMedia);
  if (url) {
    await page.goto(url);
    await page.getByLabel('Your name').fill(name);
    await page.getByRole('button', { name: 'Let me in' }).click();
  } else {
    await page.goto(`${base}/`);
    await page.getByRole('button', { name: 'Create a room', exact: true }).first().click();
    await page.getByLabel('Your name').fill(name);
    await page.getByRole('button', { name: 'Create my room' }).click();
    await expect(page).toHaveURL(/\/room\/[A-Z2-9]{6}$/);
  }
  await expect(page.getByText('Connected', { exact: true })).toBeVisible();
}
async function addVideo(page: Page, title: string) {
  await page
    .getByRole('button', { name: /Add media|Choose something to watch/ })
    .first()
    .click();
  await page.getByLabel('Media link').fill('https://media.example.test/flower.mp4');
  await page.getByLabel('Give it a title').fill(title);
  await page.getByRole('button', { name: 'Add to our queue' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('only the host controls media, and can let someone add to the queue', async ({
  page,
  browser,
}) => {
  await enter(page, 'Asha');
  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  await enter(guest, 'Bina', page.url());

  await expect(guest.getByRole('button', { name: 'Choose something to watch' })).toHaveCount(0);
  await page.getByRole('tab', { name: /People/ }).click();
  await page.getByLabel('Manage Bina').click();
  await page.getByRole('button', { name: 'Let them add to queue' }).click();
  await expect(guest.getByText('Bina can now add to the queue.')).toBeVisible();

  await addVideo(guest, 'Bina’s pick');
  await expect(page.getByRole('heading', { name: 'Bina’s pick', exact: true })).toBeVisible();
  // Queue access doesn't include the remote.
  await expect(
    guest.getByRole('button', { name: 'Play for everyone', exact: true }).last(),
  ).toBeDisabled();
  await expect(guest.getByRole('button', { name: 'Remove Bina’s pick' })).toHaveCount(0);

  await page.getByLabel('Manage Bina').click();
  await page.getByRole('button', { name: 'Stop queue access' }).click();
  await expect(guest.getByRole('button', { name: 'Add media' })).toHaveCount(0);
  await guestContext.close();
});

test('the room header stays in view while scrolling, but not on short (zoomed-in) screens', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 640 });
  await enter(page, 'Asha');
  await page.mouse.wheel(0, 2000);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(100);
  expect((await page.locator('.room-header').boundingBox())?.y).toBe(0);
  await page.setViewportSize({ width: 1440, height: 480 });
  await page.evaluate(() => scrollTo(0, 0));
  await page.mouse.wheel(0, 400);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(100);
  expect((await page.locator('.room-header').boundingBox())?.y).toBeLessThan(0);
});

test('playback stays within a few frames across viewers', async ({ page, browser }) => {
  await enter(page, 'Asha');
  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  await enter(guest, 'Bina', page.url());
  await addVideo(page, 'In sync');
  for (const p of [page, guest])
    await expect
      .poll(() =>
        p.locator('.player-screen video').evaluate((el: HTMLVideoElement) => el.readyState),
      )
      .toBeGreaterThanOrEqual(3);
  await page.getByRole('button', { name: 'Play for everyone', exact: true }).last().click();
  await page.waitForTimeout(5000);
  const gaps: number[] = [];
  for (let i = 0; i < 5; i++) {
    const [a, b] = await Promise.all(
      [page, guest].map((p) =>
        p.locator('.player-screen video').evaluate((el: HTMLVideoElement) => el.currentTime),
      ),
    );
    gaps.push(Math.abs(a - b));
    await page.waitForTimeout(300);
  }
  gaps.sort((x, y) => x - y);
  console.log('sync gaps (s):', gaps.map((g) => g.toFixed(3)).join(', '));
  expect(gaps[2]).toBeLessThan(0.1);
  await guestContext.close();
});
