import { describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loggedEventSchema } from '../../src/schemas/validators.js';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import {
  appendRuntimeRun,
  readRuntimeState,
  upsertRuntimeActivation,
  upsertRuntimeIntent,
} from '../../src/runtime/state.js';
import { PlannerControlExecutor } from '../../src/agents/planner-control-executor.js';
import { CardStore } from '../../src/cards/card-store.js';
import { EventBus } from '../../src/events/bus.js';
import type { AgentExecutionPort as AgentRuntime } from '../../src/contracts/index.js';
import {
  createRuntimeCoreTestContainer,
  type RuntimeCoreTestContainer,
} from '../../src/runtime/core-composition.js';

function activationLedger(projectRoot: string) {
  return {
    readState: () => readRuntimeState(projectRoot),
    appendRun: (input: Parameters<typeof appendRuntimeRun>[1]) =>
      appendRuntimeRun(projectRoot, input),
    upsertActivation: (input: Parameters<typeof upsertRuntimeActivation>[1]) =>
      upsertRuntimeActivation(projectRoot, input),
  };
}

function root(): string {
  return mkdtempSync(join(tmpdir(), 'saivage-runtime-command-'));
}

function initProjectWithRoot(projectRoot: string): void {
  initProjectTree(projectRoot);
  const store = new CardStore(projectRoot);
  store.create({
    type: 'project',
    parent: null,
    depth: 0,
    title: 'project',
    description: '',
    status: 'backlog',
    tags: [],
    priority: 0,
    urgency: 'normal',
    created_by: 'analyst',
    acceptance: '',
    depends_on: [],
    related: [],
    artifacts: [],
    attachments: [],
    retries: 0,
  });
}

async function waitForBackgroundDispatchesToDrain(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 2000;
    const poll = () => {
      if (diagnostics.getBackgroundDispatchCount() === 0) return resolve();
      if (Date.now() >= deadline)
        return reject(
          new Error(
            `background dispatches did not drain; count=${diagnostics.getBackgroundDispatchCount()}`,
          ),
        );
      setTimeout(poll, 10);
    };
    poll();
  });
}

let dispatchTools: RuntimeCoreTestContainer['dispatchTestTools'];
let diagnostics: RuntimeCoreTestContainer['diagnosticTestTools'];
let cards: RuntimeCoreTestContainer['cardTestTools'];
let loggerTools: RuntimeCoreTestContainer['loggerTestTools'];
let subscribe: RuntimeCoreTestContainer['api']['subscribe'];

function makeRuntime(
  projectRoot: string,
  agentRuntime?: AgentRuntime,
  goalDispatcher?: Parameters<typeof createRuntimeCoreTestContainer>[0]['goalDispatcher'],
): RuntimeCoreTestContainer['api'] {
  const harness = createRuntimeCoreTestContainer({
    config: {
      projectRoot,
      fakeAgentConfig: { mapping: {}, fixtureDir: '' },
      autoDispatchBacklog: false,
    },
    ...(agentRuntime ? { agentRuntime } : {}),
    ...(goalDispatcher ? { goalDispatcher } : {}),
  });
  dispatchTools = harness.dispatchTestTools;
  diagnostics = harness.diagnosticTestTools;
  cards = harness.cardTestTools;
  loggerTools = harness.loggerTestTools;
  subscribe = harness.api.subscribe;
  return harness.api;
}

