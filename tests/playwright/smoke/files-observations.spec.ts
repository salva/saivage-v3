import { expect, test, type Page, type Route } from '@playwright/test';
import { parseOperatorResponse } from '../../../src/contracts/operator-api.js';
import { installOperatorRestRoutes } from './fixtures/operator-rest-fixtures.js';
import { waitForRuntimePair } from './fixtures/operator-preview-sync.js';
import { installOperatorWebSocketShim } from './fixtures/operator-websocket-shim.js';

const meta = '.saivage';
const output = '.saivage/work';
const parent = '.saivage/logs';
const file = `${parent}/app.txt`;
const other = `${parent}/other.txt`;
const modifiedAt = '2026-10-15T00:00:00.000Z';
const entry = (path: string) => ({ name: path.split('/').at(-1)!, path, type: 'file' as const, size: 10, modifiedAt });
type Outcome = { status: number; body: unknown };
const listing = (path: string, paths: string[] = []) => ({ status: 200, body: { path, files: paths.map(entry) } });
const content = (path: string, text: string) => ({ status: 200, body: { path, size: text.length, contentType: 'text/plain', content: text, redacted: false, sensitivity: 'normal' } });
const missing = (path: string, error = 'File not found') => ({ status: 404, body: { path, error } });

async function fixture(page: Page) {
  await installOperatorWebSocketShim(page);
  const rest = await installOperatorRestRoutes(page);
  const directories = new Map<string, Outcome>([[meta, listing(meta, [file])], [output, listing(output)], [parent, listing(parent, [file, other])]]);
  const previews = new Map<string, Outcome>([[file, content(file, 'original preview')], [other, content(other, 'other preview')]]);
  const held = new Map<string, Promise<Outcome>>();
  const heldPreviews = new Map<string, Promise<Outcome>>();
  const requests: string[] = [];
  async function reply(route: Route, operation: 'files.list' | 'files.content', outcome: Outcome) {
    await route.fulfill({ status: outcome.status, contentType: 'application/json', body: JSON.stringify(parseOperatorResponse(operation, outcome.status, outcome.body)) });
  }
  await page.route('**/api/files?**', async route => {
    const path = new URL(route.request().url()).searchParams.get('path') ?? meta;
    requests.push(`list:${path}`);
    const pending = held.get(path);
    held.delete(path);
    await reply(route, 'files.list', pending ? await pending : directories.get(path) ?? missing(path));
  });
  await page.route('**/api/files/content?**', async route => {
    const path = new URL(route.request().url()).searchParams.get('path')!;
    requests.push(`preview:${path}`);
    const pending = heldPreviews.get(path);
    heldPreviews.delete(path);
    await reply(route, 'files.content', pending ? await pending : previews.get(path) ?? missing(path));
  });
  return {
    rest, directories, previews, requests,
    hold(path: string) {
      let release!: (outcome: Outcome) => void;
      held.set(path, new Promise(resolve => { release = resolve; }));
      return release;
    },
    holdPreview(path: string) {
      let release!: (outcome: Outcome) => void;
      heldPreviews.set(path, new Promise(resolve => { release = resolve; }));
      return release;
    },
  };
}

async function pauseClock(page: Page) {
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100));
}

async function reconnect(page: Page) {
  const sockets = await page.evaluate(() => window.__saivageWsFixture!.sockets.length);
  await page.evaluate(() => window.__saivageWsFixture!.closeAll());
  await page.clock.runFor(5_000);
  await expect.poll(() => page.evaluate(() => window.__saivageWsFixture!.sockets.length)).toBe(sockets + 1);
  // Ticket REST completion creates the replacement socket after the clock run;
  // its shim-owned open callback is a separate zero-delay task.
  await page.clock.runFor(100);
  await expect(page.getByTestId('strip-socket')).toHaveText('Connected');
}

