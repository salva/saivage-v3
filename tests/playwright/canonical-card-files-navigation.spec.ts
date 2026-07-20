import { expect, test, type Page, type Route } from '@playwright/test';
import { installOperatorRestRoutes } from './fixtures/operator-rest-fixtures.js';
import { installOperatorWebSocketShim } from './fixtures/operator-websocket-shim.js';

const now = '2026-07-20T12:00:00.000Z';

const listings = new Map<string, { path: string; files: Array<Record<string, unknown>> }>([
  ['.saivage', {
    path: '.saivage',
    files: [{ name: 'cards', path: '.saivage/cards', type: 'directory', modifiedAt: now }],
  }],
  ['.saivage/cards', {
    path: '.saivage/cards',
    files: [{ name: 'project', path: '.saivage/cards/project', type: 'directory', modifiedAt: now }],
  }],
  ['.saivage/cards/project', {
    path: '.saivage/cards/project',
    files: [
      { name: 'children', path: '.saivage/cards/project/children', type: 'directory', modifiedAt: now },
      { name: 'card.jsonl', path: '.saivage/cards/project/card.jsonl', type: 'file', size: 256, modifiedAt: now },
      { name: 'brief.jsonl', path: '.saivage/cards/project/brief.jsonl', type: 'file', size: 128, modifiedAt: now },
    ],
  }],
  ['.saivage/cards/project/children', {
    path: '.saivage/cards/project/children',
    files: [{ name: 'a', path: '.saivage/cards/project/children/a', type: 'directory', modifiedAt: now }],
  }],
  ['.saivage/cards/project/children/a', {
    path: '.saivage/cards/project/children/a',
    files: [
      { name: 'children', path: '.saivage/cards/project/children/a/children', type: 'directory', modifiedAt: now },
      { name: 'card.jsonl', path: '.saivage/cards/project/children/a/card.jsonl', type: 'file', size: 256, modifiedAt: now },
      { name: 'brief.jsonl', path: '.saivage/cards/project/children/a/brief.jsonl', type: 'file', size: 128, modifiedAt: now },
    ],
  }],
  ['.saivage/cards/project/children/a/children', {
    path: '.saivage/cards/project/children/a/children',
    files: [],
  }],
]);

function json(route: Route, payload: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
}

async function expectPath(page: Page, path: string, crumbs: string[]) {
  await expect(page).toHaveURL((url) => url.pathname === '/files' && url.searchParams.get('root') === 'meta' && url.searchParams.get('path') === path);
  const breadcrumbButtons = page.getByTestId('files-breadcrumbs').getByRole('button');
  await expect(breadcrumbButtons).toHaveText(crumbs);
}

async function openListedEntry(page: Page, name: string) {
  await page.getByTestId('files-list').getByText(name, { exact: true }).click();
}

test('Files navigates the canonical card tree from Metadata to an empty leaf', async ({ page }) => {
  const requestedPaths: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`));

  await installOperatorWebSocketShim(page);
  const rest = await installOperatorRestRoutes(page);
  await page.route('**/api/files?**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.searchParams.get('path') ?? '.saivage';
    requestedPaths.push(path);
    const listing = listings.get(path);
    return listing ? json(route, listing) : json(route, { error: 'Path not found', path }, 404);
  });

  await page.goto('/files?root=meta&path=.saivage');
  await expect(page.getByRole('region', { name: 'Metadata' })).toBeVisible();
  await expectPath(page, '.saivage', ['.saivage']);

  await openListedEntry(page, 'cards');
  await expectPath(page, '.saivage/cards', ['.saivage', 'cards']);
  await expect(page.getByTestId('files-list').getByText('project', { exact: true })).toBeVisible();

  await openListedEntry(page, 'project');
  await expectPath(page, '.saivage/cards/project', ['.saivage', 'cards', 'project']);
  await expect(page.getByTestId('files-list').getByText('children', { exact: true })).toBeVisible();

  await openListedEntry(page, 'children');
  await expectPath(page, '.saivage/cards/project/children', ['.saivage', 'cards', 'project', 'children']);
  await expect(page.getByTestId('files-list').getByText('a', { exact: true })).toBeVisible();

  await openListedEntry(page, 'a');
  await expectPath(page, '.saivage/cards/project/children/a', ['.saivage', 'cards', 'project', 'children', 'a']);

  await openListedEntry(page, 'children');
  await expectPath(page, '.saivage/cards/project/children/a/children', ['.saivage', 'cards', 'project', 'children', 'a', 'children']);
  await expect(page.getByTestId('files-empty')).toContainText('No files');

  for (const path of listings.keys()) expect(requestedPaths).toContain(path);
  expect(rest.unknown).toEqual([]);
  expect(failedRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});
