import { test, expect, type Page } from '@playwright/test';

// Uses the real YouTube embed, so it needs network access to youtube.com.
const VIDEO = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'; // Big Buck Bunny, Blender Foundation

async function enter(page: Page, url: string | null, name: string) {
  if (url) {
    await page.goto(url);
    await page.getByLabel('Your name').fill(name);
    await page.getByRole('button', { name: 'Let me in' }).click();
  } else {
    await page.goto(process.env.SYNCADDA_URL || '/');
    await page.getByRole('button', { name: 'Create a room', exact: true }).first().click();
    await page.getByLabel('Your name').fill(name);
    await page.getByRole('button', { name: 'Create my room' }).click();
    await expect(page).toHaveURL(/\/room\/[A-Z2-9]{6}$/);
  }
  return page.url();
}
const youtubeVideo = (page: Page) =>
  page.frameLocator('.youtube-host iframe').locator('video').first();

test('YouTube links play in sync for everyone', async ({ page, browser }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const url = await enter(page, null, 'Advitiya');
  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  guest.on('pageerror', (e) => errors.push(e.message));
  await enter(guest, url, 'Rahul');
  await expect(guest.getByText('2 people here')).toBeVisible();

  await page.getByRole('button', { name: 'Choose something to watch' }).click();
  await page.getByLabel('Media link').fill(VIDEO);
  await expect(page.getByText('Plays in YouTube’s player for everyone.')).toBeVisible();
  await expect(page.getByLabel('Type')).toHaveCount(0);
  // The title is filled in from YouTube.
  await expect(page.getByLabel('Give it a title')).not.toHaveValue('');
  const title = await page.getByLabel('Give it a title').inputValue();
  await page.getByRole('button', { name: 'Add to our queue' }).click();
  await expect(guest.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(guest.locator('.youtube-host iframe')).toBeVisible();

  await page.getByRole('button', { name: 'Play for everyone', exact: true }).last().click();
  for (const p of [page, guest])
    await expect
      .poll(() => youtubeVideo(p).evaluate((el: HTMLVideoElement) => el.paused), {
        timeout: 30_000,
      })
      .toBe(false);

  // The host pauses by clicking YouTube's own player, as a person would; it reaches everyone.
  const box = (await page.locator('.youtube-host iframe').boundingBox())!;
  // YouTube can ignore a click in the moment it's starting up, so give it a beat, like a person.
  await page.waitForTimeout(2000);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect
    .poll(() => youtubeVideo(page).evaluate((el: HTMLVideoElement) => el.paused))
    .toBe(true);
  await expect(
    page.getByRole('button', { name: 'Play for everyone', exact: true }).last(),
  ).toBeVisible();
  await expect
    .poll(() => youtubeVideo(guest).evaluate((el: HTMLVideoElement) => el.paused))
    .toBe(true);

  await page.getByRole('slider', { name: 'Seek for everyone' }).fill('60');
  // A paused YouTube player may be re-cued at the new spot rather than seeked (seeking a cued
  // video would start it), so check the time the app shows; the play step below checks the rest.
  await expect(guest.locator('.player-time')).toContainText(/^1:0[01]/);

  await page.getByRole('combobox', { name: 'Playback speed for everyone' }).selectOption('1.5');
  await page.getByRole('button', { name: 'Play for everyone', exact: true }).last().click();
  await expect
    .poll(() => youtubeVideo(guest).evaluate((el: HTMLVideoElement) => el.playbackRate))
    .toBe(1.5);
  await page.waitForTimeout(4000);
  const [hostTime, guestTime] = await Promise.all(
    [page, guest].map((p) => youtubeVideo(p).evaluate((el: HTMLVideoElement) => el.currentTime)),
  );
  expect(Math.abs(hostTime - guestTime)).toBeLessThan(1.5);
  await page.screenshot({ path: 'test-results/youtube-room.png' });

  // The host's page goes to the background and YouTube pauses itself there: that mustn't pause
  // everyone, and the host catches up on return.
  const setVisibility = (state: 'hidden' | 'visible') =>
    page.evaluate((value) => {
      Object.defineProperty(document, 'visibilityState', { get: () => value, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    }, state);
  await setVisibility('hidden');
  await youtubeVideo(page).evaluate((el: HTMLVideoElement) => el.pause());
  await page.waitForTimeout(3000);
  expect(await youtubeVideo(guest).evaluate((el: HTMLVideoElement) => el.paused)).toBe(false);
  await setVisibility('visible');
  await expect
    .poll(() => youtubeVideo(page).evaluate((el: HTMLVideoElement) => el.paused))
    .toBe(false);
  await expect
    .poll(() => youtubeVideo(page).evaluate((el: HTMLVideoElement) => el.playbackRate))
    .toBe(1.5);
  expect(errors).toEqual([]);
  await guestContext.close();
});
