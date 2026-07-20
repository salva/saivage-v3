import { describe, expect, it } from 'vitest';
import type { RuntimeState } from '../api/types';
import { selectCurrentCardId, selectLiveUpdateState, selectRuntimeStatusLabel } from '../stores/runtime-read-model';

function runtime(overrides: Partial<RuntimeState> = {}): RuntimeState {
  return {
    status: 'running',
    project_id: 'project',
    pid: 123,
    started_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    current_card_id: '11111111-1111-4111-8111-111111111111',
    ...overrides,
  };
}

describe('runtime-read-model', () => {
  it('single-sources status and live update labels from current runtime state', () => {
    expect(selectRuntimeStatusLabel(runtime({ status: 'paused' }))).toBe('paused');
    expect(selectCurrentCardId(runtime())).toBe('11111111-1111-4111-8111-111111111111');
    expect(selectLiveUpdateState({ connectionState: 'no-token', unauthorized: false, stale: false, wsStale: false })).toBe('offline');
  });
});
