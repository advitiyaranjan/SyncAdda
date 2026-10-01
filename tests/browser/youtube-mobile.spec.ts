import { test, expect, type Page } from '@playwright/test';

// Reproduce mobile IFrame API timing: a long initial buffer reports time zero, and
// another cue/play command interrupts it. Real network embeds cannot reliably force this.
async function mobileYouTube(page: Page, blocked = false, startupMs = 4500) {
  await page.route('https://www.youtube.com/oembed**', (route) =>
    route.fulfill({ json: { title: 'Mobile sync regression' } }),
  );
  await page.addInitScript(
    ({ blocked, startupMs }) => {
      const test = { blocked, plays: 0, cues: 0, seeks: 0, state: 5, time: 0 };
      (window as any).__youtubeTest = test;
      (window as any).YT = {
        Player: class {
          events: any;
          position = 0;
          rate = 1;
          since = Date.now();
          started = false;
          timer: any;
          constructor(element: HTMLElement, options: any) {
            this.events = options.events;
            element.textContent = 'YouTube timing fixture';
            setTimeout(() => this.events.onReady(), 0);
          }
          emit(state: number) {
            test.state = state;
            this.events.onStateChange({ data: state });
          }
          playVideo() {
            test.plays++;
            if (test.blocked) return setTimeout(() => this.events.onAutoplayBlocked(), 0);
            this.buffer(this.started ? 150 : startupMs);
          }
          buffer(ms: number) {
            clearTimeout(this.timer);
            test.time = 0;
            this.emit(3);
            this.timer = setTimeout(() => {
              this.started = true;
              this.since = Date.now();
              test.time = this.position;
              this.emit(1);
            }, ms);
          }
          pauseVideo() {
            this.position = this.getCurrentTime();
            clearTimeout(this.timer);
            this.emit(2);
          }
          seekTo(time: number) {
            test.seeks++;
            this.position = time;
            if (test.state === 1 || test.state === 3) this.buffer(this.started ? 150 : startupMs);
            else {
              test.time = time;
              this.emit(2);
            }
          }
          cueVideoById({ startSeconds = 0 }) {
            test.cues++;
            clearTimeout(this.timer);
            this.position = startSeconds;
            test.time = 0;
            this.emit(5);
          }
          getCurrentTime() {
            return test.state === 1
              ? this.position + ((Date.now() - this.since) / 1000) * this.rate
              : test.time;
          }
          getDuration() {
            return 600;
          }
          getPlayerState() {
            return test.state;
          }
          getPlaybackRate() {
            return this.rate;
          }
          setPlaybackRate(rate: number) {
            this.rate = rate;
          }
          setVolume() {}
          mute() {}
          unMute() {}
          unloadModule() {}
          destroy() {
            clearTimeout(this.timer);
          }
        },
      };
    },
    { blocked, startupMs },
  );
}

async function hostRoom(page: Page) {
  await mobileYouTube(page, false, 100);
  await page.goto(process.env.SYNCADDA_URL || '/');
  await page.getByRole('button', { name: 'Create a room', exact: true }).first().click();
  await page.getByLabel('Your name').fill('Host');
  await page.getByRole('button', { name: 'Create my room' }).click();
  await expect(page).toHaveURL(/\/room\/[A-Z2-9]{6}$/);
  await page.getByRole('button', { name: 'Choose something to watch' }).click();
  await page.getByLabel('Media link').fill('https://www.youtube.com/watch?v=aqz-KE-bpKQ');
  await page.getByLabel('Give it a title').fill('Mobile sync regression');
  await page.getByRole('button', { name: 'Add to our queue' }).click();
  await expect(page.locator('.youtube-host')).toContainText('YouTube timing fixture');
  await expect(page.getByRole('slider', { name: 'Seek for everyone' })).toHaveAttribute(
    'max',
    '600',
  );
  await page.getByRole('slider', { name: 'Seek for everyone' }).fill('60');
  await expect(page.locator('.player-time')).toContainText('1:00');
  await page.getByRole('button', { name: 'Play for everyone', exact: true }).last().click();
  await expect.poll(() => page.evaluate(() => (window as any).__youtubeTest.state)).toBe(1);
}

async function join(page: Page, url: string) {
  await page.goto(url);
  await page.getByLabel('Your name').fill('Phone');
  await page.getByRole('button', { name: 'Let me in' }).click();
  await expect(page.locator('.youtube-host')).toContainText('YouTube timing fixture');
}

const read = (page: Page) => page.evaluate(() => (window as any).__youtubeTest);
const shownTime = (page: Page) =>
  page
    .locator('.player-time')
    .innerText()
    .then((text) => {
      const [minutes, seconds] = text.split('/')[0].trim().split(':').map(Number);
      return minutes * 60 + seconds;
    });

test('a slow phone starts once, keeps its nonzero position and catches up', async ({
  page,
  browser,
}) => {
  await hostRoom(page);
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
  });
  const phone = await context.newPage();
  try {
    await mobileYouTube(phone);
    await join(phone, page.url());
    await expect.poll(async () => (await read(phone)).state).toBe(3);
    await expect(phone.locator('.player-time')).toContainText('1:');
    await phone.waitForTimeout(3000);
    expect(await read(phone)).toMatchObject({ plays: 1, cues: 1, seeks: 0, state: 3 });
    await expect(phone.locator('.autoplay-prompt')).toHaveCount(0);
    await expect.poll(async () => (await read(phone)).state).toBe(1);
    await expect
      .poll(async () => Math.abs((await shownTime(page)) - (await shownTime(phone))))
      .toBeLessThanOrEqual(1);
    await phone.waitForTimeout(4000);
    expect((await read(phone)).plays).toBe(1);
    expect((await read(phone)).seeks).toBeLessThanOrEqual(2);
    await page.getByRole('button', { name: 'Pause for everyone', exact: true }).click();
    await expect.poll(async () => (await read(phone)).state).toBe(2);
  } finally {
    await context.close();
  }
});

test('blocked phone waits for a tap then joins the current timeline without restarting', async ({
  page,
  browser,
}) => {
  await hostRoom(page);
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
  });
  const phone = await context.newPage();
  try {
    await mobileYouTube(phone, true);
    await join(phone, page.url());
    await expect(
      phone.getByRole('button', { name: 'Tap to join playback on this device' }),
    ).toBeVisible();
    const before = await read(phone);
    await phone.waitForTimeout(4500);
    expect(await read(phone)).toMatchObject({
      plays: before.plays,
      cues: before.cues,
      seeks: before.seeks,
    });
    await phone.evaluate(() => {
      (window as any).__youtubeTest.blocked = false;
    });
    await phone.getByRole('button', { name: 'Tap to join playback on this device' }).click();
    await expect.poll(async () => (await read(phone)).state).toBe(1);
    await expect
      .poll(async () => Math.abs((await shownTime(page)) - (await shownTime(phone))))
      .toBeLessThanOrEqual(1);
    // Once with sound and once without before asking for the tap, then the tap itself.
    expect((await read(phone)).plays).toBe(3);
    await expect(phone.locator('.autoplay-prompt')).toHaveCount(0);
  } finally {
    await context.close();
  }
});
