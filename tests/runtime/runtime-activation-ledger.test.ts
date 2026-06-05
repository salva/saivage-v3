import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlannerControlExecutor } from '../../src/agents/planner-control-executor.js';
import { AgentAdapter } from '../../src/agents/agent-adapter.js';
import { CardStore } from '../../src/cards/card-store.js';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { appendRuntimeRun, readRuntimeState, upsertRuntimeActivation } from '../../src/runtime/state.js';
import { EventBus } from '../../src/events/index.js';
import { EventLogger } from '../../src/observability/event-logger.js';
import { loggedEventSchema } from '../../src/schemas/validators.js';
import type { SaivageConfig } from '../../src/agents/config-schema.js';

function setup() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-runtime-activation-'));
  initProjectTree(projectRoot);
  const cardStore = new CardStore(projectRoot);
  cardStore.create({ type: 'project', parent: null, depth: 0, title: 'project', description: '', status: 'active', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], blocks: [], artifacts: [], attachments: [], acceptance: '', retries: 0 });
  const goal = cardStore.create({ type: 'goal', parent: 'project', depth: 1, title: 'Goal A', description: '', status: 'active', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], blocks: [], artifacts: [], attachments: [], acceptance: '', retries: 0 });
  const code = cardStore.create({ type: 'code', parent: goal.id, depth: 2, title: 'Code A', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], blocks: [], artifacts: [], attachments: [], acceptance: '', retries: 0 });
  return { projectRoot, cardStore, goalId: goal.id, codeId: code.id };
}


function activationLedger(projectRoot: string) {
  return {
    readState: () => readRuntimeState(projectRoot),
    appendRun: (input: Parameters<typeof appendRuntimeRun>[1]) => appendRuntimeRun(projectRoot, input),
    upsertActivation: (input: Parameters<typeof upsertRuntimeActivation>[1]) => upsertRuntimeActivation(projectRoot, input),
  };
}

