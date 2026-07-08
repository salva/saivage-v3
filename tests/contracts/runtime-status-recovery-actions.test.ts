import { describe, expect, it } from '@jest/globals';
import { RuntimeStatusResponseSchema } from '../../src/contracts/operator-api-runtime-cards.js';
import { runtimeStatusSchema } from '../../src/schemas/index.js';

const recoveryActionKinds = ['active_card', 'active_llm', 'llm_recovery_action', 'active_processor'] as const;

function runtimeStatusPayload(kind: string): unknown {
  return {
    runtime: 'running',
    currentCardId: 'project',
    goalCount: 1,
    lastTickAt: null,
    pid: 123,
    actorRuntime: {
      pauseMode: 'running',
      activeWork: 'none',
      cards: [],
      agents: [],
      diagnostics: [],
      recovery: {
        generated_at: '2026-06-12T00:00:00.000Z',
        diagnostics: [],
        actions: [{ actorId: 'card:project', kind, action: 'diagnose_active_card', cardId: 'project' }],
      },
    },
  };
}

describe('runtime status recovery action contract', () => {
  it('accepts current recovery action kinds and rejects discarded supervisor actions', () => {
    for (const kind of recoveryActionKinds) {
      expect(RuntimeStatusResponseSchema.safeParse(runtimeStatusPayload(kind)).success).toBe(true);
    }

    expect(RuntimeStatusResponseSchema.safeParse(runtimeStatusPayload('discarded_supervisor')).success).toBe(false);
  });

  it('keeps the public recovery action enum aligned with the internal diagnostic enum', () => {
    for (const kind of recoveryActionKinds) {
      const action = { actorId: 'card:project', kind, action: 'diagnose_active_card', cardId: 'project' };
      expect(RuntimeStatusResponseSchema.safeParse(runtimeStatusPayload(kind)).success).toBe(true);
      expect(action.kind).toBe(kind);
    }

    const discardedSupervisor = { actorId: 'supervisor', kind: 'discarded_supervisor', action: 'discard_supervisor' };
    expect(RuntimeStatusResponseSchema.safeParse(runtimeStatusPayload('discarded_supervisor')).success).toBe(false);
    expect(recoveryActionKinds).not.toContain(discardedSupervisor.kind as never);
  });

  it('preserves error as a public runtime status', () => {
    expect(runtimeStatusSchema.safeParse('error').success).toBe(true);
    expect(RuntimeStatusResponseSchema.safeParse({ ...(runtimeStatusPayload('active_card') as Record<string, unknown>), runtime: 'error' }).success).toBe(true);
  });
});
