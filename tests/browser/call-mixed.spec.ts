import { test, expect, firefox, type Browser, type Page } from '@playwright/test';

// Calls where people have different things switched on: sound and picture must really arrive,
// whichever side has a microphone or camera and whenever they turn it on.
const base = process.env.SYNCADDA_URL || '';
// SYNCADDA_CALL_BROWSERS=firefox,chromium puts the host in Firefox and the guest in Chromium
// (needs `npx playwright install firefox`).
const engines = (process.env.SYNCADDA_CALL_BROWSERS || 'chromium,chromium').split(',');
let fox: Browser | undefined;
test.afterAll(async () => {
  await fox?.close();
});

async function person(browser: Browser, name: string, url?: string) {
  if (engines[url ? 1 : 0] === 'firefox')
    fox ??= await firefox.launch({
      firefoxUserPrefs: {
        'media.navigator.streams.fake': true,
        'media.navigator.permission.disabled': true,
        'media.autoplay.default': 0,
      },
    });
  const context =
    engines[url ? 1 : 0] === 'firefox'
      ? await fox!.newContext({
          baseURL: base || 'http://localhost:5173',
          viewport: { width: 1440, height: 1024 },
          permissions: [],
        })
      : await browser.newContext({ permissions: ['camera', 'microphone'] });
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
const tile = (viewer: Page, name: string) =>
  viewer.locator('.people-tiles .person-tile').filter({ hasText: name });
// The loudest the other person's sound gets over two seconds (the test microphone beeps).
const loudness = (viewer: Page, name: string) =>
  tile(viewer, name)
    .locator('audio')
    .first()
    .evaluate(async (el: HTMLAudioElement) => {
      const stream = el.srcObject as MediaStream | null;
      if (!stream || el.paused) return -1;
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      context.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      let peak = 0;
      for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        analyser.getByteFrequencyData(data);
        peak = Math.max(peak, ...data);
      }
      await context.close();
      return peak;
    });
const hears = (viewer: Page, name: string) =>
  expect.poll(() => loudness(viewer, name), { timeout: 30_000 }).toBeGreaterThan(20);
const hearsNothing = (viewer: Page, name: string) =>
  expect.poll(() => loudness(viewer, name), { timeout: 30_000 }).toBeLessThanOrEqual(0);
// The picture is shown and its frames keep coming.
const sees = (viewer: Page, name: string) =>
  expect
    .poll(
      () =>
        tile(viewer, name)
          .locator('video')
          .first()
          .evaluate(async (el: HTMLVideoElement) => {
            if (!el.classList.contains('has-camera') || !el.videoWidth || el.paused) return false;
            const before = el.currentTime;
            await new Promise((resolve) => setTimeout(resolve, 700));
            return el.currentTime > before;
          }),
      { timeout: 30_000 },
    )
    .toBe(true);
const seesNoCamera = (viewer: Page, name: string) =>
  expect(tile(viewer, name).locator('video').first()).not.toHaveClass(/has-camera/, {
    timeout: 30_000,
  });
const click = (page: Page, name: string) => page.getByRole('button', { name, exact: true }).click();
async function close(...pages: Page[]) {
  for (const p of pages) await p.context().close();
}

// Who makes the offer depends on the ids, so each mix is tried from both sides.
for (const first of ['host', 'guest'] as const) {
  test(`voice only, then cameras come and go (${first} joins first)`, async ({ browser }) => {
    const host = await person(browser, 'Asha');
    const guest = await person(browser, 'Bina', host.url());
    const [a, b] = first === 'host' ? [host, guest] : [guest, host];
    const [aName, bName] = first === 'host' ? ['Asha', 'Bina'] : ['Bina', 'Asha'];
    await click(a, 'Join call');
    await click(b, 'Join call');
    await hears(a, bName);
    await hears(b, aName);

    await click(a, 'Turn camera on');
    await sees(b, aName);
    await seesNoCamera(a, bName);
    await hears(a, bName);
    await hears(b, aName);

    await click(a, 'Turn camera off');
    await seesNoCamera(b, aName);
    await click(a, 'Turn camera on');
    await sees(b, aName);
    await click(b, 'Turn camera on');
    await sees(a, bName);

    await click(b, 'Mute microphone');
    await hearsNothing(a, bName);
    await hears(b, aName);
    await click(b, 'Unmute microphone');
    await hears(a, bName);
    await close(host, guest);
  });

  test(`camera only, microphone later (${first} joins first)`, async ({ browser }) => {
    const host = await person(browser, 'Asha');
    const guest = await person(browser, 'Bina', host.url());
    const [a, b] = first === 'host' ? [host, guest] : [guest, host];
    const [aName, bName] = first === 'host' ? ['Asha', 'Bina'] : ['Bina', 'Asha'];
    await click(a, 'Turn camera on');
    await click(b, 'Turn camera on');
    await sees(a, bName);
    await sees(b, aName);
    await click(b, 'Unmute microphone');
    await hears(a, bName);
    await sees(a, bName);
    await close(host, guest);
  });

  test(`one has everything on, the other only listens (${first} joins first)`, async ({
    browser,
  }) => {
    const host = await person(browser, 'Asha');
    const guest = await person(browser, 'Bina', host.url());
    const [a, b] = first === 'host' ? [host, guest] : [guest, host];
    const [aName, bName] = first === 'host' ? ['Asha', 'Bina'] : ['Bina', 'Asha'];
    await click(a, 'Join call');
    await click(a, 'Turn camera on');
    await click(b, 'Join call');
    await click(b, 'Mute microphone');
    await sees(b, aName);
    await hears(b, aName);
    await hearsNothing(a, bName);

    // Leaving and coming back starts a fresh connection.
    await click(b, 'Leave call');
    await click(b, 'Join call');
    await sees(b, aName);
    await hears(b, aName);
    await hears(a, bName);
    await close(host, guest);
  });
}
