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

async function joinCallWithCamera(page: Page) {
  await page.getByRole('button', { name: 'Join call', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Leave call', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Turn camera on' }).click();
  await expect(page.getByRole('button', { name: 'Turn camera off' })).toBeVisible();
}
async function expectCamera(viewer: Page, name: string) {
  const video = viewer.locator('.person-tile').filter({ hasText: name }).locator('video');
  await expect(video).toHaveClass(/has-camera/, { timeout: 30_000 });
  await expect
    .poll(
      () =>
        video.evaluate(
          (el: HTMLVideoElement) => el.readyState >= 2 && el.videoWidth > 0 && !el.paused,
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
}

// Vercel ends every WebSocket after about five minutes and the app reconnects. This waits for
// a real one, so it takes about six minutes and runs only when asked, against a deployment:
// SYNCADDA_URL=https://adda.advitiyaranjan.in SYNCADDA_LIVE_RECONNECT=1
test('the owner keeps the room, permissions, and the call through a real hosting reconnect', async ({
  browser,
}) => {
  test.skip(
    !base || !process.env.SYNCADDA_LIVE_RECONNECT,
    'set SYNCADDA_URL to a deployment and SYNCADDA_LIVE_RECONNECT=1',
  );
  test.setTimeout(10 * 60_000);
  const open = async () => {
    const context = await browser.newContext({ permissions: ['camera', 'microphone'] });
    const page = await context.newPage();
    const sockets: { opened: number; closed?: number }[] = [];
    page.on('websocket', (ws) => {
      if (!ws.url().includes('/api/socket')) return;
      const entry: { opened: number; closed?: number } = { opened: Date.now() };
      sockets.push(entry);
      ws.on('close', () => (entry.closed = Date.now()));
    });
    return { page, sockets };
  };
  const host = await open(),
    guest = await open();
  await enter(host.page, 'Asha');
  await enter(guest.page, 'Bina', host.page.url());

  // Before the reconnect: the guest may add to the queue, there's a video, and a call is on.
  await host.page.getByRole('tab', { name: /People/ }).click();
  await host.page.getByLabel('Manage Bina').click();
  await host.page.getByRole('button', { name: 'Let them add to queue' }).click();
  await expect(guest.page.getByRole('button', { name: 'Add media' })).toBeVisible();
  await addVideo(host.page, 'After the reconnect');
  for (const p of [host.page, guest.page]) await joinCallWithCamera(p);
  await expectCamera(host.page, 'Bina');
  await expectCamera(guest.page, 'Asha');

  // Wait for hosting to close each person's connection and the app to reconnect.
  for (const [name, who] of [
    ['host', host],
    ['guest', guest],
  ] as const) {
    await expect
      .poll(() => who.sockets.length, { timeout: 8 * 60_000, intervals: [5_000] })
      .toBeGreaterThanOrEqual(2);
    const [first, second] = who.sockets;
    console.log(
      `${name}: connection closed after ${((first.closed! - first.opened) / 1000).toFixed(0)}s, ` +
        `reconnected ${((second.opened - first.closed!) / 1000).toFixed(1)}s later`,
    );
  }
  for (const p of [host.page, guest.page])
    await expect(p.getByText('Connected', { exact: true })).toBeVisible();

  // The owner is still the owner, on both screens.
  await expect(host.page.getByRole('button', { name: 'Room settings' })).toBeVisible();
  await expect(guest.page.getByRole('button', { name: 'Room settings' })).toHaveCount(0);
  for (const p of [host.page, guest.page]) {
    await p.getByRole('tab', { name: /People/ }).click();
    await expect(p.locator('.participant-row').filter({ hasText: 'Asha' })).toContainText(
      'Room host',
    );
  }
  // The guest kept queue access, but still doesn't have the remote.
  await expect(guest.page.getByRole('button', { name: 'Add media' })).toBeVisible();
  await expect(
    guest.page.getByRole('button', { name: 'Play for everyone', exact: true }).last(),
  ).toBeDisabled();
  // The owner's controls still reach everyone.
  await host.page.getByRole('button', { name: 'Play for everyone', exact: true }).last().click();
  await expect
    .poll(() =>
      guest.page.locator('.player-screen video').evaluate((el: HTMLVideoElement) => el.paused),
    )
    .toBe(false);
  // And the call carried on through the reconnect.
  await expect(host.page.getByText('2 people in the call', { exact: true })).toBeVisible();
  await expectCamera(host.page, 'Bina');
  await expectCamera(guest.page, 'Asha');
  for (const who of [host, guest]) await who.page.context().close();
});

// Needs a server that can drop every socket, such as tests/support/prod-like-server.js
// (SYNCADDA_DROP_URL=http://localhost:3001/api/test/drop-all).
test('the owner stays in the room when the server is briefly busy after a reconnect', async ({
  browser,
}) => {
  test.skip(!process.env.SYNCADDA_DROP_URL, 'needs a server that can drop all sockets');
  test.setTimeout(90_000);
  const [host, guest] = await Promise.all(
    [0, 1].map(async () => (await browser.newContext()).newPage()),
  );
  await enter(host, 'Asha');
  await enter(guest, 'Bina', host.url());
  // Longer than one rejoin attempt waits for the room, so the first attempt fails as "busy".
  await fetch(`${process.env.SYNCADDA_DROP_URL}?busyMs=15000`, { method: 'POST' });
  await host.waitForTimeout(20_000);
  for (const p of [host, guest]) {
    await expect(p.getByRole('heading', { name: 'Your people are waiting.' })).toHaveCount(0);
    await expect(p.getByText('Connected', { exact: true })).toBeVisible();
  }
  await expect(host.getByRole('button', { name: 'Room settings' })).toBeVisible();
  await addVideo(host, 'Still the host');
  await expect(guest.getByRole('heading', { name: 'Still the host', exact: true })).toBeVisible();
  await guest.getByRole('tab', { name: /People/ }).click();
  await expect(guest.locator('.participant-row').filter({ hasText: 'Asha' })).toContainText(
    'Room host',
  );
  for (const p of [host, guest]) await p.context().close();
});

test('the player fills the screen height, and fullscreen controls hide after 5 seconds', async ({
  page,
}) => {
  await enter(page, 'Asha');
  const screen = (await page.locator('.player-screen').boundingBox())!;
  expect(screen.height).toBeGreaterThan((screen.width * 9) / 16 + 50);
  await addVideo(page, 'Big screen');
  await page.getByRole('button', { name: 'Fullscreen' }).click();
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
  const shell = page.locator('.player-shell');
  await expect(shell).not.toHaveClass(/controls-hidden/);
  await expect(shell).toHaveClass(/controls-hidden/, { timeout: 8_000 });
  await page.mouse.move(200, 200);
  await page.mouse.move(300, 300);
  await expect(shell).not.toHaveClass(/controls-hidden/);
});

test('chat fills its panel, the Video tab shows friends, and fullscreen has a see-through chat', async ({
  page,
  browser,
}) => {
  await enter(page, 'Asha');
  const guest = await (await browser.newContext()).newPage();
  await enter(guest, 'Bina', page.url());
  await expect(page.getByText('A place for the running commentary.')).toHaveCount(0);

  // The Video tab: everyone's tile, video only (their sound plays from the main tiles).
  await page.getByRole('tab', { name: 'Video' }).click();
  const tiles = page.locator('.video-panel .person-tile');
  await expect(tiles).toHaveCount(2);
  await expect(page.locator('.video-panel audio')).toHaveCount(0);

  // Fullscreen: chat over the video, reactions, and a way to tuck it away.
  await addVideo(page, 'Movie night');
  await page.getByRole('button', { name: 'Fullscreen' }).click();
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
  const fsChat = page.locator('.fs-chat');
  await expect(fsChat).toBeVisible();
  await page.getByLabel('Chat while watching').fill('Best scene!');
  await page.keyboard.press('Enter');
  await expect(guest.getByText('Best scene!', { exact: true })).toBeVisible();
  await expect(fsChat.getByText('Best scene!')).toBeVisible();
  await guest.getByRole('textbox', { name: 'Message your room' }).fill('Agreed');
  await guest.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(fsChat.getByText('Agreed')).toBeVisible();
  await fsChat.getByRole('button', { name: 'React 🔥' }).click();
  await expect(page.locator('.fs-reactions')).toContainText('🔥');
  await page.getByRole('button', { name: 'Hide chat' }).click();
  await expect(fsChat).toHaveCount(0);
  await page.getByRole('button', { name: 'Show chat' }).click();
  await expect(fsChat).toBeVisible();
  await guest.context().close();
});

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
