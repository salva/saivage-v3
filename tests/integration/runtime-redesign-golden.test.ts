import { describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ANALYST_TOOL_NAMES } from '../../src/tools/definitions/index.js';
import { TOOL_REGISTRY } from '../../src/agents/analyst-prompt.js';
import { PlannerControlExecutor } from '../../src/agents/planner-control-executor.js';
import { operatorApiContracts } from '../../src/contracts/operator-api.js';
import { appendRuntimeRun, readRuntimeState, upsertRuntimeActivation } from '../../src/runtime/state.js';
import { CardStore } from '../../src/cards/card-store.js';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { createSupervisorRuntimeApi, readActorSnapshots } from '../../src/runtime/actors/index.js';
import type { LLMProviderPort, LlmInvocationInput } from '../../src/runtime/actors/index.js';
import type { LlmCompleteResult } from '../../src/agents/llm-contracts.js';

function tempRoot(prefix: string): string { return mkdtempSync(join(tmpdir(), prefix)); }

function setupCards() {
  const projectRoot = tempRoot('saivage-runtime-golden-');
  initProjectTree(projectRoot);
  const cardStore = new CardStore(projectRoot);
  const goal = cardStore.create({ type: 'goal', parent: 'project', depth: 1, title: 'Goal A', brief: 'Goal A', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], retries: 0 });
  const code = cardStore.create({ type: 'code', parent: goal.id, depth: 2, title: 'Code A', brief: 'Code A', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], retries: 0 });
  return { projectRoot, cardStore, goalId: goal.id, codeId: code.id };
}

function blockedPlannerProvider(): LLMProviderPort {
  const terminal = { kind: 'tool_calls' as const, tool_calls: [{ id: 'planner-result-1', type: 'function' as const, function: { name: 'emit_planner_result', arguments: JSON.stringify({ status: 'blocked', blocked_reason: 'waiting for operator', summary: 'waiting for operator' }) } }] };
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
      if (result.tool_calls.some((toolCall) => toolCall.function.name === 'emit_planner_result')) {
        pending.set(input.sessionId, result);
        return recordWrite(`status-${input.sessionId}`, 'record://status.md?v=next', `Status for ${input.episodeContext.cardId}`);
      }
      if (result.tool_calls.some((toolCall) => toolCall.function.name === 'emit_reviewer_result')) {
        pending.set(input.sessionId, result);
        return recordWrite(`review-${input.sessionId}`, 'record://review.md?v=next', `Review for ${input.episodeContext.cardId}`);
      }
      return result;
    }),
  };
}


function activationLedger(projectRoot: string) {
  return {
    readState: () => readRuntimeState(projectRoot),
    appendRun: (input: Parameters<typeof appendRuntimeRun>[1]) => appendRuntimeRun(projectRoot, input),
    upsertActivation: (input: Parameters<typeof upsertRuntimeActivation>[1]) => upsertRuntimeActivation(projectRoot, input),
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
      expect(Object.keys(TOOL_REGISTRY)).not.toContain('lets_dance');

      const api = createSupervisorRuntimeApi({
        projectRoot,
        rootCards: cardStore,
        actorStore: cardStore,
        provider: blockedPlannerProvider(),
        now: () => '2026-06-12T00:00:00.000Z',
      });
      expect('requestProjectDirectiveWakeup' in api).toBe(false);
      const result = await api.startProject('operator');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.command).toMatchObject({ command: 'start_project', status: 'completed', source: 'operator' });
        expect(result.run).toMatchObject({
          kind: 'root',
          card_id: 'project',
          ownership: { kind: 'direct', source: 'project_root' },
          phase: 'blocked',
          runtime_status: 'stopped',
          session_id: 'planner:project',
        });
      }
      expect(readActorSnapshots(projectRoot).map((item) => item.actor_id).sort()).toEqual(['card:project', 'planner:project', 'processor:project', 'supervisor']);
      await api.shutdown();
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });

  it('status changes cannot auto-dispatch root or child work; child work requires activate_card from an active parent run', async () => {
    const ctx = setupCards();
    try {
      ctx.cardStore.setStatus(ctx.codeId, 'running');
      expect(readRuntimeState(ctx.projectRoot)?.runtime_runs ?? []).toHaveLength(0);

      const exec = new PlannerControlExecutor({ projectRoot: ctx.projectRoot, cardStore: ctx.cardStore, activationLedger: activationLedger(ctx.projectRoot) });
      const rejected = await exec.execute({ toolName: 'activate_card', toolCallId: 'call-a', args: { cardId: ctx.codeId }, parentCardId: ctx.goalId, sessionId: `planner:${ctx.goalId}` });
      expect(rejected.success).toBe(false);
      expect((rejected.data as any).actionable_error.code).toBe('activate_card_parent_not_active');
      expect(readRuntimeState(ctx.projectRoot)?.runtime_runs ?? []).toHaveLength(0);

      appendRuntimeRun(ctx.projectRoot, { run_id: 'run-parent', kind: 'root', ownership: { kind: 'direct', source: 'operator' }, card_id: ctx.goalId, parent_run_id: null, command_id: 'cmd-a', activation_id: null, phase: 'planner', runtime_status: 'running', session_id: `planner:${ctx.goalId}` });
      const accepted = await exec.execute({ toolName: 'activate_card', toolCallId: 'call-a', args: { cardId: ctx.codeId }, parentCardId: ctx.goalId, sessionId: `planner:${ctx.goalId}` });
      expect(accepted.success).toBe(true);
      const body = accepted.data as any;
      expect(body.success).toBe(true);
      const state = readRuntimeState(ctx.projectRoot)!;
      expect(state.runtime_activations).toEqual(expect.arrayContaining([expect.objectContaining({ child_card_id: ctx.codeId, parent_run_id: 'run-parent' })]));
      const activation = (state.runtime_activations ?? []).find((item) => item.child_card_id === ctx.codeId)!;
      expect(state.runtime_runs).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'child', ownership: { kind: 'activation', activation_id: activation.activation_id, parent_run_id: 'run-parent', parent_card_id: ctx.goalId, parent_session_id: `planner:${ctx.goalId}`, parent_tool_call_id: 'call-a' }, card_id: ctx.codeId, parent_run_id: 'run-parent' })]));
    } finally { rmSync(ctx.projectRoot, { recursive: true, force: true }); }
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
      'src/tools/definitions/index.ts',
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
