import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { closeSync, ftruncateSync, openSync } from 'node:fs';

// Uploads to the real Vercel Blob store: the server needs BLOB_READ_WRITE_TOKEN.
const fixture = path.resolve('tests/fixtures/flower.mp4');

async function openUpload(page: Page) {
  await page.getByRole('button', { name: 'Choose something to watch' }).click();
  await page.getByRole('button', { name: 'From your device' }).click();
}

test('a video from your device is shared with the room and deleted when removed', async ({
  page,
  browser,
  request,
}, testInfo) => {
  const probe = await request.post('/api/upload', { data: {} });
  test.skip(probe.status() === 503, 'uploads are not configured on this server');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Create a room', exact: true }).first().click();
  await page.getByLabel('Your name').fill('Advitiya');
  await page.getByRole('button', { name: 'Create my room' }).click();
  await expect(page).toHaveURL(/\/room\/[A-Z2-9]{6}$/);
  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  await guest.goto(page.url());
  await guest.getByLabel('Your name').fill('Rahul');
  await guest.getByRole('button', { name: 'Let me in' }).click();
  await expect(guest.getByText('2 people here')).toBeVisible();

  await openUpload(page);
  // Files that aren't media, or are over 100 MB, are refused before uploading.
  await page.getByLabel('Video or song').setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hello'),
  });
  await expect(page.getByRole('alert')).toHaveText('Choose a video or audio file.');
  const huge = testInfo.outputPath('huge.mp4');
  const fd = openSync(huge, 'w');
  ftruncateSync(fd, 100 * 1024 * 1024 + 1);
  closeSync(fd);
  await page.getByLabel('Video or song').setInputFiles(huge);
  await expect(page.getByRole('alert')).toHaveText(
    'That file is over 100 MB. Choose a smaller one.',
  );
  await expect(page.getByRole('button', { name: 'Upload and add to our queue' })).toBeDisabled();

  await page.getByLabel('Video or song').setInputFiles(fixture);
  await expect(page.getByLabel('Give it a title')).toHaveValue('flower');
  await page.getByLabel('Give it a title').fill('Garden from my phone');
  await page.getByRole('button', { name: 'Upload and add to our queue' }).click();
  await expect(
    guest.getByRole('heading', { name: 'Garden from my phone', exact: true }),
  ).toBeVisible({
    timeout: 60_000,
  });
  const guestVideo = guest.locator('.player-screen video');
  const url = await guestVideo.evaluate((el: HTMLVideoElement) => el.src);
  expect(new URL(url).hostname).toMatch(/\.blob\.vercel-storage\.com$/);
  await expect
    .poll(() => guestVideo.evaluate((el: HTMLVideoElement) => el.readyState))
    .toBeGreaterThanOrEqual(2);

  await page.getByRole('button', { name: 'Play for everyone', exact: true }).last().click();
  await expect.poll(() => guestVideo.evaluate((el: HTMLVideoElement) => el.paused)).toBe(false);

  await page.getByRole('tab', { name: /Queue/ }).click();
  await page.getByRole('button', { name: 'Remove Garden from my phone' }).click();
  await expect(page.locator('.queue-item')).toHaveCount(0);
  // Deleted from storage (bypass the CDN cache with a unique query).
  await expect
    .poll(async () => (await request.get(`${url}?check=${Date.now()}`)).status(), {
      timeout: 60_000,
    })
    .toBe(404);
  expect(errors).toEqual([]);
  await guestContext.close();
});
