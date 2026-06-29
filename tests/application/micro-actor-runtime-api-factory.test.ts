import { describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../../src/events/index.js';
import { CardStore } from '../../src/cards/card-store.js';
import { createMicroActorRuntimeApi } from '../../src/application/micro-actor-runtime-api-factory.js';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import type { InvocationService } from '../../src/agents/invocation-service.js';
import type { LlmCompleteResult } from '../../src/agents/llm-contracts.js';

function withTempProject<T>(fn: (projectRoot: string) => Promise<T> | T): Promise<T> | T {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-micro-actor-runtime-factory-'));
  const result = fn(projectRoot);
  if (result instanceof Promise) return result.finally(() => rmSync(projectRoot, { recursive: true, force: true }));
  rmSync(projectRoot, { recursive: true, force: true });
  return result;
}

describe('createMicroActorRuntimeApi', () => {
  it('constructs a RuntimeApi backed by the shared CardStore', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const cardStore = new CardStore(projectRoot);
    cardStore.create({ type: 'project', parent: null, depth: 0, title: 'project', brief: 'project', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], retries: 0 });
    const plannerTerminal = { kind: 'tool_calls' as const, tool_calls: [{ id: 'planner-result-1', type: 'function' as const, function: { name: 'emit_planner_result', arguments: JSON.stringify({ status: 'blocked', blocked_reason: 'waiting for operator', summary: 'waiting for operator' }) } }] };
    let wroteStatus = false;
    const invocationService = {
      invokeWithRecovery: jest.fn(async (): Promise<LlmCompleteResult> => {
        if (!wroteStatus) {
          wroteStatus = true;
          return { kind: 'tool_calls' as const, tool_calls: [{ id: 'planner-write-status', type: 'function' as const, function: { name: 'write', arguments: JSON.stringify({ path: 'record://status.md?v=next', content: 'waiting for operator' }) } }] };
        }
        return plannerTerminal;
      }),
    } as unknown as InvocationService;
    const api = createMicroActorRuntimeApi({
      projectRoot,
      eventBus: new EventBus(),
      cardStore,
      invocationService,
      now: () => '2026-06-12T00:00:00.000Z',
    });

    const result = await api.startProject('operator');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.intent.status).toBe('running');
      expect(result.run).toMatchObject({ card_id: 'project', phase: 'blocked', runtime_status: 'stopped' });
    }
    expect(api.getStatus()).toMatchObject({ status: 'idle', currentCardId: null });
  }));
});
