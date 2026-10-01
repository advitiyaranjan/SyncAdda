import { test, expect, type Page, type Route } from '@playwright/test';
import path from 'node:path';
import { readFileSync } from 'node:fs';
const fixture = path.resolve('tests/fixtures/flower.mp4');
const mediaBytes = readFileSync(fixture);
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

async function createRoom(page: Page, name = 'Advitiya') {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create a room', exact: true }).first().click();
  await page.getByLabel('Your name').fill(name);
  await page.getByRole('button', { name: 'Create my room' }).click();
  await expect(page).toHaveURL(/\/room\/[A-Z2-9]{6}$/);
  await expect(page.getByRole('heading', { name: 'What are we watching?' })).toBeVisible();
  return page.url();
}
async function joinRoom(page: Page, url: string, name = 'Rahul') {
  await page.goto(url);
  await page.getByLabel('Your name').fill(name);
  await page.getByRole('button', { name: 'Let me in' }).click();
  await expect(page.getByText('2 people here')).toBeVisible();
}
async function addFixture(page: Page) {
  await page.getByRole('button', { name: 'Choose something to watch' }).click();
  await page.getByLabel('Media link').fill('https://media.example.test/flower.mp4');
  await page.getByLabel('Give it a title').fill('A moment in the garden');
  await page.getByRole('button', { name: 'Add to our queue' }).click();
  await expect(
    page.getByRole('heading', { name: 'A moment in the garden', exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.locator('.player-screen video').evaluate((el: HTMLVideoElement) => el.readyState),
    )
    .toBeGreaterThanOrEqual(2);
}
test('home page, media tabs, FAQ, and desktop layout', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Different places. Same moment.' })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: 'test-results/desktop-home.png', fullPage: true });
  await page.getByRole('tab', { name: 'Music sessions' }).click();
  await expect(
    page.getByRole('heading', { name: 'Your favorite songs. Your favorite people.' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'What can we watch or listen to?' }).click();
  await expect(
    page.getByText('Add a direct link to a video or audio file, or an HLS live stream.', {
      exact: false,
    }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
test('two independent browsers share chat, media playback, permissions, and restored sessions', async ({
  page,
  browser,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('https://media.example.test/flower.mp4', serveMedia);
  const url = await createRoom(page);
  await page.screenshot({ path: 'test-results/desktop-room-empty.png', fullPage: true });
  const guestContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const guest = await guestContext.newPage();
  guest.on('pageerror', (e) => errors.push(e.message));
  await guest.route('https://media.example.test/flower.mp4', serveMedia);
  await joinRoom(guest, url);
  await page.getByRole('textbox', { name: 'Message your room' }).fill('Ready for movie night? 🍿');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(guest.getByText('Ready for movie night? 🍿', { exact: true })).toBeVisible();
  await guest.getByRole('textbox', { name: 'Message your room' }).fill('Ready! Press play.');
  await guest.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('Ready! Press play.', { exact: true })).toBeVisible();
  await addFixture(page);
  await expect(guest.getByRole('heading', { name: 'A moment in the garden' })).toBeVisible();
  await expect(
    guest.getByRole('button', { name: 'Play for everyone', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Play for everyone', exact: true }).last().click();
  await expect
    .poll(() => guest.locator('.player-screen video').evaluate((el: HTMLVideoElement) => el.paused))
    .toBe(false);
  await page.getByRole('button', { name: 'Pause for everyone', exact: true }).click();
  await expect
    .poll(() => guest.locator('.player-screen video').evaluate((el: HTMLVideoElement) => el.paused))
    .toBe(true);
  await page.getByRole('slider', { name: 'Seek for everyone' }).fill('3');
  await expect
    .poll(() =>
      guest
        .locator('.player-screen video')
        .evaluate((el: HTMLVideoElement) => Math.abs(el.currentTime - 3)),
    )
    .toBeLessThan(0.3);
  await page.getByRole('combobox', { name: 'Playback speed for everyone' }).selectOption('1.5');
  await expect(guest.getByRole('combobox', { name: 'Playback speed for everyone' })).toHaveValue(
    '1.5',
  );
  await page.getByRole('button', { name: 'Room settings' }).click();
  await page.getByRole('switch', { name: 'Everyone can control playback' }).click();
  await page.getByRole('switch', { name: 'Lock room' }).click();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await expect(
    guest.getByRole('button', { name: 'Play for everyone', exact: true }).last(),
  ).toBeEnabled();
  await guest.reload();
  await expect(guest.getByRole('heading', { name: 'A moment in the garden' })).toBeVisible();
  await expect(guest.getByText('Ready for movie night? 🍿', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  await page.screenshot({ path: 'test-results/desktop-room-active.png', fullPage: true });
  await page.getByRole('button', { name: 'Invite friends', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Better with your people.' })).toBeVisible();
  await expect(page.getByLabel('Or share the link')).toHaveValue(url);
  await page.getByRole('button', { name: 'Close dialog' }).click();
  expect(errors).toEqual([]);
  await guestContext.close();
});
test('voice and video connect with simulated devices, and the call can be left independently', async ({
  page,
  browser,
}) => {
  const url = await createRoom(page);
  const context = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const guest = await context.newPage();
  await joinRoom(guest, url);
  await page.getByRole('button', { name: 'Join call', exact: true }).click();
  await guest.getByRole('button', { name: 'Join call', exact: true }).click();
  await expect(page.getByText('2 people in the call', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Turn camera on' }).click();
  await guest.getByRole('button', { name: 'Turn camera on' }).click();
  await expect
    .poll(
      () =>
        guest
          .locator('.person-tile')
          .filter({ hasText: 'Advitiya' })
          .locator('video')
          .evaluate((el: HTMLVideoElement) => el.readyState),
      { timeout: 30_000 },
    )
    .toBeGreaterThanOrEqual(2);
  await expect
    .poll(
      () =>
        page
          .locator('.person-tile')
          .filter({ hasText: 'Rahul' })
          .locator('video')
          .evaluate((el: HTMLVideoElement) => el.readyState),
      { timeout: 30_000 },
    )
    .toBeGreaterThanOrEqual(2);
  await page.getByRole('button', { name: 'Mute microphone' }).click();
  await expect(page.getByRole('button', { name: 'Unmute microphone' })).toBeVisible();
  await page.getByRole('button', { name: 'Turn camera off' }).click();
  await expect(page.getByRole('button', { name: 'Turn camera on' })).toBeVisible();
  await page.getByRole('button', { name: 'Leave call', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Join call', exact: true })).toBeVisible();
  await expect(page.getByText('2 people here')).toBeVisible();
  await context.close();
});
test('mobile has no horizontal overflow and switches between watch, chat, people, and calls', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: 'test-results/mobile-home.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await createRoom(page, 'Maya');
  await page.screenshot({ path: 'test-results/mobile-room.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page
    .getByRole('navigation', { name: 'Room navigation' })
    .getByRole('button', { name: 'Chat', exact: true })
    .click();
  await expect(page.getByRole('textbox', { name: 'Message your room' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Message your room' }).fill('Hello from my phone!');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('Hello from my phone!', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/mobile-chat.png', fullPage: true });
  await page
    .getByRole('navigation', { name: 'Room navigation' })
    .getByRole('button', { name: 'People', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Good company' })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Room navigation' })
    .getByRole('button', { name: 'Call', exact: true })
    .click();
  await expect(page.getByText('Save someone a seat')).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Room navigation' })
    .getByRole('button', { name: 'Watch', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'What are we watching?' })).toBeVisible();
});
test('invalid room codes display helpful errors, and dialogs work with the keyboard', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Join a room', exact: true }).first().click();
  await page.getByLabel('Your name').fill('Maya');
  await page.getByLabel('Room code').fill('ZZZZZZ');
  await page.getByRole('button', { name: 'Let me in' }).click();
  await expect(page.getByRole('alert')).toContainText('could not be found');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('the shared queue advances once at the end, plays a file from the device, and can be cleared', async ({
  page,
}) => {
  await page.route('https://media.example.test/flower.mp4', serveMedia);
  await createRoom(page);
  await addFixture(page);
  await page.getByRole('button', { name: 'Add media', exact: true }).click();
  await page.getByRole('button', { name: 'Play without uploading' }).click();
  await page.getByLabel('Video or song').setInputFiles(fixture);
  await expect(page.getByLabel('Give it a title')).toHaveValue('flower');
  await page.getByLabel('Give it a title').fill('Big Buck Bunny');
  await page.getByRole('button', { name: 'Add to our queue' }).click();
  await expect(page.locator('.queue-item')).toHaveCount(2);
  await page.getByRole('slider', { name: 'Seek for everyone' }).fill('4.8');
  await expect(page.locator('.player-time')).toContainText('0:04');
  await page.getByRole('button', { name: 'Play for everyone', exact: true }).last().click();
  await expect(page.getByRole('heading', { name: 'Big Buck Bunny', exact: true })).toBeVisible();
  // The file added from this device plays here without being asked for again.
  await expect
    .poll(() =>
      page
        .locator('.player-screen video')
        .evaluate((el: HTMLVideoElement) => el.src.startsWith('blob:') && el.currentTime > 0),
    )
    .toBe(true);
  await page.getByRole('button', { name: 'Pause for everyone', exact: true }).click();
  await page.getByRole('button', { name: 'Remove Big Buck Bunny' }).click();
  await expect(
    page.getByRole('heading', { name: 'A moment in the garden', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Remove A moment in the garden' }).click();
  await expect(page.getByRole('heading', { name: 'What are we watching?' })).toBeVisible();
  await page.getByRole('button', { name: 'React 🍿', exact: true }).click();
  await expect(page.locator('.floating-reactions')).toContainText('Advitiya');
});

test('a file played without uploading streams to friends from the device it is on, in sync', async ({
  page,
  browser,
}) => {
  const requests: string[] = [];
  page.on('request', (request) => requests.push(`${request.method()} ${request.url()}`));
  const url = await createRoom(page);
  const context = await browser.newContext();
  const guest = await context.newPage();
  await joinRoom(guest, url);

  await page.getByRole('button', { name: 'Choose something to watch' }).click();
  await page.getByRole('button', { name: 'Play without uploading' }).click();
  await page.getByLabel('Video or song').setInputFiles(fixture);
  await page.getByRole('button', { name: 'Add to our queue' }).click();
  await expect(page.getByRole('heading', { name: 'flower', exact: true })).toBeVisible();

  // The guest isn't asked for the file: it arrives from the sharer's device.
  const video = (p: Page) => p.locator('.player-screen video');
  await expect
    .poll(
      () =>
        video(guest).evaluate(
          (el: HTMLVideoElement) => el.src.includes('/p2p/') && el.readyState >= 3,
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
  await expect(guest.getByText('on this device')).toHaveCount(0);
  expect(await video(guest).evaluate((el: HTMLVideoElement) => el.duration)).toBeGreaterThan(4);
  // Nothing was uploaded anywhere.
  expect(requests.filter((r) => !r.startsWith('GET ') && !r.includes('/socket.io/'))).toEqual([]);

  await page.getByRole('slider', { name: 'Seek for everyone' }).fill('2');
  await expect
    .poll(() => video(guest).evaluate((el: HTMLVideoElement) => Math.abs(el.currentTime - 2) < 0.3))
    .toBe(true);
  await page.getByRole('button', { name: 'Play for everyone', exact: true }).last().click();
  for (const p of [page, guest])
    await expect
      .poll(() => video(p).evaluate((el: HTMLVideoElement) => !el.paused && el.currentTime > 2))
      .toBe(true);
  const [mine, theirs] = await Promise.all(
    [page, guest].map((p) => video(p).evaluate((el: HTMLVideoElement) => el.currentTime)),
  );
  expect(Math.abs(mine - theirs)).toBeLessThan(0.5);
  await context.close();
});

test('when the sharer is away, someone with the same file can play their own copy', async ({
  page,
  browser,
}) => {
  const requests: string[] = [];
  page.on('request', (request) => requests.push(`${request.method()} ${request.url()}`));
  const url = await createRoom(page);
  const context = await browser.newContext();
  const guest = await context.newPage();
  await joinRoom(guest, url);

  await page.getByRole('button', { name: 'Choose something to watch' }).click();
  await page.getByRole('button', { name: 'Play without uploading' }).click();
  await page.getByLabel('Video or song').setInputFiles(fixture);
  await page.getByRole('button', { name: 'Add to our queue' }).click();
  await expect(page.getByRole('heading', { name: 'flower', exact: true })).toBeVisible();
  // The sharer reloads: the file is no longer open there, so it's asked for again...
  await page.reload();
  await expect(page.getByText('Choose the file again to carry on.')).toBeVisible();
  // ...and meanwhile the guest waits, or plays their own copy.
  await expect(guest.getByText('Waiting for Advitiya’s device…')).toBeVisible({ timeout: 30_000 });
  await guest.getByLabel('Choose the file').setInputFiles(fixture);
  await expect(guest.getByText('Waiting for Advitiya’s device…')).toHaveCount(0);
  await expect
    .poll(() =>
      guest
        .locator('.player-screen video')
        .evaluate((el: HTMLVideoElement) => el.src.startsWith('blob:') && el.readyState >= 2),
    )
    .toBe(true);
  await context.close();
});
