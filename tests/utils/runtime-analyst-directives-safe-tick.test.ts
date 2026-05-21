import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/utils/file-tree.js';
import { Runtime } from '../../src/utils/runtime.js';
import { CardStore } from '../../src/utils/card-store.js';
import { releaseLock } from '../../src/utils/runtime-lock.js';
import { initRuntimeState, readRuntimeState, updateRuntimeState } from '../../src/utils/runtime-state.js';
import { readProjectDirectives, recordLetsDanceDirective, recordProjectNeedsCorrectionsDirective } from '../../src/utils/analyst-stage6.js';
import type { AgentRuntime } from '../../src/agents/agent-runtime.js';
import type { PlannerResult, ExecutorResult, ReviewerResult } from '../../src/agents/result-parser.js';
import type { HandoffSummary } from '../../src/schemas/types.js';

class CountingAgent implements AgentRuntime {
  plannerCalls: string[] = [];
  invokePlanner(goalId: string): PlannerResult {
    this.plannerCalls.push(goalId);
    return { status: 'blocked', blocked_reason: 'synthetic safeTick stop', created_cards: [], updated_cards: [] };
  }
  invokeExecutor(): ExecutorResult { throw new Error('executor should not run in directive safeTick tests'); }
  invokeReviewer(): ReviewerResult { throw new Error('reviewer should not run in directive safeTick tests'); }
  cancelSession(): boolean { return false; }
  forceCancelSession(): boolean { return false; }
  getHandoffSummary(): HandoffSummary | null { return null; }
  getActiveSessionHandoffs(): HandoffSummary[] { return []; }
}

let root: string;
let runtime: Runtime | null;
let store: CardStore;
let consumedEvents: unknown[];

function makeRuntime(agent: AgentRuntime): Runtime {
  return new Runtime({ projectRoot: root, fakeAgentConfig: { mapping: {}, fixtureDir: root } }, agent);
}

async function runSafeTick(instance: Runtime): Promise<void> {
  await (instance as unknown as { safeTick: () => Promise<void> }).safeTick();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'saivage-directive-safe-tick-'));
  initProjectTree(root);
  initRuntimeState(root);
  store = new CardStore(root);
  runtime = null;
  consumedEvents = [];
});

afterEach(async () => {
  if (runtime) {
    try { await runtime.shutdown(); } catch {}
    runtime = null;
  }
  try { releaseLock(root); } catch {}
  rmSync(root, { recursive: true, force: true });
});

describe('runtime safeTick consumes analyst project directives', () => {

  it('requestProjectDirectiveWakeup consumes a post-startup lets_dance through safeTick', async () => {
    const agent = new CountingAgent();
    runtime = makeRuntime(agent);
    await runtime.startup();
    await new Promise((resolve) => setTimeout(resolve, 75));
    store.update('project', { status: 'active' });
    const recorded = recordLetsDanceDirective(root, { runtime_available: true });
    expect(recorded).toEqual(expect.objectContaining({ directive_recorded: true, outcome: 'wakeup_unavailable' }));

    const wakeup = await runtime.requestProjectDirectiveWakeup('lets_dance');

    expect(wakeup).toEqual({ accepted: true, reason: 'lets_dance' });
    expect(agent.plannerCalls).toEqual(['project']);
    expect(readProjectDirectives(root)).toEqual({});
  });

  it('consumes a lets_dance directive exactly once and activates the project planner', async () => {
    const agent = new CountingAgent();
    runtime = makeRuntime(agent);
    runtime.on('directive_consumed', (event) => consumedEvents.push(event));
    store.update('project', { status: 'active' });
    recordLetsDanceDirective(root, { runtime_available: true });

    await runSafeTick(runtime);
    await runSafeTick(runtime);

    expect(agent.plannerCalls).toEqual(['project']);
    expect(readProjectDirectives(root)).toEqual({});
    expect(readRuntimeState(root)?.status).toBe('idle');
    expect(store.read('project')?.status).toBe('blocked');
    expect(consumedEvents).toEqual([expect.objectContaining({ directive_kind: 'lets_dance', card_id: 'project' })]);
  });

  it('buffers an analyst-created directive while paused and consumes it after resume', async () => {
    const agent = new CountingAgent();
    runtime = makeRuntime(agent);
    runtime.pause();
    expect(await runtime.requestProjectDirectiveWakeup('lets_dance')).toEqual({ accepted: false, reason: 'runtime_paused' });
    recordProjectNeedsCorrectionsDirective(root, [{ summary: 'project needs correction while paused' }], 'Synthetic paused directive.');

    await runSafeTick(runtime);
    expect(agent.plannerCalls).toEqual([]);
    expect(readProjectDirectives(root).project_needs_corrections).toEqual(expect.any(String));

    runtime.resume();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await runSafeTick(runtime);

    expect(agent.plannerCalls).toEqual(['project']);
    expect(readProjectDirectives(root)).toEqual({});
  });

  it('consumes persisted directives after runtime restart-style startup safe tick', async () => {
    recordLetsDanceDirective(root);
    updateRuntimeState(root, { status: 'idle', paused: false, active_card_run: null, current_card_id: null, current_agent_session_id: null });
    const agent = new CountingAgent();
    runtime = makeRuntime(agent);

    await runtime.startup();
    await new Promise((resolve) => setTimeout(resolve, 75));
    await runSafeTick(runtime);

    expect(agent.plannerCalls).toEqual(['project']);
    expect(readProjectDirectives(root)).toEqual({});
  });
});