describe('runtime command ledger target contract (Wave 1)', () => {
  it('start_project records running intent and creates a root run before dispatch side effects', async () => {
    const projectRoot = root();
    try {
      initProjectWithRoot(projectRoot);
      const calls: string[] = [];
      const api = makeRuntime(projectRoot, undefined, async (goalId: string) => {
        calls.push(goalId);
      });
      const result = await api.startProject('operator');
      expect(result.success).toBe(true);
      const state = readRuntimeState(projectRoot)!;
      expect(state.runtime_intent!.status).toBe('running');
      expect(state.runtime_commands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ command: 'start_project', status: 'completed' }),
        ]),
      );
      expect(state.runtime_runs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'root',
            card_id: 'project',
            command_id: result.command.command_id,
          }),
        ]),
      );
      expect(calls).toEqual(['project']);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('start_project observes project cards created through the shared application store after runtime assembly', async () => {
    const projectRoot = root();
    try {
      initProjectTree(projectRoot);
      const sharedEventBus = new EventBus();
      const sharedStore = new CardStore(projectRoot, undefined, sharedEventBus);
      const calls: string[] = [];
      const harness = createRuntimeCoreTestContainer({
        config: {
          projectRoot,
          fakeAgentConfig: { mapping: {}, fixtureDir: '' },
          autoDispatchBacklog: false,
          eventBus: sharedEventBus,
          cardStore: sharedStore,
        },
        goalDispatcher: async (goalId: string) => {
          calls.push(goalId);
        },
      });

      sharedStore.create({
        type: 'project',
        parent: null,
        depth: 0,
        title: 'project',
        description: '',
        status: 'backlog',
        tags: [],
        priority: 0,
        urgency: 'normal',
        created_by: 'analyst',
        acceptance: '',
        depends_on: [],
        related: [],
        artifacts: [],
        attachments: [],
        retries: 0,
      });

      const result = await harness.api.startProject('analyst');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(result.success).toBe(true);
      expect(calls).toEqual(['project']);
      const state = readRuntimeState(projectRoot)!;
      expect(state.runtime_runs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'root',
            card_id: 'project',
          }),
        ]),
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('start_project logs project command dispatch fallback failures', async () => {
    const projectRoot = root();
    try {
      initProjectWithRoot(projectRoot);
      const api = makeRuntime(projectRoot, undefined, async () => {
        throw new Error('scheduler dispatch boom');
      });
      const result = await api.startProject('operator');
      if (!result.success) throw new Error(`startProject failed: ${result.error.message}`);
      await waitForBackgroundDispatchesToDrain();

      expect(loggerTools.getEvents()).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'runtime_diagnostic', phase: 'project_command_dispatch_failed', error_message: 'scheduler dispatch boom' }),
      ]));
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('startup reconciles idle running intent with stale open root run and restarts project scheduling', async () => {
    const projectRoot = root();
    try {
      initProjectWithRoot(projectRoot);
      upsertRuntimeIntent(
        projectRoot,
        'running',
        'cmd-old',
        'runtime should keep scheduling project work',
      );
      appendRuntimeRun(projectRoot, {
        run_id: 'run-stale-open-root',
        kind: 'root',
        card_id: 'project',
        parent_run_id: null,
        command_id: 'cmd-old',
        activation_id: null,
        phase: 'planner',
        runtime_status: 'running',
        session_id: 'planner:project',
      });
      const calls: string[] = [];
      const api = makeRuntime(projectRoot, undefined, async (goalId: string) => {
        calls.push(goalId);
      });
      cards.setStatus('project', 'active');
      cards.setStatus('project', 'running');
      cards.repairTerminalLifecycle('project', {
        status: 'done',
        lifecycle: {
          status: 'done',
          result: {
            kind: 'planner_done',
            summary: 'seeded done',
          },
          error: null,
          completed_at: new Date().toISOString(),
        },
      });

      await api.start();
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 2000;
        const poll = () => {
          if (calls.length > 0 && diagnostics.getBackgroundDispatchCount() === 0) return resolve();
          if (Date.now() >= deadline)
            return reject(
              new Error(
                `startup restart did not dispatch; calls=${calls.length}; background=${diagnostics.getBackgroundDispatchCount()}`,
              ),
            );
          setTimeout(poll, 10);
        };
        poll();
      });
      const state = readRuntimeState(projectRoot)!;
      expect(calls).toEqual(['project']);
      expect(state.runtime_runs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            run_id: 'run-stale-open-root',
            kind: 'root',
            card_id: 'project',
            phase: 'completed',
            runtime_status: 'idle',
            outcome: expect.objectContaining({ kind: 'completed', result: 'done' }),
            finished_at: expect.any(String),
          }),
          expect.objectContaining({
            kind: 'root',
            card_id: 'project',
            phase: 'completed',
            runtime_status: 'idle',
            outcome: expect.objectContaining({ kind: 'completed', result: 'done' }),
            finished_at: expect.any(String),
          }),
        ]),
      );
      expect(state.runtime_intent).toEqual(expect.objectContaining({ status: 'running' }));
      await api.shutdown();
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('start_project reconciles stale running intent when no active root run exists', async () => {
    const projectRoot = root();
    try {
      initProjectWithRoot(projectRoot);
      upsertRuntimeIntent(
        projectRoot,
        'running',
        'cmd-old',
        'stale running intent from prior completed run',
      );
      const calls: string[] = [];
      const api = makeRuntime(projectRoot, undefined, async (goalId: string) => {
        calls.push(goalId);
      });

      const result = await api.startProject('operator');

      expect(result.success).toBe(true);
      if (!result.success)
        throw new Error(`expected startProject to succeed, got ${result.error.code}`);
      const state = readRuntimeState(projectRoot)!;
      expect(state.runtime_intent).toEqual(
        expect.objectContaining({
          status: 'running',
          source_command_id: result.command.command_id,
          reason: 'explicit start_project command',
        }),
      );
      expect(state.runtime_runs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            run_id: result.run.run_id,
            kind: 'root',
            card_id: 'project',
            command_id: result.command.command_id,
          }),
        ]),
      );
      expect(state.runtime_commands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            command_id: result.command.command_id,
            command: 'start_project',
            status: 'completed',
          }),
        ]),
      );
      expect(calls).toEqual(['project']);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('start_project still rejects running intent when an open root run exists', async () => {
    const projectRoot = root();
    try {
      initProjectWithRoot(projectRoot);
      upsertRuntimeIntent(
        projectRoot,
        'running',
        'cmd-open',
        'active run still owns project execution',
      );
      appendRuntimeRun(projectRoot, {
        run_id: 'run-open-root',
        kind: 'root',
        card_id: 'project',
        parent_run_id: null,
        command_id: 'cmd-open',
        activation_id: null,
        phase: 'planner',
        runtime_status: 'running',
        session_id: 'planner:project',
      });
      const calls: string[] = [];
      const api = makeRuntime(projectRoot, undefined, async (goalId: string) => {
        calls.push(goalId);
      });

      const result = await api.startProject('operator');

      expect(result.success).toBe(false);
      if (result.success) throw new Error('expected startProject to fail');
      expect(result.error.code).toBe('runtime_start_precondition_failed');
      expect(result.error.currentState).toEqual(
        expect.objectContaining({
          intent: 'running',
          activeRunId: 'run-open-root',
        }),
      );
      expect(calls).toEqual([]);
      const state = readRuntimeState(projectRoot)!;
      expect(state.runtime_runs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ run_id: 'run-open-root', runtime_status: 'running' }),
        ]),
      );
      expect(state.runtime_commands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            command_id: result.command.command_id,
            command: 'start_project',
            status: 'rejected',
          }),
        ]),
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('start_project records a completed no-op root run when the project card is missing', async () => {
    const projectRoot = root();
    try {
      const calls: string[] = [];
      const api = makeRuntime(projectRoot, undefined, async (goalId: string) => {
        calls.push(goalId);
      });

      const result = await api.startProject('operator');

      expect(result.success).toBe(true);
      expect(calls).toEqual([]);
      const state = readRuntimeState(projectRoot)!;
      expect(state.runtime_intent!.status).toBe('running');
      expect(state.runtime_runs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'root',
            card_id: 'project',
            runtime_status: 'idle',
            phase: 'completed',
          }),
        ]),
      );
      expect(state.runtime_commands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            command_id: result.command.command_id,
            command: 'start_project',
            status: 'completed',
          }),
        ]),
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('dispatchGoal binds an open planner run to the planner session before planner tool calls', async () => {
    const projectRoot = root();
    try {
      initProjectWithRoot(projectRoot);
      appendRuntimeRun(projectRoot, {
        run_id: 'run-root-sessionless',
        kind: 'root',
        card_id: 'project',
        parent_run_id: null,
        command_id: 'cmd-start',
        activation_id: null,
        phase: 'planner',
        runtime_status: 'running',
        session_id: null,
      });
      appendRuntimeRun(projectRoot, {
        run_id: 'run-child-pending-same-card',
        kind: 'child',
        card_id: 'project',
        parent_run_id: 'run-parent-unrelated',
        command_id: null,
        activation_id: 'activation-unrelated',
        phase: 'planner',
        runtime_status: 'running',
        session_id: null,
      });
      const observedSessionIds: Array<string | null | undefined> = [];
      const activationResults: unknown[] = [];
      const ledgerEvents: unknown[] = [];
      let childId = '';
      const agentRuntime: AgentRuntime = {
        async invokePlanner(request) {
          const goalId = request.goalId;
          const parentRun = readRuntimeState(projectRoot)!.runtime_runs!.find(
            (run) =>
              run.kind === 'root' &&
              run.card_id === goalId &&
              run.phase === 'planner' &&
              run.runtime_status === 'running' &&
              !run.finished_at,
          );
          observedSessionIds.push(parentRun?.session_id);
          const exec = new PlannerControlExecutor({
            projectRoot,
            cardStore: new CardStore(projectRoot),
            activationLedger: activationLedger(projectRoot),
          });
          const msg = await exec.execute({
            toolName: 'activate_card',
            toolCallId: 'call-child-a',
            args: { cardId: childId },
            parentCardId: goalId,
            sessionId: 'planner:project',
          });
          activationResults.push(msg.data);
          return {
            status: 'blocked',
            blocked_reason: 'stop after observing parent run ownership',
          };
        },
        invokeExecutor() {
          throw new Error('executor should not run');
        },
        invokeReviewer() {
          throw new Error('reviewer should not run');
        },
        cancelSession() {
          return false;
        },
        forceCancelSession() {
          return false;
        },
        getHandoffSummary() {
          return null;
        },
        getActiveSessionHandoffs() {
          return [];
        },
      };
      makeRuntime(projectRoot, agentRuntime);
      const child = cards.create({
        type: 'code',
        parent: 'project',
        depth: 1,
        title: 'Child A',
        description: '',
        status: 'backlog',
        tags: [],
        priority: 0,
        urgency: 'normal',
        created_by: 'planner',
        depends_on: [],
        related: [],
        artifacts: [],
        attachments: [],
        acceptance: '',
        retries: 0,
      });
      childId = child.id;
      const sub = subscribe({
        allowedKinds: ['runtime_run'],
        handler: (event) => {
          ledgerEvents.push(event);
        },
      });

      await dispatchTools.dispatchGoal('project');
      sub.unsubscribe();

      expect(observedSessionIds).toEqual(['planner:project']);
      expect(activationResults).toEqual([
        expect.objectContaining({
          success: true,
          activation: expect.objectContaining({
            parent_run_id: 'run-root-sessionless',
            parent_session_id: 'planner:project',
            child_card_id: childId,
          }),
        }),
      ]);
      const state = readRuntimeState(projectRoot)!;
      expect(state.runtime_runs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            run_id: 'run-root-sessionless',
            kind: 'root',
            session_id: 'planner:project',
          }),
          expect.objectContaining({
            run_id: 'run-child-pending-same-card',
            kind: 'child',
            session_id: null,
          }),
        ]),
      );
      expect(state.runtime_runs?.filter((run) => run.card_id === 'project')).toHaveLength(2);
      expect(
        state.runtime_runs?.filter(
          (run) =>
            run.kind === 'child' &&
            run.card_id === childId &&
            run.parent_run_id === 'run-root-sessionless',
        ),
      ).toHaveLength(1);
      expect(ledgerEvents).toContainEqual(
        expect.objectContaining({
          kind: 'runtime_run',
          run: expect.objectContaining({
            run_id: 'run-root-sessionless',
            kind: 'root',
            session_id: 'planner:project',
          }),
        }),
      );
      expect(ledgerEvents).not.toContainEqual(
        expect.objectContaining({
          run: expect.objectContaining({
            run_id: 'run-child-pending-same-card',
            session_id: 'planner:project',
          }),
        }),
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('dispatchGoal promotes a pending child goal run before nested planner tool calls', async () => {
    const projectRoot = root();
    try {
      initProjectWithRoot(projectRoot);
      let goalId = '';
      let grandchildId = '';
      const observedRuns: Array<{ phase?: string; session_id?: string | null }> = [];
      const activationResults: unknown[] = [];
      const agentRuntime: AgentRuntime = {
        async invokePlanner(request) {
          const currentGoalId = request.goalId;
          const parentRun = readRuntimeState(projectRoot)!.runtime_runs!.find(
            (run) => run.run_id === 'run-child-pending',
          );
          observedRuns.push({ phase: parentRun?.phase, session_id: parentRun?.session_id });
          const exec = new PlannerControlExecutor({
            projectRoot,
            cardStore: new CardStore(projectRoot),
            activationLedger: activationLedger(projectRoot),
          });
          const msg = await exec.execute({
            toolName: 'activate_card',
            toolCallId: 'call-grandchild-a',
            args: { cardId: grandchildId },
            parentCardId: currentGoalId,
            sessionId: `planner:${goalId}`,
          });
          activationResults.push(msg.data);
          return {
            status: 'blocked',
            blocked_reason: 'stop after observing child run ownership',
          };
        },
        invokeExecutor() {
          throw new Error('executor should not run');
        },
        invokeReviewer() {
          throw new Error('reviewer should not run');
        },
        cancelSession() {
          return false;
        },
        forceCancelSession() {
          return false;
        },
        getHandoffSummary() {
          return null;
        },
        getActiveSessionHandoffs() {
          return [];
        },
      };
      makeRuntime(projectRoot, agentRuntime);
      const goal = cards.create({
        type: 'goal',
        parent: 'project',
        depth: 1,
        title: 'Goal A',
        description: '',
        status: 'backlog',
        tags: [],
        priority: 0,
        urgency: 'normal',
        created_by: 'planner',
        depends_on: [],
        related: [],
        artifacts: [],
        attachments: [],
        acceptance: '',
        retries: 0,
      });
      goalId = goal.id;
      const grandchild = cards.create({
        type: 'code',
        parent: goal.id,
        depth: 2,
        title: 'Grandchild A',
        description: '',
        status: 'backlog',
        tags: [],
        priority: 0,
        urgency: 'normal',
        created_by: 'planner',
        depends_on: [],
        related: [],
        artifacts: [],
        attachments: [],
        acceptance: '',
        retries: 0,
      });
      grandchildId = grandchild.id;
      appendRuntimeRun(projectRoot, {
        run_id: 'run-child-pending',
        kind: 'child',
        card_id: goal.id,
        parent_run_id: 'run-root',
        command_id: null,
        activation_id: 'activation-goal-a',
        phase: 'pending',
        runtime_status: 'running',
        session_id: null,
      });
      appendRuntimeRun(projectRoot, {
        run_id: 'run-child-other-bound',
        kind: 'child',
        card_id: goal.id,
        parent_run_id: 'run-other-parent',
        command_id: null,
        activation_id: 'activation-other-goal-a',
        phase: 'planner',
        runtime_status: 'running',
        session_id: `planner:other-${goal.id}`,
      });
      await dispatchTools.dispatchGoal(goal.id);

      expect(observedRuns).toEqual([{ phase: 'planner', session_id: `planner:${goal.id}` }]);
      expect(activationResults).toEqual([
        expect.objectContaining({
          success: true,
          activation: expect.objectContaining({
            parent_run_id: 'run-child-pending',
            parent_session_id: `planner:${goal.id}`,
            child_card_id: grandchild.id,
          }),
        }),
      ]);
      const state = readRuntimeState(projectRoot)!;
      expect(state.runtime_runs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            run_id: 'run-child-pending',
            phase: 'planner',
            session_id: `planner:${goal.id}`,
          }),
          expect.objectContaining({
            run_id: 'run-child-other-bound',
            phase: 'planner',
            session_id: `planner:other-${goal.id}`,
          }),
        ]),
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('dispatchGoal logs planner failures and clears active runtime state even if event subscribers fail', async () => {
    const projectRoot = root();
    try {
      initProjectWithRoot(projectRoot);
      appendRuntimeRun(projectRoot, {
        run_id: 'run-root-failure',
        kind: 'root',
        card_id: 'project',
        parent_run_id: null,
        command_id: 'cmd-start',
        activation_id: null,
        phase: 'planner',
        runtime_status: 'running',
        session_id: null,
      });
      const agentRuntime: AgentRuntime = {
        invokePlanner() {
          throw new Error('planner boom');
        },
        invokeExecutor() {
          throw new Error('executor should not run');
        },
        invokeReviewer() {
          throw new Error('reviewer should not run');
        },
        cancelSession() {
          return false;
        },
        forceCancelSession() {
          return false;
        },
        getHandoffSummary() {
          return null;
        },
        getActiveSessionHandoffs() {
          return [];
        },
      };
      makeRuntime(projectRoot, agentRuntime);
      const sub = subscribe({
        allowedKinds: ['runtime_diagnostic'],
        handler: () => {
          throw new Error('subscriber boom');
        },
      });
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      try {
        await expect(dispatchTools.dispatchGoal('project')).rejects.toThrow('planner boom');
      } finally {
        sub.unsubscribe();
        consoleSpy.mockRestore();
      }

      const state = readRuntimeState(projectRoot)!;
      expect(state.status).toBe('idle');
      expect(state.active_card_run).toBeNull();
      expect(cards.read('project')).toEqual(expect.objectContaining({ status: 'failed' }));
      expect(state.runtime_runs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            run_id: 'run-root-failure',
            phase: 'failed',
            runtime_status: 'error',
            outcome: expect.objectContaining({
              kind: 'completed',
              result: 'failed',
              error: 'planner boom',
            }),
            session_id: 'planner:project',
            finished_at: expect.any(String),
          }),
        ]),
      );
      expect(loggerTools.getErrors()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ goalId: 'project', phase: 'planner', message: 'planner boom' }),
        ]),
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('start_project planner failure terminally publishes the root run exactly once', async () => {
    const projectRoot = root();
    try {
      initProjectWithRoot(projectRoot);
      const agentRuntime: AgentRuntime = {
        invokePlanner() {
          throw new Error('planner start boom');
        },
        invokeExecutor() {
          throw new Error('executor should not run');
        },
        invokeReviewer() {
          throw new Error('reviewer should not run');
        },
        cancelSession() {
          return false;
        },
        forceCancelSession() {
          return false;
        },
        getHandoffSummary() {
          return null;
        },
        getActiveSessionHandoffs() {
          return [];
        },
      };
      const api = makeRuntime(projectRoot, agentRuntime);
      const events: Array<{
        kind: string;
        run?: {
          run_id?: string;
          phase?: string;
          runtime_status?: string;
          finished_at?: string | null;
          result?: string | null;
        };
        command?: { command_id?: string; command?: string; status?: string };
      }> = [];
      const sub = subscribe({
        handler: (event) => {
          if (event.kind === 'runtime_run' || event.kind === 'runtime_command')
            events.push(event as never);
        },
      });

      const result = await api.startProject('operator');
      await new Promise<void>((resolve) => setImmediate(resolve));
      sub.unsubscribe();

      if (!result.success) throw new Error(`startProject failed: ${result.error.message}`);
      expect(result.success).toBe(true);
      const state = readRuntimeState(projectRoot)!;
      const rootRun = state.runtime_runs!.find((run) => run.run_id === result.run.run_id)!;
      expect(rootRun).toEqual(
        expect.objectContaining({
          kind: 'root',
          card_id: 'project',
          command_id: result.command.command_id,
          phase: 'failed',
          runtime_status: 'error',
          outcome: expect.objectContaining({
            kind: 'completed',
            result: 'failed',
            error: 'planner start boom',
          }),
          session_id: 'planner:project',
          finished_at: expect.any(String),
        }),
      );
      const terminalFailedRootEvents = events.filter(
        (event) =>
          event.kind === 'runtime_run' &&
          event.run?.run_id === rootRun.run_id &&
          event.run.phase === 'failed' &&
          event.run.runtime_status === 'error' &&
          (event.run as { outcome?: { kind?: string; result?: string } }).outcome?.kind ===
            'completed' &&
          (event.run as { outcome?: { kind?: string; result?: string } }).outcome?.result ===
            'failed',
      );
      expect(terminalFailedRootEvents).toHaveLength(1);
      expect(state.status).toBe('idle');
      expect(state.active_card_run).toBeNull();
      expect(cards.read('project')).toEqual(
        expect.objectContaining({
          status: 'failed',
          status_text: 'Planner failed: planner start boom',
        }),
      );
      expect(state.runtime_intent).toEqual(
        expect.objectContaining({
          status: 'running',
          source_command_id: result.command.command_id,
          reason: 'explicit start_project command',
        }),
      );
      expect(state.runtime_commands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            command_id: result.command.command_id,
            command: 'start_project',
            status: 'completed',
          }),
        ]),
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('project planner done without durable action blocks instead of completing silently', async () => {
    const projectRoot = root();
    try {
      initProjectWithRoot(projectRoot);
      const invokeReviewer = jest.fn<AgentRuntime['invokeReviewer']>(() => {
        throw new Error('reviewer should not run for non-actionable project done');
      });
      const agentRuntime: AgentRuntime = {
        invokePlanner() {
          return {
            status: 'done',
            summary: 'no next work declared',
          };
        },
        invokeExecutor() {
          throw new Error('executor should not run');
        },
        invokeReviewer,
        cancelSession() {
          return false;
        },
        forceCancelSession() {
          return false;
        },
        getHandoffSummary() {
          return null;
        },
        getActiveSessionHandoffs() {
          return [];
        },
      };
      const api = makeRuntime(projectRoot, agentRuntime);

      const result = await api.startProject('operator');
      if (!result.success) throw new Error(`startProject failed: ${result.error.message}`);
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 2000;
        const poll = () => {
          if (diagnostics.getBackgroundDispatchCount() === 0) return resolve();
          if (Date.now() >= deadline)
            return reject(
              new Error(
                `background dispatches did not drain; count=${diagnostics.getBackgroundDispatchCount()}`,
              ),
            );
          setTimeout(poll, 10);
        };
        poll();
      });

      expect(invokeReviewer).not.toHaveBeenCalled();
      const project = cards.read('project')!;
      expect(project.status).toBe('blocked');
      expect(project.lifecycle.result).toEqual(
        expect.objectContaining({
          kind: 'planner_blocked',
          resume_reason: 'non_actionable_project_done',
        }),
      );
      expect(project.lifecycle.error).toContain(
        'Project planner returned done without creating/updating cards',
      );
      const state = readRuntimeState(projectRoot)!;
      expect(state.status).toBe('idle');
      expect(state.active_card_run).toBeNull();
      expect(state.runtime_runs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            run_id: result.run.run_id,
            kind: 'root',
            card_id: 'project',
            phase: 'blocked',
            runtime_status: 'error',
            outcome: expect.objectContaining({ kind: 'blocked' }),
            finished_at: expect.any(String),
          }),
        ]),
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('stop_project records stopped intent and terminally marks open root runs', async () => {
    const projectRoot = root();
    try {
      initProjectWithRoot(projectRoot);
      const api = makeRuntime(projectRoot, undefined, async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
      });
      const startResult = await api.startProject('operator');
      if (!startResult.success)
        throw new Error(`startProject failed: ${startResult.error.message}`);
      const result = await api.stopProject('operator');
      expect(result.success).toBe(true);
      expect(result.run).toMatchObject({
        run_id: startResult.run.run_id,
        kind: 'root',
        card_id: 'project',
        command_id: startResult.command.command_id,
        phase: 'stopped',
        runtime_status: 'stopped',
        outcome: expect.objectContaining({ kind: 'completed', result: 'stopped' }),
      });
      expect(result.run!.finished_at).toEqual(expect.any(String));
      const state = readRuntimeState(projectRoot)!;
      expect(state.runtime_intent!.status).toBe('stopped');
      expect(state.runtime_commands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ command: 'stop_project', status: 'completed' }),
        ]),
      );
      expect(state.runtime_runs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            run_id: startResult.run.run_id,
            finished_at: result.run!.finished_at,
          }),
        ]),
      );
      expect(
        state
          .runtime_runs!.filter((run) => run.kind === 'root')
          .every((run) => run.finished_at || run.phase === 'completed'),
      ).toBe(true);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('stop_project force-cancels the in-flight project planner session', async () => {
    const projectRoot = root();
    try {
      initProjectWithRoot(projectRoot);
      let releasePlanner!: () => void;
      const plannerBlocked = new Promise<void>((resolve) => {
        releasePlanner = resolve;
      });
      let plannerEntered!: () => void;
      const plannerStarted = new Promise<void>((resolve) => {
        plannerEntered = resolve;
      });
      const forceCancelSession = jest.fn<AgentRuntime['forceCancelSession']>(() => true);
      const agentRuntime: AgentRuntime = {
        async invokePlanner() {
          plannerEntered();
          await plannerBlocked;
          return {
            status: 'blocked',
            blocked_reason: 'stop after cancellation observation',
          };
        },
        invokeExecutor() {
          throw new Error('executor should not run');
        },
        invokeReviewer() {
          throw new Error('reviewer should not run');
        },
        cancelSession() {
          return false;
        },
        forceCancelSession,
        getHandoffSummary() {
          return null;
        },
        getActiveSessionHandoffs() {
          return [];
        },
      };
      const api = makeRuntime(projectRoot, agentRuntime);

      const startResult = await api.startProject('operator');
      if (!startResult.success)
        throw new Error(`startProject failed: ${startResult.error.message}`);
      await plannerStarted;

      const stopResult = await api.stopProject('operator');
      expect(stopResult.success).toBe(true);
      expect(forceCancelSession).toHaveBeenCalledWith('planner:project');

      releasePlanner();
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 2000;
        const poll = () => {
          if (diagnostics.getBackgroundDispatchCount() === 0) return resolve();
          if (Date.now() >= deadline)
            return reject(
              new Error(
                `background dispatches did not drain; count=${diagnostics.getBackgroundDispatchCount()}`,
              ),
            );
          setTimeout(poll, 10);
        };
        poll();
      });
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('shutdown force-cancels the in-flight project planner session', async () => {
    const projectRoot = root();
    try {
      initProjectWithRoot(projectRoot);
      let releasePlanner!: () => void;
      const plannerBlocked = new Promise<void>((resolve) => {
        releasePlanner = resolve;
      });
      let plannerEntered!: () => void;
      const plannerStarted = new Promise<void>((resolve) => {
        plannerEntered = resolve;
      });
      const forceCancelSession = jest.fn<AgentRuntime['forceCancelSession']>(() => true);
      const agentRuntime: AgentRuntime = {
        async invokePlanner() {
          plannerEntered();
          await plannerBlocked;
          return {
            status: 'blocked',
            blocked_reason: 'shutdown after cancellation observation',
          };
        },
        invokeExecutor() {
          throw new Error('executor should not run');
        },
        invokeReviewer() {
          throw new Error('reviewer should not run');
        },
        cancelSession() {
          return false;
        },
        forceCancelSession,
        getHandoffSummary() {
          return null;
        },
        getActiveSessionHandoffs() {
          return [];
        },
      };
      const api = makeRuntime(projectRoot, agentRuntime);
      await api.start();

      const startResult = await api.startProject('operator');
      if (!startResult.success)
        throw new Error(`startProject failed: ${startResult.error.message}`);
      await plannerStarted;

      await api.shutdown();
      expect(forceCancelSession).toHaveBeenCalledWith('planner:project');

      releasePlanner();
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 2000;
        const poll = () => {
          if (diagnostics.getBackgroundDispatchCount() === 0) return resolve();
          if (Date.now() >= deadline)
            return reject(
              new Error(
                `background dispatches did not drain; count=${diagnostics.getBackgroundDispatchCount()}`,
              ),
            );
          setTimeout(poll, 10);
        };
        poll();
      });
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('delayed start_project dispatch completion cannot overwrite a stopped root run', async () => {
    const projectRoot = root();
    try {
      initProjectWithRoot(projectRoot);
      let releaseDispatch!: () => void;
      const dispatchBlocked = new Promise<void>((resolve) => {
        releaseDispatch = resolve;
      });
      const api = makeRuntime(projectRoot, undefined, async () => {
        await dispatchBlocked;
      });

      const startResult = await api.startProject('operator');
      if (!startResult.success)
        throw new Error(`startProject failed: ${startResult.error.message}`);
      const stopResult = await api.stopProject('operator');
      expect(stopResult.run).toMatchObject({
        run_id: startResult.run.run_id,
        phase: 'stopped',
        runtime_status: 'stopped',
        outcome: expect.objectContaining({ kind: 'completed', result: 'stopped' }),
      });

      releaseDispatch();
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 2000;
        const poll = () => {
          if (diagnostics.getBackgroundDispatchCount() === 0) return resolve();
          if (Date.now() >= deadline)
            return reject(
              new Error(
                `background dispatches did not drain; count=${diagnostics.getBackgroundDispatchCount()}`,
              ),
            );
          setTimeout(poll, 10);
        };
        poll();
      });

      const state = readRuntimeState(projectRoot)!;
      const rootRun = state.runtime_runs!.find((run) => run.run_id === startResult.run.run_id)!;
      expect(state.runtime_intent).toEqual(
        expect.objectContaining({
          status: 'stopped',
          source_command_id: stopResult.command.command_id,
          reason: 'explicit stop_project command',
        }),
      );
      expect(rootRun).toEqual(
        expect.objectContaining({
          run_id: startResult.run.run_id,
          kind: 'root',
          card_id: 'project',
          command_id: startResult.command.command_id,
          phase: 'stopped',
          runtime_status: 'stopped',
          outcome: expect.objectContaining({ kind: 'completed', result: 'stopped' }),
          finished_at: stopResult.run!.finished_at,
        }),
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('stop_project omits run when no root run was open', async () => {
    const projectRoot = root();
    try {
      const api = makeRuntime(projectRoot);
      const result = await api.stopProject('operator');
      expect(result.success).toBe(true);
      expect(result.intent!.status).toBe('stopped');
      expect(result.run).toBeUndefined();
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('start_project and stop_project publish runtime ledger events matching persisted records', async () => {
    const projectRoot = root();
    try {
      initProjectWithRoot(projectRoot);
      const api = makeRuntime(projectRoot, undefined, async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
      });
      const events: Array<{ kind: string; command?: unknown; run?: unknown }> = [];
      const sub = subscribe({
        handler: (event) => {
          if (event.kind === 'runtime_command' || event.kind === 'runtime_run') events.push(event);
        },
      });

      const start = await api.startProject('operator');
      if (!start.success) throw new Error(`startProject failed: ${start.error.message}`);
      expect(start.success).toBe(true);
      const stop = await api.stopProject('operator');
      sub.unsubscribe();

      const state = readRuntimeState(projectRoot)!;
      const persistedStartCommand = state.runtime_commands!.find(
        (record) => record.command_id === start.command.command_id,
      );
      const persistedStopCommand = state.runtime_commands!.find(
        (record) => record.command_id === stop.command.command_id,
      );
      const persistedRootRun = state.runtime_runs!.find(
        (record) => record.run_id === start.run.run_id,
      );
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'runtime_command', command: persistedStartCommand }),
          expect.objectContaining({ kind: 'runtime_command', command: persistedStopCommand }),
          expect.objectContaining({ kind: 'runtime_run', run: start.run }),
          expect.objectContaining({ kind: 'runtime_run', run: persistedRootRun }),
        ]),
      );

      for (const event of events) expect(loggedEventSchema.parse(event)).toEqual(event);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('shutdown preserves runtime intent, command, run, and activation ledgers after project start and child activation setup', async () => {
    const projectRoot = root();
    try {
      initProjectWithRoot(projectRoot);
      const api = makeRuntime(projectRoot, undefined, async () => undefined);
      await api.start();
      const result = await api.startProject('operator');
      if (!result.success) throw new Error(`startProject failed: ${result.error.message}`);
      expect(result.success).toBe(true);
      const parentRun = result.run;
      const childRun = appendRuntimeRun(projectRoot, {
        kind: 'child',
        card_id: 'child-a',
        parent_run_id: parentRun.run_id,
        command_id: null,
        activation_id: 'activation-a',
        phase: 'executor',
        runtime_status: 'running',
        session_id: 'executor-child-a',
      });
      const activation = upsertRuntimeActivation(projectRoot, {
        activation_id: 'activation-a',
        idempotency_key: 'parent-run:child-a',
        parent_card_id: 'project',
        parent_run_id: parentRun.run_id,
        parent_session_id: 'planner:project',
        parent_tool_call_id: 'tool-call-a',
        child_card_id: 'child-a',
        status: 'running',
        precondition: 'accepted',
        runtime_run_id: childRun.run_id,
      });
      const beforeShutdown = readRuntimeState(projectRoot)!;
      expect(beforeShutdown.runtime_intent!.status).toBe('running');
      expect(beforeShutdown.runtime_commands).toHaveLength(1);
      expect(beforeShutdown.runtime_runs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ run_id: parentRun.run_id }),
          expect.objectContaining({ run_id: childRun.run_id }),
        ]),
      );
      expect(beforeShutdown.runtime_activations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            activation_id: activation.activation_id,
            runtime_run_id: childRun.run_id,
          }),
        ]),
      );
      const rootBeforeShutdown = beforeShutdown.runtime_runs!.find(
        (run) => run.run_id === parentRun.run_id,
      )!;

      await api.shutdown();

      const afterShutdown = readRuntimeState(projectRoot)!;
      await waitForBackgroundDispatchesToDrain();
      const afterSettled = readRuntimeState(projectRoot)!;

      expect(afterSettled.runtime_runs).toEqual(afterShutdown.runtime_runs);
      expect(afterSettled.runtime_activations).toEqual(afterShutdown.runtime_activations);
      expect(afterSettled.status).toBe('idle');
      expect(afterSettled.runtime_intent).toEqual(beforeShutdown.runtime_intent);
      expect(afterSettled.runtime_commands).toEqual(beforeShutdown.runtime_commands);
      expect(afterSettled.runtime_runs).toHaveLength(beforeShutdown.runtime_runs!.length);
      expect(afterSettled.runtime_activations).toHaveLength(
        beforeShutdown.runtime_activations!.length,
      );

      for (const beforeRun of beforeShutdown.runtime_runs ?? []) {
        expect(afterSettled.runtime_runs).toEqual(
          expect.arrayContaining([expect.objectContaining({ run_id: beforeRun.run_id })]),
        );
      }
      for (const beforeActivation of beforeShutdown.runtime_activations ?? []) {
        expect(afterSettled.runtime_activations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ activation_id: beforeActivation.activation_id }),
          ]),
        );
      }

      const rootAfterSettled = afterSettled.runtime_runs!.find(
        (run) => run.run_id === parentRun.run_id,
      )!;
      const childAfterSettled = afterSettled.runtime_runs!.find(
        (run) => run.run_id === childRun.run_id,
      )!;
      const activationAfterSettled = afterSettled.runtime_activations!.find(
        (record) => record.activation_id === activation.activation_id,
      )!;

      expect(rootAfterSettled).toEqual(
        expect.objectContaining({
          run_id: parentRun.run_id,
          kind: 'root',
          card_id: 'project',
          command_id: result.command.command_id,
        }),
      );
      if (rootAfterSettled.finished_at) {
        expect(rootAfterSettled).toEqual(
          expect.objectContaining({
            phase: 'completed',
            runtime_status: 'idle',
            outcome: expect.objectContaining({ kind: 'completed', result: 'done' }),
            finished_at: expect.any(String),
          }),
        );
      } else {
        expect(rootAfterSettled).toEqual(rootBeforeShutdown);
      }
      expect(childAfterSettled).toEqual(
        expect.objectContaining({
          run_id: childRun.run_id,
          activation_id: activation.activation_id,
          card_id: 'child-a',
        }),
      );
      expect(activationAfterSettled).toEqual(
        expect.objectContaining({
          activation_id: activation.activation_id,
          runtime_run_id: childRun.run_id,
          parent_run_id: parentRun.run_id,
          child_card_id: 'child-a',
        }),
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