describe('runtime activation ledger target contract (Wave 1)', () => {
  it('only an active parent planner run can activate a child card', async () => {
    const ctx = setup();
    try {
      const exec = new PlannerControlExecutor({ projectRoot: ctx.projectRoot, cardStore: ctx.cardStore, activationLedger: activationLedger(ctx.projectRoot) });
      const msg = await exec.execute({ toolName: 'activate_card', toolCallId: 'call-a', argumentsJson: JSON.stringify({ cardId: ctx.codeId }), parentCardId: ctx.goalId, sessionId: `planner:${ctx.goalId}` });
      expect(msg.kind).toBe('tool_error');
      const body = JSON.parse(msg.content);
      expect(body.actionable_error.code).toBe('activate_card_parent_not_active');
    } finally { rmSync(ctx.projectRoot, { recursive: true, force: true }); }
  });

  it('duplicate activate_card calls return the same unresolved activation record without orphan child runs', async () => {
    const ctx = setup();
    try {
      appendRuntimeRun(ctx.projectRoot, { run_id: 'run-parent', kind: 'root', card_id: ctx.goalId, parent_run_id: null, command_id: 'cmd-a', activation_id: null, phase: 'planner', runtime_status: 'running', session_id: `planner:${ctx.goalId}` });
      const exec = new PlannerControlExecutor({ projectRoot: ctx.projectRoot, cardStore: ctx.cardStore, activationLedger: activationLedger(ctx.projectRoot) });
      const invocation = { toolName: 'activate_card', toolCallId: 'call-a', argumentsJson: JSON.stringify({ cardId: ctx.codeId }), parentCardId: ctx.goalId, sessionId: `planner:${ctx.goalId}` };
      const first = JSON.parse((await exec.execute(invocation)).content);
      const second = JSON.parse((await exec.execute(invocation)).content);
      expect(first.success).toBe(true);
      expect(second.success).toBe(true);
      expect(second.activation.activation_id).toBe(first.activation.activation_id);
      expect(second.activation.runtime_run_id).toBe(first.activation.runtime_run_id);

      const state = readRuntimeState(ctx.projectRoot)!;
      const activations = state.runtime_activations ?? [];
      const childRuns = (state.runtime_runs ?? []).filter((run) => run.kind === 'child' && run.card_id === ctx.codeId && run.parent_run_id === 'run-parent');
      expect(activations).toHaveLength(1);
      expect(childRuns).toHaveLength(1);
      expect(activations[0].runtime_run_id).toBe(childRuns[0].run_id);
      expect(first.activation.runtime_run_id).toBe(childRuns[0].run_id);
    } finally { rmSync(ctx.projectRoot, { recursive: true, force: true }); }
  });

  it('links activation and child runtime run to the matching session-owned parent run when same card has multiple active planner runs', async () => {
    const ctx = setup();
    try {
      appendRuntimeRun(ctx.projectRoot, { run_id: 'run-parent-other-session', kind: 'root', card_id: ctx.goalId, parent_run_id: null, command_id: 'cmd-a', activation_id: null, phase: 'planner', runtime_status: 'running', session_id: `planner:${ctx.goalId}:old-session` });
      appendRuntimeRun(ctx.projectRoot, { run_id: 'run-parent-matching-session', kind: 'root', card_id: ctx.goalId, parent_run_id: null, command_id: 'cmd-b', activation_id: null, phase: 'planner', runtime_status: 'running', session_id: `planner:${ctx.goalId}:current-session` });
      const exec = new PlannerControlExecutor({ projectRoot: ctx.projectRoot, cardStore: ctx.cardStore, activationLedger: activationLedger(ctx.projectRoot) });
      const invocation = { toolName: 'activate_card', toolCallId: 'call-current', argumentsJson: JSON.stringify({ cardId: ctx.codeId }), parentCardId: ctx.goalId, sessionId: `planner:${ctx.goalId}:current-session` };

      const firstMsg = await exec.execute(invocation);
      expect(firstMsg.kind).toBe('tool_result');
      const first = JSON.parse(firstMsg.content);
      expect(first.success).toBe(true);
      expect(first.activation.parent_run_id).toBe('run-parent-matching-session');

      const stateAfterFirst = readRuntimeState(ctx.projectRoot)!;
      const childRun = (stateAfterFirst.runtime_runs ?? []).find((run) => run.run_id === first.activation.runtime_run_id);
      expect(childRun).toBeDefined();
      expect(childRun?.parent_run_id).toBe('run-parent-matching-session');

      const secondMsg = await exec.execute(invocation);
      expect(secondMsg.kind).toBe('tool_result');
      const second = JSON.parse(secondMsg.content);
      expect(second.success).toBe(true);
      expect(second.activation.activation_id).toBe(first.activation.activation_id);
      expect(second.activation.parent_run_id).toBe('run-parent-matching-session');
      expect(second.activation.runtime_run_id).toBe(first.activation.runtime_run_id);

      const stateAfterSecond = readRuntimeState(ctx.projectRoot)!;
      const matchingChildRuns = (stateAfterSecond.runtime_runs ?? [])
        .filter((run) => run.kind === 'child' && run.card_id === ctx.codeId && run.parent_run_id === 'run-parent-matching-session');
      const wrongParentChildRuns = (stateAfterSecond.runtime_runs ?? [])
        .filter((run) => run.kind === 'child' && run.card_id === ctx.codeId && run.parent_run_id === 'run-parent-other-session');
      expect(matchingChildRuns).toHaveLength(1);
      expect(wrongParentChildRuns).toHaveLength(0);
    } finally { rmSync(ctx.projectRoot, { recursive: true, force: true }); }
  });



  it('activate_card publishes child run and activation ledger events matching persisted records', async () => {
    const ctx = setup();
    let logger: EventLogger | null = null;
    try {
      appendRuntimeRun(ctx.projectRoot, { run_id: 'run-parent', kind: 'root', card_id: ctx.goalId, parent_run_id: null, command_id: 'cmd-a', activation_id: null, phase: 'planner', runtime_status: 'running', session_id: `planner:${ctx.goalId}` });
      logger = new EventLogger(join(ctx.projectRoot, '.saivage'));
      const eventBus = new EventBus();
      const events: Array<{ kind: string; run?: unknown; activation?: unknown }> = [];
      const sub = eventBus.subscribe({ handler: (event) => { if (event.kind === 'runtime_run' || event.kind === 'runtime_activation') events.push(event); } });
      const exec = new PlannerControlExecutor({ projectRoot: ctx.projectRoot, cardStore: ctx.cardStore, activationLedger: activationLedger(ctx.projectRoot), eventLogger: logger, eventBus });

      const msg = await exec.execute({ toolName: 'activate_card', toolCallId: 'call-a', argumentsJson: JSON.stringify({ cardId: ctx.codeId }), parentCardId: ctx.goalId, sessionId: `planner:${ctx.goalId}` });
      sub.unsubscribe();
      expect(msg.kind).toBe('tool_result');

      const state = readRuntimeState(ctx.projectRoot)!;
      const activation = state.runtime_activations!.find((record) => record.child_card_id === ctx.codeId);
      const childRun = state.runtime_runs!.find((record) => record.run_id === activation!.runtime_run_id);
      expect(activation?.idempotency_key).toBe(`run-parent:planner:${ctx.goalId}:call-a:${ctx.codeId}`);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'runtime_run', run: childRun }),
        expect.objectContaining({ kind: 'runtime_activation', activation }),
      ]));
      expect((events.find((event) => event.kind === 'runtime_activation') as any).activation.idempotency_key).toBe(activation?.idempotency_key);
    } finally { logger?.close(); rmSync(ctx.projectRoot, { recursive: true, force: true }); }
  });

  it('AgentAdapter activate_card publishes exact logged ledger events once to runtime ledger event bus', async () => {
    const ctx = setup();
    let logger: EventLogger | null = null;
    try {
      appendRuntimeRun(ctx.projectRoot, { run_id: 'run-parent', kind: 'root', card_id: ctx.goalId, parent_run_id: null, command_id: 'cmd-a', activation_id: null, phase: 'planner', runtime_status: 'running', session_id: `planner:${ctx.goalId}` });
      const config = {
        providers: {},
        models: {},
        server: { port: 8080, host: '127.0.0.1' },
        runtime: { continuousImprovement: false, maxReviewRetries: 3, recoveryDelayMs: 60000, maxRecoveryRetries: 0, selfCheck: { planner: 0, executor: 0, reviewer: 0, analyst: 0 } },
        security: {},
        supervisor: { enabled: false },
      } as unknown as SaivageConfig;
      logger = new EventLogger(join(ctx.projectRoot, '.saivage'));
      const eventBus = new EventBus();
      const agentAdapter = new AgentAdapter({
        projectRoot: ctx.projectRoot,
        saivageDir: join(ctx.projectRoot, '.saivage'),
        config,
        eventLogger: logger,
        activationLedger: activationLedger(ctx.projectRoot),
      });
      agentAdapter.setRuntimeLedgerEventBus(eventBus);
      const events: Array<{ kind: string; run?: unknown; activation?: unknown; id?: string; timestamp?: string }> = [];
      const sub = eventBus.subscribe({
        allowedKinds: ['runtime_run', 'runtime_activation'],
        handler: (event) => { events.push(event); },
      });

      const result = await (agentAdapter as any).processToolCall(
        { id: 'call-runtime-ledger', type: 'function', function: { name: 'activate_card', arguments: JSON.stringify({ cardId: ctx.codeId }) } },
        'planner',
        `planner:${ctx.goalId}`,
        { goalId: ctx.goalId, cardId: ctx.goalId },
      );
      sub.unsubscribe();

      expect(result).toMatchObject({ role: 'tool', kind: 'tool_result', tool: 'activate_card', tool_call_id: 'call-runtime-ledger' });
      expect(events.map((event) => event.kind)).toEqual(['runtime_run', 'runtime_activation']);
      expect(events).toHaveLength(2);
      for (const event of events) expect(loggedEventSchema.parse(event)).toEqual(event);

      const state = readRuntimeState(ctx.projectRoot)!;
      const activation = state.runtime_activations!.find((record) => record.child_card_id === ctx.codeId);
      const childRun = state.runtime_runs!.find((record) => record.run_id === activation!.runtime_run_id);
      expect(events[0]).toEqual(expect.objectContaining({ kind: 'runtime_run', run: childRun }));
      expect(activation?.idempotency_key).toBe(`run-parent:planner:${ctx.goalId}:call-runtime-ledger:${ctx.codeId}`);
      expect(events[1]).toEqual(expect.objectContaining({ kind: 'runtime_activation', activation }));
      expect((events[1] as any).activation.idempotency_key).toBe(activation?.idempotency_key);

      const persistedRunEvents = logger.getEvents({ kind: 'runtime_run' }).filter((event) => (event as any).run?.run_id === childRun!.run_id);
      const persistedActivationEvents = logger.getEvents({ kind: 'runtime_activation' }).filter((event) => (event as any).activation?.activation_id === activation!.activation_id);
      expect(persistedRunEvents).toEqual([expect.objectContaining({ kind: events[0].kind, run: events[0].run })]);
      expect(persistedActivationEvents).toEqual([expect.objectContaining({ kind: events[1].kind, activation: events[1].activation })]);
      expect((persistedActivationEvents[0] as any).activation.idempotency_key).toBe(activation?.idempotency_key);

    } finally {
      logger?.close();
      rmSync(ctx.projectRoot, { recursive: true, force: true });
    }
  });

  it('does not let a sessionless active parent run authorize a nonmatching nonempty planner session', async () => {
    const ctx = setup();
    try {
      appendRuntimeRun(ctx.projectRoot, { run_id: 'run-parent-sessionless', kind: 'root', card_id: ctx.goalId, parent_run_id: null, command_id: 'cmd-a', activation_id: null, phase: 'planner', runtime_status: 'running', session_id: null });
      const exec = new PlannerControlExecutor({ projectRoot: ctx.projectRoot, cardStore: ctx.cardStore, activationLedger: activationLedger(ctx.projectRoot) });
      const msg = await exec.execute({ toolName: 'activate_card', toolCallId: 'call-current', argumentsJson: JSON.stringify({ cardId: ctx.codeId }), parentCardId: ctx.goalId, sessionId: `planner:${ctx.goalId}:current-session` });

      expect(msg.kind).toBe('tool_error');
      const body = JSON.parse(msg.content);
      expect(body.actionable_error.code).toBe('activate_card_parent_not_active');
      expect(body.actionable_error.currentState).toEqual(expect.objectContaining({
        parentCardId: ctx.goalId,
        childCardId: ctx.codeId,
        sessionId: `planner:${ctx.goalId}:current-session`,
        parentRunId: null,
      }));
      expect(body.actionable_error.currentState.parentRunCandidates).toEqual([
        expect.objectContaining({
          run_id: 'run-parent-sessionless',
          card_id: ctx.goalId,
          phase: 'planner',
          runtime_status: 'running',
          session_id: null,
        }),
      ]);
    } finally { rmSync(ctx.projectRoot, { recursive: true, force: true }); }
  });

  it('returns actionable parent-not-active details when active parent runs do not match the invoking session', async () => {
    const ctx = setup();
    try {
      appendRuntimeRun(ctx.projectRoot, { run_id: 'run-parent-other-session', kind: 'root', card_id: ctx.goalId, parent_run_id: null, command_id: 'cmd-a', activation_id: null, phase: 'planner', runtime_status: 'running', session_id: `planner:${ctx.goalId}:other-session` });
      const exec = new PlannerControlExecutor({ projectRoot: ctx.projectRoot, cardStore: ctx.cardStore, activationLedger: activationLedger(ctx.projectRoot) });
      const msg = await exec.execute({ toolName: 'activate_card', toolCallId: 'call-current', argumentsJson: JSON.stringify({ cardId: ctx.codeId }), parentCardId: ctx.goalId, sessionId: `planner:${ctx.goalId}:current-session` });

      expect(msg.kind).toBe('tool_error');
      const body = JSON.parse(msg.content);
      expect(body.actionable_error.code).toBe('activate_card_parent_not_active');
      expect(body.actionable_error.currentState).toEqual(expect.objectContaining({
        parentCardId: ctx.goalId,
        childCardId: ctx.codeId,
        sessionId: `planner:${ctx.goalId}:current-session`,
        parentRunId: null,
      }));
      expect(body.actionable_error.currentState.parentRunCandidates).toEqual([
        expect.objectContaining({
          run_id: 'run-parent-other-session',
          card_id: ctx.goalId,
          phase: 'planner',
          runtime_status: 'running',
          session_id: `planner:${ctx.goalId}:other-session`,
        }),
      ]);
    } finally { rmSync(ctx.projectRoot, { recursive: true, force: true }); }
  });

});