test('preview and elapsed age do not observe changed directory entries; manual and reconnect reads do', async ({ page }) => {
  await page.clock.install();
  const f = await fixture(page);
  await waitForRuntimePair(page, () => page.goto('/files?root=meta&path=.saivage'));
  await expect(page.getByTestId('files-list').getByText('app.txt', { exact: true })).toBeVisible();
  await pauseClock(page);
  const initial = f.requests.length;
  f.directories.set(meta, listing(meta, [file, `${meta}/changed.txt`]));
  await page.clock.runFor(29_000);
  await page.getByTestId('files-list').getByText('app.txt', { exact: true }).click();
  await expect(page.getByTestId('files-viewer')).toContainText('original preview');
  await page.clock.runFor(2_000);
  await expect(page.getByTestId('files-status-banner')).toContainText('read at least 30 seconds ago');
  await expect(page.getByTestId('files-list')).not.toContainText('changed.txt');
  expect(f.requests.slice(initial)).toEqual([`preview:${file}`]);

  f.previews.set(file, content(file, 'manual preview'));
  let before = f.requests.length;
  await page.getByTestId('files-refresh').click();
  await expect(page.getByTestId('files-viewer')).toContainText('manual preview');
  await expect(page.getByTestId('files-list')).toContainText('changed.txt');
  await expect(page.getByTestId('files-status-banner')).toHaveCount(0);
  expect(f.requests.slice(before)).toEqual([`list:${meta}`, `preview:${file}`]);

  f.directories.set(meta, listing(meta, [file, `${meta}/reconnected.txt`]));
  f.previews.set(file, content(file, 'reconnected preview'));
  before = f.requests.length;
  await reconnect(page);
  await expect(page.getByTestId('files-viewer')).toContainText('reconnected preview');
  await expect(page.getByTestId('files-list')).toContainText('reconnected.txt');
  expect(f.requests.slice(before)).toEqual([`list:${meta}`, `preview:${file}`]);
  expect(f.rest.unknown).toEqual([]);
});

test('deep-file reconnect keeps delayed/failed listing age separate from preview outcome and root errors', async ({ page }) => {
  await page.clock.install();
  const f = await fixture(page);
  await waitForRuntimePair(page, () => page.goto(`/files?root=meta&path=${encodeURIComponent(file)}`));
  await expect(page.getByTestId('files-viewer')).toContainText('original preview');
  await expect(page.getByTestId('files-breadcrumbs')).toContainText('logs');
  await pauseClock(page);
  await page.clock.runFor(31_000);
  const release = f.hold(parent);
  let before = f.requests.length;
  f.previews.set(file, content(file, 'preview despite failed directory'));
  await reconnect(page);
  await expect(page.getByTestId('files-loading')).toBeVisible();
  await expect(page.getByTestId('files-status-banner')).toContainText('read at least 30 seconds ago');
  expect(f.requests.slice(before)).toEqual([`list:${parent}`]);
  release(missing(parent, 'Directory read failed'));
  await expect(page.getByTestId('files-viewer')).toContainText('preview despite failed directory');
  await expect(page.getByTestId('files-list-error')).toContainText('Directory read failed');
  await expect(page.getByTestId('files-status-banner')).toBeVisible();
  await expect(page.getByTestId('files-list')).toContainText('app.txt');
  expect(f.requests.slice(before)).toEqual([`list:${parent}`, `preview:${file}`]);

  // The inactive Output read cannot erase Metadata's failed observation.
  await page.getByRole('button', { name: 'Output', exact: true }).click();
  await expect(page.getByTestId('files-empty')).toBeVisible();
  await expect(page.getByTestId('files-list-error')).toHaveCount(0);
  await expect(page.getByTestId('files-status-banner')).toHaveCount(0);
  f.directories.set(meta, missing(meta, 'Metadata unavailable'));
  f.directories.set(parent, missing(parent, 'Metadata unavailable'));
  await page.getByRole('button', { name: 'Metadata', exact: true }).click();
  await expect(page.getByTestId('files-list-error')).toContainText('Metadata unavailable');
  await expect(page.getByTestId('files-status-banner')).toContainText('read at least 30 seconds ago');
  await expect(page.getByTestId('files-empty')).toHaveCount(0);

  // Re-enter the exact deep-file route, then reverse the independent outcomes.
  f.directories.set(parent, listing(parent, [file, other]));
  await page.clock.resume();
  await page.goto(`/files?root=meta&path=${encodeURIComponent(file)}`);
  await expect(page.getByTestId('files-viewer')).toContainText('preview despite failed directory');
  await pauseClock(page);
  await page.clock.runFor(31_000);
  const releaseSuccess = f.hold(parent);
  f.previews.set(file, missing(file));
  before = f.requests.length;
  await reconnect(page);
  await expect(page.getByTestId('files-status-banner')).toBeVisible();
  releaseSuccess(listing(parent, [file, other]));
  await expect(page.getByTestId('files-viewer')).toContainText('File not found');
  await expect(page.getByTestId('files-list-error')).toHaveCount(0);
  await expect(page.getByTestId('files-status-banner')).toHaveCount(0);
  expect(f.requests.slice(before)).toEqual([`list:${parent}`, `preview:${file}`]);
  expect(f.rest.unknown).toEqual([]);
});

