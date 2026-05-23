import { describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../../src/runtime/runtime.js';
import { createRuntimeEnvelope } from '../../src/server/websocket.js';
import { RuntimeCommandEventSchema, RuntimeRunEventSchema, parseKnownWsEnvelope } from '../../src/contracts/operator-events.js';
import { loggedEventSchema } from '../../src/schemas/validators.js';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { appendRuntimeRun, readRuntimeState, upsertRuntimeActivation } from '../../src/runtime/state.js';
import { PlannerControlExecutor } from '../../src/agents/planner-control-executor.js';
import type { AgentRuntime } from '../../src/agents/agent-runtime.js';

function root(): string { return mkdtempSync(join(tmpdir(), 'saivage-runtime-command-')); }

describe('runtime command ledger target contract (Wave 1)', () => {
  it('start_project records running intent and creates a root run before dispatch side effects', async () => {
    const projectRoot = root();
    try {
      const runtime = new Runtime({ projectRoot, fakeAgentConfig: { mapping: {}, fixtureDir: '' }, autoDispatchBacklog: false });
      const calls: string[] = [];
      runtime.dispatchGoal = (async (goalId: string) => { calls.push(goalId); }) as Runtime['dispatchGoal'];
      const result = await runtime.startProject('operator');
      expect(result.success).toBe(true);
      const state = readRuntimeState(projectRoot)!;
      expect(state.runtime_intent!.status).toBe('running');
      expect(state.runtime_commands).toEqual(expect.arrayContaining([expect.objectContaining({ command: 'start_project', status: 'completed' })]));
      expect(state.runtime_runs).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'root', card_id: 'project', command_id: result.command.command_id })]));
      expect(calls).toEqual(['project']);
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });

  it('dispatchGoal binds an open planner run to the planner session before planner tool calls', async () => {
    const projectRoot = root();
    try {
      initProjectTree(projectRoot);
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
        result: null,
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
        result: null,
      });
      const observedSessionIds: Array<string | null | undefined> = [];
      const activationResults: unknown[] = [];
      const ledgerEvents: unknown[] = [];
      let runtime: Runtime;
      const agentRuntime: AgentRuntime = {
        async invokePlanner(goalId) {
          const parentRun = readRuntimeState(projectRoot)!.runtime_runs!.find((run) => run.kind === 'root' && run.card_id === goalId && run.phase === 'planner' && run.runtime_status === 'running' && !run.finished_at);
          observedSessionIds.push(parentRun?.session_id);
          const exec = new PlannerControlExecutor({ projectRoot, cardStore: runtime.cardStore });
          const msg = await exec.execute({ toolName: 'activate_card', toolCallId: 'call-child-a', argumentsJson: JSON.stringify({ cardId: 'child-a' }), parentCardId: goalId, sessionId: 'planner:project' });
          activationResults.push(JSON.parse(msg.content));
          return { status: 'blocked', blocked_reason: 'stop after observing parent run ownership', created_cards: [], updated_cards: [] };
        },
        invokeExecutor() { throw new Error('executor should not run'); },
        invokeReviewer() { throw new Error('reviewer should not run'); },
        cancelSession() { return false; },
        forceCancelSession() { return false; },
        getHandoffSummary() { return null; },
        getActiveSessionHandoffs() { return []; },
      };
      runtime = new Runtime({ projectRoot, fakeAgentConfig: { mapping: {}, fixtureDir: '' }, autoDispatchBacklog: false }, agentRuntime);
      runtime.cardStore.create({ id: 'child-a', type: 'code', parent: 'project', depth: 1, title: 'Child A', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], blocks: [], artifacts: [], attachments: [], acceptance: '', retries: 0 });
      const sub = runtime.eventBus.subscribe({ allowedKinds: ['runtime_run'], handler: (event) => { ledgerEvents.push(event); } });

      await runtime.dispatchGoal('project');
      sub.unsubscribe();

      expect(observedSessionIds).toEqual(['planner:project']);
      expect(activationResults).toEqual([expect.objectContaining({
        success: true,
        activation: expect.objectContaining({ parent_run_id: 'run-root-sessionless', parent_session_id: 'planner:project', child_card_id: 'child-a' }),
      })]);
      const state = readRuntimeState(projectRoot)!;
      expect(state.runtime_runs).toEqual(expect.arrayContaining([
        expect.objectContaining({ run_id: 'run-root-sessionless', kind: 'root', session_id: 'planner:project' }),
        expect.objectContaining({ run_id: 'run-child-pending-same-card', kind: 'child', session_id: null }),
      ]));
      expect(state.runtime_runs?.filter((run) => run.card_id === 'project')).toHaveLength(2);
      expect(state.runtime_runs?.filter((run) => run.kind === 'child' && run.card_id === 'child-a' && run.parent_run_id === 'run-root-sessionless')).toHaveLength(1);
      expect(ledgerEvents).toContainEqual(expect.objectContaining({
        kind: 'runtime_run',
        run: expect.objectContaining({ run_id: 'run-root-sessionless', kind: 'root', session_id: 'planner:project' }),
      }));
      expect(ledgerEvents).not.toContainEqual(expect.objectContaining({
        run: expect.objectContaining({ run_id: 'run-child-pending-same-card', session_id: 'planner:project' }),
      }));
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });

  it('dispatchGoal promotes a pending child goal run before nested planner tool calls', async () => {
    const projectRoot = root();
    try {
      initProjectTree(projectRoot);
      appendRuntimeRun(projectRoot, {
        run_id: 'run-child-pending',
        kind: 'child',
        card_id: 'goal-a',
        parent_run_id: 'run-root',
        command_id: null,
        activation_id: 'activation-goal-a',
        phase: 'pending',
        runtime_status: 'running',
        session_id: null,
        result: null,
      });
      appendRuntimeRun(projectRoot, {
        run_id: 'run-child-other-bound',
        kind: 'child',
        card_id: 'goal-a',
        parent_run_id: 'run-other-parent',
        command_id: null,
        activation_id: 'activation-other-goal-a',
        phase: 'planner',
        runtime_status: 'running',
        session_id: 'planner:other-goal-a',
        result: null,
      });
      const observedRuns: Array<{ phase?: string; session_id?: string | null }> = [];
      const activationResults: unknown[] = [];
      let runtime: Runtime;
      const agentRuntime: AgentRuntime = {
        async invokePlanner(goalId) {
          const parentRun = readRuntimeState(projectRoot)!.runtime_runs!.find((run) => run.run_id === 'run-child-pending');
          observedRuns.push({ phase: parentRun?.phase, session_id: parentRun?.session_id });
          const exec = new PlannerControlExecutor({ projectRoot, cardStore: runtime.cardStore });
          const msg = await exec.execute({ toolName: 'activate_card', toolCallId: 'call-grandchild-a', argumentsJson: JSON.stringify({ cardId: 'grandchild-a' }), parentCardId: goalId, sessionId: 'planner:goal-a' });
          activationResults.push(JSON.parse(msg.content));
          return { status: 'blocked', blocked_reason: 'stop after observing child run ownership', created_cards: [], updated_cards: [] };
        },
        invokeExecutor() { throw new Error('executor should not run'); },
        invokeReviewer() { throw new Error('reviewer should not run'); },
        cancelSession() { return false; },
        forceCancelSession() { return false; },
        getHandoffSummary() { return null; },
        getActiveSessionHandoffs() { return []; },
      };
      runtime = new Runtime({ projectRoot, fakeAgentConfig: { mapping: {}, fixtureDir: '' }, autoDispatchBacklog: false }, agentRuntime);
      runtime.cardStore.create({ id: 'goal-a', type: 'goal', parent: 'project', depth: 1, title: 'Goal A', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], blocks: [], artifacts: [], attachments: [], acceptance: '', retries: 0 });
      runtime.cardStore.create({ id: 'grandchild-a', type: 'code', parent: 'goal-a', depth: 2, title: 'Grandchild A', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], blocks: [], artifacts: [], attachments: [], acceptance: '', retries: 0 });

      await runtime.dispatchGoal('goal-a');

      expect(observedRuns).toEqual([{ phase: 'planner', session_id: 'planner:goal-a' }]);
      expect(activationResults).toEqual([expect.objectContaining({
        success: true,
        activation: expect.objectContaining({ parent_run_id: 'run-child-pending', parent_session_id: 'planner:goal-a', child_card_id: 'grandchild-a' }),
      })]);
      const state = readRuntimeState(projectRoot)!;
      expect(state.runtime_runs).toEqual(expect.arrayContaining([
        expect.objectContaining({ run_id: 'run-child-pending', phase: 'planner', session_id: 'planner:goal-a' }),
        expect.objectContaining({ run_id: 'run-child-other-bound', phase: 'planner', session_id: 'planner:other-goal-a' }),
      ]));
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });

  it('dispatchGoal logs planner failures and clears active runtime state even if event subscribers fail', async () => {
    const projectRoot = root();
    try {
      initProjectTree(projectRoot);
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
        result: null,
      });
      const agentRuntime: AgentRuntime = {
        invokePlanner() { throw new Error('planner boom'); },
        invokeExecutor() { throw new Error('executor should not run'); },
        invokeReviewer() { throw new Error('reviewer should not run'); },
        cancelSession() { return false; },
        forceCancelSession() { return false; },
        getHandoffSummary() { return null; },
        getActiveSessionHandoffs() { return []; },
      };
      const runtime = new Runtime({ projectRoot, fakeAgentConfig: { mapping: {}, fixtureDir: '' }, autoDispatchBacklog: false }, agentRuntime);
      const sub = runtime.eventBus.subscribe({ allowedKinds: ['runtime_diagnostic'], handler: () => { throw new Error('subscriber boom'); } });
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      try {
        await expect(runtime.dispatchGoal('project')).rejects.toThrow('planner boom');
      } finally {
        sub.unsubscribe();
        consoleSpy.mockRestore();
      }

      const state = readRuntimeState(projectRoot)!;
      expect(state.status).toBe('idle');
      expect(state.current_card_id).toBeNull();
      expect(state.current_agent_session_id).toBeNull();
      expect(state.active_card_run).toBeNull();
      expect(runtime.cardStore.read('project')).toEqual(expect.objectContaining({ status: 'failed', error: 'planner boom' }));
      expect(state.runtime_runs).toEqual(expect.arrayContaining([
        expect.objectContaining({ run_id: 'run-root-failure', phase: 'failed', runtime_status: 'error', result: 'failed', session_id: 'planner:project', finished_at: expect.any(String) }),
      ]));
      expect(runtime.errorLogger.getErrors()).toEqual(expect.arrayContaining([
        expect.objectContaining({ goalId: 'project', phase: 'planner', message: 'planner boom' }),
      ]));
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });


  it('start_project planner failure terminally publishes the root run exactly once', async () => {
    const projectRoot = root();
    try {
      initProjectTree(projectRoot);
      const agentRuntime: AgentRuntime = {
        invokePlanner() { throw new Error('planner start boom'); },
        invokeExecutor() { throw new Error('executor should not run'); },
        invokeReviewer() { throw new Error('reviewer should not run'); },
        cancelSession() { return false; },
        forceCancelSession() { return false; },
        getHandoffSummary() { return null; },
        getActiveSessionHandoffs() { return []; },
      };
      const runtime = new Runtime({ projectRoot, fakeAgentConfig: { mapping: {}, fixtureDir: '' }, autoDispatchBacklog: false }, agentRuntime);
      const events: Array<{ kind: string; run?: { run_id?: string; phase?: string; runtime_status?: string; finished_at?: string | null; result?: string | null }; command?: { command_id?: string; command?: string; status?: string } }> = [];
      const sub = runtime.eventBus.subscribe({ handler: (event) => { if (event.kind === 'runtime_run' || event.kind === 'runtime_command') events.push(event as never); } });

      const result = await runtime.startProject('operator');
      await new Promise<void>((resolve) => setImmediate(resolve));
      sub.unsubscribe();

      if (!result.success) throw new Error(`startProject failed: ${result.error.message}`);
      expect(result.success).toBe(true);
      const state = readRuntimeState(projectRoot)!;
      const rootRun = state.runtime_runs!.find((run) => run.run_id === result.run.run_id)!;
      expect(rootRun).toEqual(expect.objectContaining({
        kind: 'root',
        card_id: 'project',
        command_id: result.command.command_id,
        phase: 'failed',
        runtime_status: 'error',
        result: 'failed',
        session_id: 'planner:project',
        finished_at: expect.any(String),
      }));
      const terminalFailedRootEvents = events.filter((event) => event.kind === 'runtime_run' && event.run?.run_id === rootRun.run_id && event.run.phase === 'failed' && event.run.runtime_status === 'error' && event.run.result === 'failed');
      expect(terminalFailedRootEvents).toHaveLength(1);
      expect(state.status).toBe('idle');
      expect(state.current_card_id).toBeNull();
      expect(state.current_agent_session_id).toBeNull();
      expect(state.active_card_run).toBeNull();
      expect(runtime.cardStore.read('project')).toEqual(expect.objectContaining({ status: 'failed', error: 'planner start boom' }));
      expect(state.runtime_intent).toEqual(expect.objectContaining({ status: 'running', source_command_id: result.command.command_id, reason: 'explicit start_project command' }));
      expect(state.runtime_commands).toEqual(expect.arrayContaining([
        expect.objectContaining({ command_id: result.command.command_id, command: 'start_project', status: 'completed' }),
      ]));
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });

  it('stop_project records stopped intent and terminally marks open root runs', async () => {
    const projectRoot = root();
    try {
      const runtime = new Runtime({ projectRoot, fakeAgentConfig: { mapping: {}, fixtureDir: '' }, autoDispatchBacklog: false });
      runtime.dispatchGoal = (async () => { await new Promise<void>((resolve) => setImmediate(resolve)); }) as Runtime['dispatchGoal'];
      const startResult = await runtime.startProject('operator');
      if (!startResult.success) throw new Error(`startProject failed: ${startResult.error.message}`);
      const result = await runtime.stopProject('operator');
      expect(result.success).toBe(true);
      expect(result.run).toMatchObject({
        run_id: startResult.run.run_id,
        kind: 'root',
        card_id: 'project',
        command_id: startResult.command.command_id,
        phase: 'stopped',
        runtime_status: 'stopped',
        result: 'stopped',
      });
      expect(result.run!.finished_at).toEqual(expect.any(String));
      const state = readRuntimeState(projectRoot)!;
      expect(state.runtime_intent!.status).toBe('stopped');
      expect(state.runtime_commands).toEqual(expect.arrayContaining([expect.objectContaining({ command: 'stop_project', status: 'completed' })]));
      expect(state.runtime_runs).toEqual(expect.arrayContaining([expect.objectContaining({ run_id: startResult.run.run_id, finished_at: result.run!.finished_at })]));
      expect(state.runtime_runs!.filter((run) => run.kind === 'root').every((run) => run.finished_at || run.phase === 'completed')).toBe(true);
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });


  it('stop_project force-cancels the in-flight project planner session', async () => {
    const projectRoot = root();
    try {
      initProjectTree(projectRoot);
      let releasePlanner!: () => void;
      const plannerBlocked = new Promise<void>((resolve) => { releasePlanner = resolve; });
      let plannerEntered!: () => void;
      const plannerStarted = new Promise<void>((resolve) => { plannerEntered = resolve; });
      const forceCancelSession = jest.fn<AgentRuntime['forceCancelSession']>(() => true);
      const agentRuntime: AgentRuntime = {
        async invokePlanner() {
          plannerEntered();
          await plannerBlocked;
          return { status: 'blocked', blocked_reason: 'stop after cancellation observation', created_cards: [], updated_cards: [] };
        },
        invokeExecutor() { throw new Error('executor should not run'); },
        invokeReviewer() { throw new Error('reviewer should not run'); },
        cancelSession() { return false; },
        forceCancelSession,
        getHandoffSummary() { return null; },
        getActiveSessionHandoffs() { return []; },
      };
      const runtime = new Runtime({ projectRoot, fakeAgentConfig: { mapping: {}, fixtureDir: '' }, autoDispatchBacklog: false }, agentRuntime);

      const startResult = await runtime.startProject('operator');
      if (!startResult.success) throw new Error(`startProject failed: ${startResult.error.message}`);
      await plannerStarted;

      const stopResult = await runtime.stopProject('operator');
      expect(stopResult.success).toBe(true);
      expect(forceCancelSession).toHaveBeenCalledWith('planner:project');

      releasePlanner();
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 2000;
        const poll = () => {
          if (runtime.getBackgroundDispatchCount() === 0) return resolve();
          if (Date.now() >= deadline) return reject(new Error(`background dispatches did not drain; count=${runtime.getBackgroundDispatchCount()}`));
          setTimeout(poll, 10);
        };
        poll();
      });
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });

  it('shutdown force-cancels the in-flight project planner session', async () => {
    const projectRoot = root();
    try {
      initProjectTree(projectRoot);
      let releasePlanner!: () => void;
      const plannerBlocked = new Promise<void>((resolve) => { releasePlanner = resolve; });
      let plannerEntered!: () => void;
      const plannerStarted = new Promise<void>((resolve) => { plannerEntered = resolve; });
      const forceCancelSession = jest.fn<AgentRuntime['forceCancelSession']>(() => true);
      const agentRuntime: AgentRuntime = {
        async invokePlanner() {
          plannerEntered();
          await plannerBlocked;
          return { status: 'blocked', blocked_reason: 'shutdown after cancellation observation', created_cards: [], updated_cards: [] };
        },
        invokeExecutor() { throw new Error('executor should not run'); },
        invokeReviewer() { throw new Error('reviewer should not run'); },
        cancelSession() { return false; },
        forceCancelSession,
        getHandoffSummary() { return null; },
        getActiveSessionHandoffs() { return []; },
      };
      const runtime = new Runtime({ projectRoot, fakeAgentConfig: { mapping: {}, fixtureDir: '' }, autoDispatchBacklog: false }, agentRuntime);
      await runtime.startup();

      const startResult = await runtime.startProject('operator');
      if (!startResult.success) throw new Error(`startProject failed: ${startResult.error.message}`);
      await plannerStarted;

      await runtime.shutdown();
      expect(forceCancelSession).toHaveBeenCalledWith('planner:project');

      releasePlanner();
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 2000;
        const poll = () => {
          if (runtime.getBackgroundDispatchCount() === 0) return resolve();
          if (Date.now() >= deadline) return reject(new Error(`background dispatches did not drain; count=${runtime.getBackgroundDispatchCount()}`));
          setTimeout(poll, 10);
        };
        poll();
      });
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });

  it('delayed start_project dispatch completion cannot overwrite a stopped root run', async () => {
    const projectRoot = root();
    try {
      const runtime = new Runtime({ projectRoot, fakeAgentConfig: { mapping: {}, fixtureDir: '' }, autoDispatchBacklog: false });
      let releaseDispatch!: () => void;
      const dispatchBlocked = new Promise<void>((resolve) => { releaseDispatch = resolve; });
      runtime.dispatchGoal = (async () => { await dispatchBlocked; }) as Runtime['dispatchGoal'];

      const startResult = await runtime.startProject('operator');
      if (!startResult.success) throw new Error(`startProject failed: ${startResult.error.message}`);
      const stopResult = await runtime.stopProject('operator');
      expect(stopResult.run).toMatchObject({ run_id: startResult.run.run_id, phase: 'stopped', runtime_status: 'stopped', result: 'stopped' });

      releaseDispatch();
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 2000;
        const poll = () => {
          if (runtime.getBackgroundDispatchCount() === 0) return resolve();
          if (Date.now() >= deadline) return reject(new Error(`background dispatches did not drain; count=${runtime.getBackgroundDispatchCount()}`));
          setTimeout(poll, 10);
        };
        poll();
      });

      const state = readRuntimeState(projectRoot)!;
      const rootRun = state.runtime_runs!.find((run) => run.run_id === startResult.run.run_id)!;
      expect(state.runtime_intent).toEqual(expect.objectContaining({ status: 'stopped', source_command_id: stopResult.command.command_id, reason: 'explicit stop_project command' }));
      expect(rootRun).toEqual(expect.objectContaining({
        run_id: startResult.run.run_id,
        kind: 'root',
        card_id: 'project',
        command_id: startResult.command.command_id,
        phase: 'stopped',
        runtime_status: 'stopped',
        result: 'stopped',
        finished_at: stopResult.run!.finished_at,
      }));
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });

  it('stop_project omits run when no root run was open', async () => {
    const projectRoot = root();
    try {
      const runtime = new Runtime({ projectRoot, fakeAgentConfig: { mapping: {}, fixtureDir: '' }, autoDispatchBacklog: false });
      const result = await runtime.stopProject('operator');
      expect(result.success).toBe(true);
      expect(result.intent!.status).toBe('stopped');
      expect(result.run).toBeUndefined();
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });


  it('start_project and stop_project publish runtime ledger events matching persisted records', async () => {
    const projectRoot = root();
    try {
      const runtime = new Runtime({ projectRoot, fakeAgentConfig: { mapping: {}, fixtureDir: '' }, autoDispatchBacklog: false });
      runtime.dispatchGoal = (async () => { await new Promise<void>((resolve) => setImmediate(resolve)); }) as Runtime['dispatchGoal'];
      const events: Array<{ kind: string; command?: unknown; run?: unknown }> = [];
      const sub = runtime.eventBus.subscribe({ handler: (event) => { if (event.kind === 'runtime_command' || event.kind === 'runtime_run') events.push(event); } });

      const start = await runtime.startProject('operator');
      if (!start.success) throw new Error(`startProject failed: ${start.error.message}`);
      expect(start.success).toBe(true);
      const stop = await runtime.stopProject('operator');
      sub.unsubscribe();

      const state = readRuntimeState(projectRoot)!;
      const persistedStartCommand = state.runtime_commands!.find((record) => record.command_id === start.command.command_id);
      const persistedStopCommand = state.runtime_commands!.find((record) => record.command_id === stop.command.command_id);
      const persistedRootRun = state.runtime_runs!.find((record) => record.run_id === start.run.run_id);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'runtime_command', command: persistedStartCommand }),
        expect.objectContaining({ kind: 'runtime_command', command: persistedStopCommand }),
        expect.objectContaining({ kind: 'runtime_run', run: start.run }),
        expect.objectContaining({ kind: 'runtime_run', run: persistedRootRun }),
      ]));

      for (const event of events) expect(loggedEventSchema.parse(event)).toEqual(event);
      const projected = events.map((event) => createRuntimeEnvelope(event.kind, event as unknown as Record<string, unknown>));
      const commandEnvelopes = projected.filter((envelope) => envelope.content.event === 'runtime.command');
      const runEnvelopes = projected.filter((envelope) => envelope.content.event === 'runtime.run');
      expect(commandEnvelopes).toHaveLength(2);
      expect(runEnvelopes.length).toBeGreaterThanOrEqual(2);
      expect(RuntimeCommandEventSchema.parse(commandEnvelopes[0]).content.command).toEqual(persistedStartCommand);
      expect(RuntimeRunEventSchema.parse(runEnvelopes[0]).content.run).toEqual(start.run);
      for (const envelope of projected) expect(parseKnownWsEnvelope(envelope)).toEqual(envelope);
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });

  it('shutdown preserves runtime intent, command, run, and activation ledgers after project start and child activation setup', async () => {
    const projectRoot = root();
    try {
      initProjectTree(projectRoot);
      const runtime = new Runtime({ projectRoot, fakeAgentConfig: { mapping: {}, fixtureDir: '' }, autoDispatchBacklog: false });
      runtime.dispatchGoal = (async () => {}) as Runtime['dispatchGoal'];
      await runtime.startup();
      const result = await runtime.startProject('operator');
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
        result: null,
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
      expect(beforeShutdown.runtime_runs).toEqual(expect.arrayContaining([expect.objectContaining({ run_id: parentRun.run_id }), expect.objectContaining({ run_id: childRun.run_id })]));
      expect(beforeShutdown.runtime_activations).toEqual(expect.arrayContaining([expect.objectContaining({ activation_id: activation.activation_id, runtime_run_id: childRun.run_id })]));

      await runtime.shutdown();

      const afterShutdown = readRuntimeState(projectRoot)!;
      expect(afterShutdown.status).toBe('idle');
      expect(afterShutdown.runtime_intent).toEqual(beforeShutdown.runtime_intent);
      expect(afterShutdown.runtime_commands).toEqual(beforeShutdown.runtime_commands);
      expect(afterShutdown.runtime_runs).toEqual(beforeShutdown.runtime_runs);
      expect(afterShutdown.runtime_activations).toEqual(beforeShutdown.runtime_activations);
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });

});
