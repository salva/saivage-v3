import { afterAll, afterEach, beforeEach, describe, expect, test } from 'vitest';

// Read the runner's effective configuration, including CLI overrides, rather than
// hard-coding the default or creating a separate test-runner configuration.
const maxConcurrency = (globalThis as typeof globalThis & {
  __vitest_worker__: { config: { maxConcurrency: number } };
}).__vitest_worker__.config.maxConcurrency;
const casesPerBranch = maxConcurrency + 1;
let active = 0;
let peak = 0;
let completed = 0;
const yieldTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

describe('nested concurrent test lifecycle admission', () => {
  beforeEach(async () => {
    active++;
    peak = Math.max(peak, active);
    await yieldTurn();
  });
  afterEach(async () => {
    await yieldTurn();
    active--;
    completed++;
  });
  afterAll(() => {
    expect(completed).toBe(casesPerBranch * 2);
    expect(active).toBe(0);
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(maxConcurrency);
  });
  describe.concurrent('outer', () => {
    for (const branch of ['left', 'right']) {
      describe.concurrent(branch, () => {
        for (let index = 0; index < casesPerBranch; index++) {
          test(`case ${index}`, async ({ expect }) => {
            await yieldTurn();
            expect(active).toBeGreaterThan(0);
          });
        }
      });
    }
  });
});