for (const departure of ['selection', 'root', 'route'] as const) {
  test(`delayed refresh cannot revive the old preview after ${departure} departure`, async ({ page }) => {
    const f = await fixture(page);
    await waitForRuntimePair(page, () => page.goto(`/files?root=meta&path=${encodeURIComponent(file)}`));
    await expect(page.getByTestId('files-viewer')).toContainText('original preview');
    const release = f.hold(parent);
    const before = f.requests.length;
    await page.getByTestId('files-refresh').click();
    await expect(page.getByTestId('files-loading')).toBeVisible();
    if (departure === 'selection') {
      // Closing the selected preview is possible while the listing is pending.
      await page.locator('.viewer-close-btn').click();
    } else if (departure === 'root') {
      await page.getByRole('button', { name: 'Output', exact: true }).click();
      await expect(page.getByTestId('files-empty')).toBeVisible();
    } else {
      await page.getByRole('link', { name: 'System 3', exact: true }).click();
      await expect(page.getByTestId('route-files')).toHaveCount(0);
    }
    const completed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/files' && new URL(response.url()).searchParams.get('path') === parent);
    release(listing(parent, [file, other]));
    await completed;
    // Wait for the held response/continuation, not merely the route departure.
    await expect.poll(() => page.getByTestId('files-loading').count()).toBe(0);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(f.requests.slice(before).filter(path => path.startsWith('preview:'))).toEqual([]);
    await expect(page.getByTestId('files-viewer')).toHaveCount(0);
    expect(f.rest.unknown).toEqual([]);
  });
}

test('replacing selection during a delayed refresh preview rejects its late result', async ({ page }) => {
  const f = await fixture(page);
  await waitForRuntimePair(page, () => page.goto(`/files?root=meta&path=${encodeURIComponent(file)}`));
  await expect(page.getByTestId('files-viewer')).toContainText('original preview');
  const release = f.holdPreview(file);
  const before = f.requests.length;
  await page.getByTestId('files-refresh').click();
  await expect(page.getByTestId('files-viewer')).toContainText('Loading preview');
  await page.getByTestId('files-list').getByText('other.txt', { exact: true }).click();
  await expect(page.getByTestId('files-viewer')).toContainText('other preview');
  release(content(file, 'obsolete preview must not return'));
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(f.requests.slice(before)).toEqual([`list:${parent}`, `preview:${file}`, `preview:${other}`]);
  await expect(page.getByTestId('files-viewer')).toContainText(other);
  await expect(page.getByTestId('files-viewer')).toContainText('other preview');
  await expect(page.getByTestId('files-viewer')).not.toContainText('obsolete preview');
  expect(f.rest.unknown).toEqual([]);
});
