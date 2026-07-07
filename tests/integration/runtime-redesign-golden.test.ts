import { describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ANALYST_TOOL_NAMES } from '../../src/tools/analyst-tool-registry.js';
import { operatorApiContracts } from '../../src/contracts/operator-api.js';
import { CardStore } from '../../src/cards/card-store.js';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { createSupervisorRuntimeApi, readActorSnapshots } from '../../src/runtime/actors/index.js';
import type { LLMProviderPort, LlmInvocationInput } from '../../src/runtime/actors/index.js';
import type { LlmCompleteResult } from '../../src/agents/llm-contracts.js';
import { readRuntimeState } from '../../src/runtime/state-api.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';

function tempRoot(prefix: string): string { return mkdtempSync(join(tmpdir(), prefix)); }

async function waitForRootRun(projectRoot: string, phase: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (readRuntimeState(projectRoot)?.runtime_runs.some((run) => run.kind === 'root' && run.phase === phase)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for root run phase ${phase}`);
}

function blockedPlannerProvider(): LLMProviderPort {
  const terminal = { kind: 'tool_calls' as const, tool_calls: [{ id: 'planner-result-1', type: 'function' as const, function: { name: 'emit_result', arguments: JSON.stringify({ status: 'blocked', summary: 'waiting for operator' }) } }] };
  return withMandatoryRecords(() => terminal);
}

function recordWrite(callId: string, path: string, content: string): LlmCompleteResult {
  return { kind: 'tool_calls' as const, tool_calls: [{ id: callId, type: 'function' as const, function: { name: 'write', arguments: JSON.stringify({ path, content }) } }] };
}

function withMandatoryRecords(responder: (input: LlmInvocationInput) => Promise<LlmCompleteResult> | LlmCompleteResult): LLMProviderPort {
  const pending = new Map<string, LlmCompleteResult>();
  return {
    completeTurn: jest.fn(async (input: LlmInvocationInput) => {
      const pendingTerminal = pending.get(input.sessionId);
      if (pendingTerminal) {
        pending.delete(input.sessionId);
        return pendingTerminal;
      }
      const result = await responder(input);
      if (result.kind !== 'tool_calls') return result;
      if (result.tool_calls.some((toolCall) => toolCall.function.name === 'emit_result')) {
        pending.set(input.sessionId, result);
        return recordWrite(`status-${input.sessionId}`, 'record://status.md?v=next', `Status for ${input.episodeContext.cardId}`);
      }
      if (result.tool_calls.some((toolCall) => toolCall.function.name === 'emit_result')) {
        pending.set(input.sessionId, result);
        return recordWrite(`review-${input.sessionId}`, 'record://review.md?v=next', `Review for ${input.episodeContext.cardId}`);
      }
      return result;
    }),
  };
}

describe('runtime redesign final golden behavior', () => {
  it('active backend APIs expose explicit start_project/stop_project and no lets_dance or directive wakeup root kickoff', async () => {
    const projectRoot = tempRoot('saivage-runtime-golden-start-');
    try {
      initProjectTree(projectRoot);
      const cardStore = new CardStore(projectRoot);
      expect('runtime.startProject' in operatorApiContracts).toBe(false);
      expect('runtime.stopProject' in operatorApiContracts).toBe(false);
      expect(ANALYST_TOOL_NAMES).not.toContain('lets_dance');

      const api = createSupervisorRuntimeApi({
        projectRoot,
        rootCards: cardStore,
        actorStore: cardStore,
        provider: blockedPlannerProvider(),
        processRunner: new ProcessRunner(projectRoot),
        now: () => '2026-06-12T00:00:00.000Z',
      });
      expect('requestProjectDirectiveWakeup' in api).toBe(false);
      const result = await api.startProject('operator');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.command).toMatchObject({ command: 'start_project', status: 'accepted', source: 'operator' });
        expect(result.run).toMatchObject({
          kind: 'root',
          card_id: 'project',
          ownership: { kind: 'direct', source: 'project_root' },
          phase: 'pending',
          runtime_status: 'running',
          session_id: 'planner:project',
        });
      }
      await waitForRootRun(projectRoot, 'blocked');
      expect(readActorSnapshots(projectRoot).map((item) => item.actor_id).sort()).toEqual(['card:project', 'planner:project', 'processor:project']);
      await api.shutdown();
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });

  it('operator contract registry no longer exposes card mutation entries', () => {
    expect('cards.create' in operatorApiContracts).toBe(false);
    expect('cards.update' in operatorApiContracts).toBe(false);
    expect('cards.delete' in operatorApiContracts).toBe(false);
  });

  it('active docs and prompts teach Analyst-controlled runtime/card work and no obsolete execution ritual remains active', () => {
    const activeFiles = [
      'docs/architecture/micro-actor-runtime-design.md',
      'docs/architecture/micro-actor-runtime-implementation-plan.md',
      'docs/architecture/declarative-micro-actor-module.md',
      'docs/architecture/system-architecture.md',
      'docs/spec/operator-ui.md',
      'docs/spec/system-specification.md',
      'src/agents/system-prompt.ts',
      'src/agents/analyst-prompt.ts',
    ];
    const combined = activeFiles.map((file) => readFileSync(file, 'utf-8')).join('\n');
    expect(combined).toContain('start_project');
    expect(combined).toContain('stop_project');
    expect(combined).toContain('activate_card');
    expect(combined).toContain('Analyst');
    expect(combined).toContain('operator UI');
    expect(combined).toContain('card tree');
    expect(combined).toMatch(/status[^.]+not[^.]+execution trigger|status[^.]+never an execution trigger|status changes?[^.]+never enqueue|not automatically dispatched by the status change/i);
    expect(combined).not.toMatch(/lets_dance/);
    expect(combined).not.toMatch(/project-directive/);
    expect(combined).not.toMatch(/pending-confirmation/);
    expect(combined).not.toMatch(/ready queue/i);
  });
});
