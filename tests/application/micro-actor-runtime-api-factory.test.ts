import { describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../../src/events/index.js';
import { CardStore } from '../../src/cards/card-store.js';
import { createMicroActorRuntimeApi } from '../../src/application/micro-actor-runtime-api-factory.js';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import type { InvocationService } from '../../src/agents/invocation-service.js';
import type { ProviderTurnCompletion } from '../../src/agents/llm-contracts.js';
import { readRuntimeState } from '../../src/runtime/state-api.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { createTestPromptTemplateRegistry } from '../helpers/prompt-template-registry.js';

function withTempProject<T>(fn: (projectRoot: string) => Promise<T> | T): Promise<T> | T {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-micro-actor-runtime-factory-'));
  const result = fn(projectRoot);
  if (result instanceof Promise) return result.finally(() => rmSync(projectRoot, { recursive: true, force: true }));
  rmSync(projectRoot, { recursive: true, force: true });
  return result;
}

async function waitForRootRun(projectRoot: string, phase: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (readRuntimeState(projectRoot)?.runtime_runs.some((run) => run.kind === 'root' && run.phase === phase)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for root run phase ${phase}`);
}

describe('createMicroActorRuntimeApi', () => {
  it('constructs a RuntimeApi backed by the shared CardStore', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const cardStore = new CardStore(projectRoot);
    const plannerTerminal = { kind: 'tool_calls' as const, tool_calls: [{ id: 'planner-result-1', type: 'function' as const, function: { name: 'emit_result', arguments: JSON.stringify({ status: 'blocked', summary: 'waiting for operator' }) } }] };
    let wroteStatus = false;
    const invocationService = {
      invokeWithRecovery: jest.fn(async (): Promise<ProviderTurnCompletion> => {
        if (!wroteStatus) {
          wroteStatus = true;
          return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'planner-write-status', type: 'function' as const, function: { name: 'write', arguments: JSON.stringify({ path: 'record:///status.md?v=next', content: 'waiting for operator' }) } }] }, provider_exchanges: [] };
        }
        return { result: plannerTerminal, provider_exchanges: [] };
      }),
    } as unknown as InvocationService;
    const api = createMicroActorRuntimeApi({
      projectRoot,
      eventBus: new EventBus(),
      cardStore,
      invocationService,
      promptTemplates: createTestPromptTemplateRegistry(),
      processRunner: new ProcessRunner(projectRoot),
      now: () => '2026-06-12T00:00:00.000Z',
    });

    const result = await api.startProject('operator');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.run).toMatchObject({ card_id: 'project', phase: 'pending', runtime_status: 'running' });
    }
    await waitForRootRun(projectRoot, 'blocked');
    expect(api.getStatus()).toMatchObject({ status: 'stopped', currentCardId: null });
  }));
});
