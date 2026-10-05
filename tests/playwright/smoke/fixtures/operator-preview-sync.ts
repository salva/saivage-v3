import { expect, type Page } from '@playwright/test';

function isToleratedCancellationPath(path: string): boolean {
  return path.startsWith('/api/');
}

type FailureObservations = {
  unexpected: string[];
};

export async function seedTokenBeforeNavigation(page: Page, token: string) {
  await page.addInitScript((value) => localStorage.setItem('saivage_api_token', value), token);
}

export async function waitForRuntimePair<T>(page: Page, action: () => Promise<T>): Promise<T> {
  const wait = (path: string) => page.waitForResponse((r) => r.request().method() === 'GET' && new URL(r.url()).pathname === path);
  const state = wait('/api/state');
  const status = wait('/api/runtime/status');
  const result = action();
  await Promise.all([state, status, result]);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  return result;
}

export function observePreviewRequestFailures(page: Page, baseURL: string) {
  const origin = new URL(baseURL).origin;
  const unexpected: string[] = [];
  page.on('requestfailed', (request) => {
    const url = new URL(request.url());
    const error = request.failure()?.errorText ?? '';
    const path = url.pathname;
    if (request.method() === 'GET' && url.origin === origin && error === 'net::ERR_ABORTED' && isToleratedCancellationPath(path)) {
      return;
    }
    unexpected.push(`${request.method()} ${request.url()} ${error}`);
  });
  return { unexpected };
}

export function assertPreviewRequestFailures(observations: FailureObservations) {
  expect(observations.unexpected).toEqual([]);
}
