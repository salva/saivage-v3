import { expect, type Page } from '@playwright/test';

export type RuntimeCancellationPhase = 'full-document-navigation' | 'auth-reconfiguration';
export type Cancellation = {
  phase: RuntimeCancellationPhase;
  method: 'GET';
  origin: string;
  path: string;
  error: 'net::ERR_ABORTED';
};

function isToleratedCancellationPath(path: string): boolean {
  return path.startsWith('/api/');
}

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
  let phase: RuntimeCancellationPhase | null = null;
  const expected: Cancellation[] = [];
  const unexpected: string[] = [];
  page.on('requestfailed', (request) => {
    const url = new URL(request.url());
    const error = request.failure()?.errorText ?? '';
    const path = url.pathname;
    if (request.method() === 'GET' && url.origin === origin && error === 'net::ERR_ABORTED' && isToleratedCancellationPath(path)) {
      if (phase) expected.push({ phase, method: 'GET', origin, path, error });
      return;
    }
    unexpected.push(`${request.method()} ${request.url()} ${error}`);
  });
  return {
    expected,
    unexpected,
    async during<T>(next: RuntimeCancellationPhase, action: () => Promise<T>) {
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
  _baseURL: string,
  declaredPhases: readonly RuntimeCancellationPhase[],
) {
  const declaredSet = new Set(declaredPhases);
  for (const cancellation of observations.expected) {
    expect(declaredSet.has(cancellation.phase), `cancellation of ${cancellation.path} outside a declared phase`).toBe(true);
  }
  expect(observations.unexpected).toEqual([]);
}
