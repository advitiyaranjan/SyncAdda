import { test, expect, type Page } from '@playwright/test';

// Needs access to vimeo.com.
const shownTime = (page: Page) =>
  page
    .locator('.player-time')
    .innerText()
    .then((text) => {
      const [minutes, seconds] = text.split('/')[0].trim().split(':').map(Number);
      return minutes * 60 + seconds;
    });

test('a Vimeo link plays in its embedded player, in sync for everyone', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await page.getByRole('button', { name: 'Create a room', exact: true }).first().click();
  await page.getByLabel('Your name').fill('Asha');
  await page.getByRole('button', { name: 'Create my room' }).click();
  await expect(page).toHaveURL(/\/room\/[A-Z2-9]{6}$/);
  const context = await browser.newContext();
  const guest = await context.newPage();
  await guest.goto(page.url());
  await guest.getByLabel('Your name').fill('Bina');
  await guest.getByRole('button', { name: 'Let me in' }).click();

  await page.getByRole('button', { name: 'Choose something to watch' }).click();
  await page.getByLabel('Media link').fill('https://vimeo.com/1084537');
  // A site with its own player is always a video.
  await expect(page.getByLabel('Type')).toHaveCount(0);
  await page.getByLabel('Give it a title').fill('From Vimeo');
  await page.getByRole('button', { name: 'Add to our queue' }).click();
  for (const p of [page, guest])
    await expect(p.locator('.embed-frame iframe')).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => page.getByRole('slider', { name: 'Seek for everyone' }).getAttribute('max'), {
      timeout: 30_000,
    })
    .not.toBe('1');
  await page.getByRole('slider', { name: 'Seek for everyone' }).fill('20');
  await page.getByRole('button', { name: 'Play for everyone', exact: true }).last().click();
  for (const p of [page, guest])
    await expect.poll(() => shownTime(p), { timeout: 40_000 }).toBeGreaterThan(22);
  expect(Math.abs((await shownTime(page)) - (await shownTime(guest)))).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: 'Pause for everyone', exact: true }).click();
  const paused = await shownTime(guest);
  await guest.waitForTimeout(2500);
  expect(await shownTime(guest)).toBeLessThanOrEqual(paused + 1);
  await context.close();
});
