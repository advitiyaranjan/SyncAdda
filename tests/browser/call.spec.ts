import { test, expect, type Browser, type Page } from '@playwright/test';

const base = process.env.SYNCADDA_URL || '';

async function person(browser: Browser, name: string, url?: string) {
  const context = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const page = await context.newPage();
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
  await expect(page.getByRole('button', { name: 'Join call', exact: true })).toBeEnabled();
  return page;
}
async function joinWithCamera(page: Page) {
  await page.getByRole('button', { name: 'Join call', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Leave call', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Turn camera on' }).click();
  await expect(page.getByRole('button', { name: 'Turn camera off' })).toBeVisible();
}
const tileVideo = (viewer: Page, name: string) =>
  viewer.locator('.person-tile').filter({ hasText: name }).locator('video');
async function expectCamera(viewer: Page, name: string) {
  await expect(tileVideo(viewer, name)).toHaveClass(/has-camera/, { timeout: 30_000 });
  await expect
    .poll(
      () =>
        tileVideo(viewer, name).evaluate(
          (el: HTMLVideoElement) => el.readyState >= 2 && el.videoWidth > 0 && !el.paused,
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
}

test('voice is heard with the camera off', async ({ browser }) => {
  const a = await person(browser, 'Asha');
  const b = await person(browser, 'Bina', a.url());
  for (const p of [a, b]) {
    await p.getByRole('button', { name: 'Join call', exact: true }).click();
    await expect(p.getByRole('button', { name: 'Leave call', exact: true })).toBeVisible();
  }
  for (const [viewer, name] of [
    [a, 'Bina'],
    [b, 'Asha'],
  ] as const)
    await expect
      .poll(
        () =>
          viewer
            .locator('.person-tile')
            .filter({ hasText: name })
            .locator('audio')
            .evaluate(
              (el: HTMLAudioElement) =>
                !el.paused &&
                (el.srcObject as MediaStream | null)
                  ?.getAudioTracks()
                  .some((t) => t.readyState === 'live') === true,
            ),
        { timeout: 30_000 },
      )
      .toBe(true);
  for (const p of [a, b]) await p.context().close();
});
// Hosting closes WebSockets every few minutes; calls must carry on through the reconnect.
// Needs a server that can drop every socket, such as tests/support/prod-like-server.js
// (SYNCADDA_DROP_URL=http://localhost:3001/api/test/drop-all).
test('calls and cameras survive the room connection dropping for everyone', async ({ browser }) => {
  test.skip(!process.env.SYNCADDA_DROP_URL, 'needs a server that can drop all sockets');
  const a = await person(browser, 'Asha');
  const b = await person(browser, 'Bina', a.url());
  for (const p of [a, b]) await joinWithCamera(p);
  await expectCamera(a, 'Bina');
  await expectCamera(b, 'Asha');
  await fetch(process.env.SYNCADDA_DROP_URL!, { method: 'POST' });
  for (const p of [a, b]) await expect(p.getByText('Connected', { exact: true })).toBeVisible();
  await expect(a.getByText('2 people in the call', { exact: true })).toBeVisible();
  await a.waitForTimeout(3000);
  await expectCamera(a, 'Bina');
  await expectCamera(b, 'Asha');
  await expect(a.getByRole('button', { name: 'Turn camera off' })).toBeVisible();
  await expect(b.locator('.person-tile').filter({ hasText: 'Asha' })).toContainText(
    /In the call|Speaking/,
  );
  for (const p of [a, b]) await p.context().close();
});
for (const how of ['closes the tab', 'goes back'] as const)
  test(`when one person ${how}, everyone else keeps their cameras`, async ({ browser }) => {
    const a = await person(browser, 'Asha');
    const b = await person(browser, 'Bina', a.url());
    const c = await person(browser, 'Chetan', a.url());
    await expect(a.getByText('3 people here')).toBeVisible();
    for (const p of [a, b, c]) await joinWithCamera(p);
    await expect(a.getByText('3 people in the call', { exact: true })).toBeVisible();
    await expectCamera(a, 'Bina');
    await expectCamera(b, 'Asha');
    await expectCamera(a, 'Chetan');

    if (how === 'goes back') await c.goBack();
    else await c.context().close();
    // A closed tab may not get to say goodbye; the server drops it from the call after 15 seconds.
    await expect(a.getByText('2 people in the call', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    // Give any delayed teardown time to happen before checking.
    await a.waitForTimeout(3000);
    await expectCamera(a, 'Asha');
    await expectCamera(a, 'Bina');
    await expectCamera(b, 'Asha');
    await expectCamera(b, 'Bina');
    await expect(a.getByRole('button', { name: 'Turn camera off' })).toBeVisible();
    await expect(b.getByRole('button', { name: 'Turn camera off' })).toBeVisible();
    for (const p of [a, b, c])
      await p
        .context()
        .close()
        .catch(() => {});
  });
