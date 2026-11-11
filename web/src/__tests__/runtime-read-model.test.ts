import { describe, expect, it } from 'vitest';
import type { RuntimeState, RuntimeStatusResponse } from '../api/types';
import { selectLifecycleGuidance, selectRuntimeStatusLabel, selectSocketDetail, selectSocketLabel, selectStatusCurrentCardId } from '../stores/runtime-read-model';

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

function statusSnapshot(overrides: Partial<RuntimeStatusResponse> = {}): RuntimeStatusResponse {
  return {
    runtime: 'running',
    currentCardId: 'card-a',
    started_at: '2025-01-01T00:00:00Z',
    restart_server_available: false,
    pid: 123,
    actorRuntime: { pauseMode: 'running', cards: [] },
    oversight: {
      agent_name: 'oversight',
      session_id: 'agent:oversight:global',
      enabled: true,
      eligible: false,
      eligibility_reason: 'stopped',
      state: 'unavailable',
      remaining_wait_ms: null,
      last_attempt: null,
      last_successful_at: null,
      service_epoch: '2025-01-01T00:00:00Z',
    },
    serverAvailability: {
      generatedAt: '2025-01-01T00:00:00Z',
      components: {
        api: { state: 'available', source: 'health-check', checkedAt: '2025-01-01T00:00:00Z' },
        runtime: { state: 'available', source: 'runtime-application', checkedAt: '2025-01-01T00:00:00Z' },
        mcp: { state: 'idle', source: 'mcp-manager', checkedAt: '2025-01-01T00:00:00Z' },
      },
    },
    ...overrides,
  };
}

describe('runtime-read-model', () => {
  it('derives lifecycle and current-card identity only from the accepted runtime.status observation', () => {
    expect(selectRuntimeStatusLabel({ loaded: false, statusSnapshot: null })).toBe('unknown');
    expect(selectRuntimeStatusLabel({ loaded: true, statusSnapshot: null })).toBe('stopped');
    expect(selectRuntimeStatusLabel({ loaded: true, statusSnapshot: statusSnapshot({ runtime: 'paused' }) })).toBe('paused');
    expect(selectStatusCurrentCardId(statusSnapshot())).toBe('card-a');
    expect(selectStatusCurrentCardId(null)).toBe(null);
  });

  it('does not fall back between independently sampled state and status observations', () => {
    const stateWithDifferentCurrentCard = runtime({ current_card_id: 'card-zzz' });
    const status = statusSnapshot({ currentCardId: 'card-a' });
    expect(selectStatusCurrentCardId(status)).toBe('card-a');
    expect(stateWithDifferentCurrentCard.current_card_id).toBe('card-zzz');
  });

  it.each([
    ['running', 'edits are unavailable', 'wait for observed Paused', 'no new Start'],
    ['pausing', 'edits remain unavailable', 'no time bound', 'not a way to skip Pausing'],
    ['paused', 'subject to current per-operation admission', 'Resume to continue the same Run', 'not mean all processes'],
    ['stopped', 'subject to current per-operation admission', 'separate authorized operation, not Resume', 'own admission rules'],
    ['starting', 'intervention is unavailable', 'not an automatic remedy', 'not an automatic remedy'],
    ['closing', 'intervention is unavailable', 'not an automatic remedy', 'not an automatic remedy'],
    ['error', 'intervention is unavailable', 'Inspect System', 'not an automatic remedy'],
  ] as const)('projects qualified %s guidance', (status, description, detail, distinction) => {
    const guidance = selectLifecycleGuidance({ loaded: true, unauthorized: false, status })!;
    expect(guidance.description).toContain('Last observed lifecycle:');
    expect(guidance.description).toContain(description);
    expect(guidance.detail).toContain(detail);
    expect(guidance.detail).toContain(distinction);
    expect(guidance.detail).toContain('Operations recheck current state and their own permissions; other holds may still refuse them.');
    if (['running', 'paused', 'stopped'].includes(status)) {
      expect(guidance.detail).toContain('enabled Analyst conversation or configured external runtime controls');
    }
  });

  it('does not expose retained guidance as authorization when observations are unavailable', () => {
    expect(selectLifecycleGuidance({ loaded: false, unauthorized: false, status: 'paused' })).toBeNull();
    expect(selectLifecycleGuidance({ loaded: true, unauthorized: true, status: 'paused' })).toBeNull();
    expect(selectLifecycleGuidance({ loaded: true, unauthorized: false, status: null })).toBeNull();
  });

  it('projects exact socket state without combining REST state', () => {
    expect(selectSocketLabel('connected')).toBe('Connected');
    expect(selectSocketLabel('connecting')).toBe('Connecting');
    expect(selectSocketLabel('offline')).toBe('Offline');
    expect(selectSocketLabel('unauthorized')).toBe('Unauthorized');
    expect(selectSocketDetail('connected')).toContain('displayed runtime data still comes from REST');
  });
});
