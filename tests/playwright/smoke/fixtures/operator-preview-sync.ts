import { expect, type Page } from '@playwright/test';

export type Phase = 'full-document-navigation' | 'auth-reconfiguration';
export type Cancellation = {
  phase: Phase;
  method: 'GET';
  origin: string;
  path: '/api/state' | '/api/runtime/status';
  error: 'net::ERR_ABORTED';
};

type FailureObservations = {
  expected: Cancellation[];
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
  let phase: Phase | null = null;
  const expected: Cancellation[] = [];
  const unexpected: string[] = [];
  page.on('requestfailed', (request) => {
    const url = new URL(request.url());
    const error = request.failure()?.errorText ?? '';
    const path = url.pathname;
    if (phase && request.method() === 'GET' && url.origin === origin && (path === '/api/state' || path === '/api/runtime/status') && error === 'net::ERR_ABORTED') {
      expected.push({ phase, method: 'GET', origin, path, error });
      return;
    }
    unexpected.push(`${request.method()} ${request.url()} ${error}`);
  });
  return {
    expected,
    unexpected,
    async during<T>(next: Phase, action: () => Promise<T>) {
      if (phase) throw new Error(`phase active: ${phase}`);
      phase = next;
      try {
        return await action();
      } finally {
        phase = null;
      }
    },
  };
}

export function assertPreviewRequestFailures(
  observations: FailureObservations,
  baseURL: string,
  declaredPhases: readonly Phase[],
) {
  const origin = new URL(baseURL).origin;
  const declared = declaredPhases.flatMap((phase) => [
    { phase, method: 'GET', origin, path: '/api/state', error: 'net::ERR_ABORTED' },
    { phase, method: 'GET', origin, path: '/api/runtime/status', error: 'net::ERR_ABORTED' },
  ]);
  for (const cancellation of observations.expected) {
    expect(declared).toContainEqual(cancellation);
  }
  expect(observations.unexpected).toEqual([]);
}
