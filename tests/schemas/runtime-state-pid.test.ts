import { describe, it, expect } from '@jest/globals';
import { runtimeStateSchema } from '../../src/schemas/validators.js';

const baseRuntimeState = () => ({
  status: 'stopped' as const,
  project_id: 'project' as const,
  started_at: '2026-05-23T00:00:00.000Z',
  active_card_run: null,
  updated_at: '2026-05-23T00:00:00.000Z',
});

describe('runtimeStateSchema requires a positive integer pid', () => {
  it('preserves the pid key on round-trip', () => {
    const parsed = runtimeStateSchema.parse({ ...baseRuntimeState(), pid: 12345 });
    expect(parsed.pid).toBe(12345);
    expect(Object.prototype.hasOwnProperty.call(parsed, 'pid')).toBe(true);
  });

  it('requires pid on RuntimeState objects', () => {
    // src/schemas/validators.ts:109 — pid is required, positive integer
    expect(() => runtimeStateSchema.parse(baseRuntimeState())).toThrow();
  });
});
