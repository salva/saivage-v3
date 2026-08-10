import { describe, expect, it } from 'vitest';
import type { RuntimeState } from '../api/types';
import { selectCurrentCardId, selectRuntimeStatusLabel, selectSocketDetail, selectSocketLabel } from '../stores/runtime-read-model';

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
  it('distinguishes not loaded, accepted stopped, and payload status', () => {
    expect(selectRuntimeStatusLabel({ loaded: false, runtime: null })).toBe('unknown');
    expect(selectRuntimeStatusLabel({ loaded: true, runtime: null })).toBe('stopped');
    expect(selectRuntimeStatusLabel({ loaded: true, runtime: runtime({ status: 'paused' }) })).toBe('paused');
    expect(selectCurrentCardId(runtime())).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('projects exact socket state without combining REST state', () => {
    expect(selectSocketLabel('connected')).toBe('Connected');
    expect(selectSocketLabel('connecting')).toBe('Connecting');
    expect(selectSocketLabel('offline')).toBe('Offline');
    expect(selectSocketLabel('unauthorized')).toBe('Unauthorized');
    expect(selectSocketDetail('connected')).toContain('displayed runtime data still comes from REST');
  });
});
