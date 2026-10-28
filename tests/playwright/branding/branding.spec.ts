import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page, type Locator } from '@playwright/test';
import { installOperatorRestRoutes } from '../smoke/fixtures/operator-rest-fixtures.js';
import { installOperatorWebSocketShim } from '../smoke/fixtures/operator-websocket-shim.js';
import { seedTokenBeforeNavigation, waitForRuntimePair } from '../smoke/fixtures/operator-preview-sync.js';

const keys = ['original', 'dark-golden-blond', 'dark-honey-hazel', 'dark-ash-blue-grey', 'dark-chestnut-green', 'dark-sand-amber'];
const files = keys.flatMap((key) => [`saivage-${key}.svg`, `made-with-saivage-${key}.svg`]);
const source = (file: string) => readFileSync(resolve('docs/public/brand', file));

async function size(image: Locator, width: number, height: number) {
  await expect(image).toBeVisible();
  await expect.poll(async () => image.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  const box = (await image.boundingBox())!;
  expect([box.width, box.height]).toEqual([width, height]);
}

function observe(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('requestfailed', (request) => errors.push(request.url()));
  page.on('response', (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  page.on('request', (request) => {
    if (request.resourceType() === 'image' && new URL(request.url()).origin !== 'http://127.0.0.1:4189') errors.push(`external image ${request.url()}`);
  });
  return errors;
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

async function withinViewport(locator: Locator, page: Page) {
  await expect(locator).toBeVisible();
  const box = (await locator.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
}

for (const prefix of ['/docs/', '/saivage-v3/']) {
  test(`${prefix} bundles all variants and original favicon`, async ({ page, request }) => {
    for (const file of files) {
      const response = await request.get(`${prefix}brand/${file}`);
      expect(response.status()).toBe(200);
      expect(response.headers()['content-type']).toMatch(/^image\/svg\+xml/);
      expect(await response.body()).toEqual(source(file));
    }
    await page.goto(prefix);
    await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', `${prefix}brand/saivage-original.svg`);
    await expect(page.locator('link[rel="icon"]')).toHaveAttribute('type', 'image/svg+xml');
  });

  for (const width of [1280, 360]) {
    test(`${prefix} branding, gallery and theme at ${width}px`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' });
      const errors = observe(page);
      await page.goto(prefix);
      for (const dark of [false, true]) {
        if (width === 360) {
          await page.getByRole('button', { name: 'mobile navigation' }).click();
        }
        const toggle = page.getByRole('switch', { name: /dark theme/i }).filter({ visible: true });
        if ((await page.locator('html').getAttribute('class') ?? '').includes('dark') !== dark) await toggle.click();
        if (width === 360) await page.getByRole('button', { name: 'mobile navigation' }).click();
        const file = dark ? 'saivage-dark-golden-blond.svg' : 'saivage-original.svg';
        const nav = page.locator('.VPNavBarTitle img:visible');
        const hero = page.locator('.VPHero img:visible');
        await expect(nav).toHaveAttribute('src', `${prefix}brand/${file}`);
        await expect(hero).toHaveAttribute('src', `${prefix}brand/${file}`);
        await expect(hero).toHaveAttribute('alt', 'Saivage');
        await size(nav, 32, 32);
        await size(hero, 128, 128);
        await noOverflow(page);
        await page.screenshot({ path: info.outputPath(`home-${dark ? 'dark' : 'light'}.png`) });
        await page.goto(`${prefix}brand.html`);
        const badge = page.locator('.brand-usage img:visible');
        await size(badge, 210, 44);
        await expect(badge).toHaveAttribute('src', `${prefix}brand/made-with-${file}`);
        const choices = page.locator('.brand-treatment');
        await expect(choices).toHaveCount(6);
        await expect(choices.getByRole('heading', { name: 'Honey light brown / hazel', exact: true })).toBeVisible();
        await expect(choices.getByRole('heading', { name: 'Light chestnut / green', exact: true })).toBeVisible();
        for (let index = 0; index < keys.length; index++) {
          const choice = choices.nth(index);
          const links = choice.locator('a[download]');
          await expect(links).toHaveCount(2);
          for (const [ordinal, filename] of [`saivage-${keys[index]}.svg`, `made-with-saivage-${keys[index]}.svg`].entries()) {
            await expect(links.nth(ordinal)).toHaveAttribute('href', `${prefix}brand/${filename}`);
          }
          await choice.locator('summary').click();
          await expect(choice.locator('pre').last()).toContainText(`saivage-${keys[index]}.svg`);
          await choice.locator('summary').click();
        }
        const downloadEvent = page.waitForEvent('download');
        await choices.first().locator('a[download]').first().click();
        const download = await downloadEvent;
        expect(readFileSync((await download.path())!)).toEqual(source('saivage-original.svg'));
        await noOverflow(page);
        await page.screenshot({ path: info.outputPath(`gallery-${dark ? 'dark' : 'light'}.png`) });
        await page.goto(prefix);
      }
      expect(errors).toEqual([]);
    });
  }
}

for (const width of [1280, 360]) {
  test(`operator original mark stays on light surface at ${width}px in either OS preference`, async ({ page, request }, info) => {
    const errors = observe(page);
    await page.setViewportSize({ width, height: 900 });
    await seedTokenBeforeNavigation(page, 'synthetic-brand-token');
    await installOperatorRestRoutes(page);
    await installOperatorWebSocketShim(page);
    for (const file of files) {
      const response = await request.get(`/${file}`);
      expect(response.status()).toBe(200);
      expect(response.headers()['content-type']).toMatch(/^image\/svg\+xml/);
      expect(await response.body()).toEqual(source(file));
    }
    let lightBackground = '';
    await waitForRuntimePair(page, () => page.goto('/'));
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      const strip = page.getByTestId('global-strip');
      await size(strip.getByRole('img', { name: 'Saivage', exact: true }), 32, 32);
      await expect(page.getByTestId('strip-project')).toHaveText('project');
      await expect(strip.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
      await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/saivage-original.svg');
      await expect(page.locator('link[rel="icon"]')).toHaveAttribute('type', 'image/svg+xml');
      const background = await strip.evaluate((el) => getComputedStyle(el).backgroundColor);
      if (colorScheme === 'light') lightBackground = background;
      expect(background).toBe(lightBackground);
      await strip.getByRole('link', { name: /Files/ }).focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/\/files$/);
      await expect(page.getByTestId('strip-updates')).toBeVisible();
      for (const control of [strip.getByRole('img', { name: 'Saivage', exact: true }),
        page.getByTestId('strip-project'), page.getByTestId('strip-updates'),
        strip.getByRole('navigation', { name: 'Primary navigation' })]) {
        await withinViewport(control, page);
      }
      await noOverflow(page);
      await page.screenshot({ path: info.outputPath(`operator-${colorScheme}.png`) });
    }
    expect(errors).toEqual([]);
  });
}
