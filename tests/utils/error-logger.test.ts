import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  existsSync,
  rmSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { CardStore } from '../../src/cards/card-store.js';
import { ErrorLogger, type ErrorRecord, type ErrorInput } from '../../src/observability/error-logger.js';
import { releaseLock } from '../../src/runtime/lock.js';
import { FakeAgentAdapter, type FakeAgentFixture } from '../../src/runtime/fake-agent.js';
import type { CardRecord } from '../../src/schemas/types.js';
import { createRuntimeCoreTestContainer, type RuntimeCoreTestContainer } from '../../src/runtime/core-composition.js';
import { PlannerControlExecutor } from '../../src/agents/planner-control-executor.js';
import {
  appendRuntimeRun,
  readRuntimeState,
  upsertRuntimeActivation,
} from '../../src/runtime/state.js';
import type { AgentExecutionPort, PlannerInvocationRequest, PlannerResult } from '../../src/contracts/index.js';

function activationLedger(projectRoot: string) {
  return {
    readState: () => readRuntimeState(projectRoot),
    appendRun: (input: Parameters<typeof appendRuntimeRun>[1]) =>
      appendRuntimeRun(projectRoot, input),
    upsertActivation: (input: Parameters<typeof upsertRuntimeActivation>[1]) =>
      upsertRuntimeActivation(projectRoot, input),
  };
}

function seedPlannerRun(projectRoot: string, goalId: string): void {
  appendRuntimeRun(projectRoot, {
    kind: 'root',
    ownership: { kind: 'direct', source: 'project_root' }, card_id: goalId,
    parent_run_id: null,
    command_id: null,
    activation_id: null,
    phase: 'planner',
    runtime_status: 'running',
    session_id: null,
  });
}

class ActivatingFakeAgentAdapter implements AgentExecutionPort {
  private readonly fakeAgent: FakeAgentAdapter;

  constructor(
    private readonly projectRoot: string,
    config: ConstructorParameters<typeof FakeAgentAdapter>[0],
    private readonly childrenByParent: Record<string, string[]>,
  ) {
    this.fakeAgent = new FakeAgentAdapter(config);
  }

  async invokePlanner(requestOrGoalId: PlannerInvocationRequest | string): Promise<PlannerResult> {
    const goalId = typeof requestOrGoalId === 'string' ? requestOrGoalId : requestOrGoalId.goalId;
    const result = this.fakeAgent.invokePlanner(requestOrGoalId as PlannerInvocationRequest);
    if (result.status !== 'continue') return result;
    const childId = this.childrenByParent[goalId]?.find((id) => {
      const card = new CardStore(this.projectRoot).read(id);
      return card?.status === 'backlog';
    });
    if (!childId) return result;
    const exec = new PlannerControlExecutor({
      projectRoot: this.projectRoot,
      cardStore: new CardStore(this.projectRoot),
      activationLedger: activationLedger(this.projectRoot),
    });
    const parentRun = readRuntimeState(this.projectRoot)?.runtime_runs?.find(
      (run) => run.card_id === goalId && run.phase === 'planner' && run.runtime_status === 'running' && !run.finished_at,
    );
    const activation = await exec.execute({
      toolName: 'activate_card',
      toolCallId: `activate-${childId}`,
      args: { cardId: childId },
      parentCardId: goalId,
      sessionId: parentRun?.session_id ?? '',
    });
    const body = activation.data as { success?: boolean; activation?: Parameters<NonNullable<PlannerInvocationRequest['activationBarrier']>['dispatch']>[0]['activation']; actionable_error?: { message?: string } };
    if (body.success !== true) throw new Error(body.actionable_error?.message ?? 'activate_card failed');
    if (body.activation && typeof requestOrGoalId !== 'string') await requestOrGoalId.activationBarrier?.dispatch({ activation: body.activation });
    return result;
  }

  invokeExecutor: AgentExecutionPort['invokeExecutor'] = (request) => this.fakeAgent.invokeExecutor(request);
  invokeReviewer: AgentExecutionPort['invokeReviewer'] = (request) => this.fakeAgent.invokeReviewer(request);
  cancelSession: AgentExecutionPort['cancelSession'] = (sessionId) => this.fakeAgent.cancelSession(sessionId);
  forceCancelSession: AgentExecutionPort['forceCancelSession'] = (sessionId) => this.fakeAgent.forceCancelSession(sessionId);
  getHandoffSummary: AgentExecutionPort['getHandoffSummary'] = (sessionId) => this.fakeAgent.getHandoffSummary(sessionId);
  getActiveSessionHandoffs: AgentExecutionPort['getActiveSessionHandoffs'] = () => this.fakeAgent.getActiveSessionHandoffs();
}

async function waitForBackgroundDispatchesToDrain(harness: RuntimeCoreTestContainer): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (harness.diagnosticTestTools.getBackgroundDispatchCount() === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `background dispatches did not drain; count=${harness.diagnosticTestTools.getBackgroundDispatchCount()}`,
  );
}

function makeFixtureDir(tmpDir: string): string {
  const dir = join(tmpDir, 'fixtures');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFixture(dir: string, name: string, fixture: FakeAgentFixture): void {
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(fixture, null, 2), 'utf-8');
}

function makeGoalCard(store: CardStore, title: string): CardRecord {
  return store.create({
    type: 'goal',
    parent: 'project',
    depth: 0,
    title,
    description: `Goal: ${title}`,
    status: 'backlog',
    tags: [],
    priority: 1,
    urgency: 'normal',
    created_by: 'analyst',
    depends_on: [],
    related: [],
    acceptance: `Acceptance for ${title}`,
    artifacts: [],
    attachments: [],
    retries: 0,
  });
}

function makeTerminalCard(store: CardStore, parentId: string, title: string): CardRecord {
  return store.create({
    type: 'code',
    parent: parentId,
    depth: 0,
    title,
    description: '',
    status: 'backlog',
    tags: [],
    priority: 1,
    urgency: 'normal',
    created_by: 'planner',
    depends_on: [],
    related: [],
    acceptance: '',
    artifacts: [],
    attachments: [],
    retries: 0,
  });
}

function makePassReviewer(
  goalId: string,
  _planId: string,
  evidenceIds: string[],
): FakeAgentFixture['reviewer'] {
  return [
    {
      assessment: {
        id: `review-${goalId}`,
        goal_card_id: goalId,
        reviewer_session_id: `rev-${goalId}`,
        assessment_id: 'assessment-test',
        at: '2025-01-01T00:00:00.000Z',
        result: 'pass',
        summary: 'All good.',
        achieved: ['Done'],
        issues: [],
        evidence_card_ids: evidenceIds,
        created_at: new Date().toISOString(),
      },
    },
    {
      assessment: {
        id: `review-${goalId}-repeat`,
        goal_card_id: goalId,
        reviewer_session_id: `rev-${goalId}-repeat`,
        assessment_id: 'assessment-test',
        at: '2025-01-01T00:00:00.000Z',
        result: 'pass',
        summary: 'All good.',
        achieved: ['Done'],
        issues: [],
        evidence_card_ids: evidenceIds,
        created_at: new Date().toISOString(),
      },
    },
    {
      assessment: {
        id: `review-${goalId}-repeat-3`,
        goal_card_id: goalId,
        reviewer_session_id: `rev-${goalId}-repeat-3`,
        assessment_id: 'assessment-test',
        at: '2025-01-01T00:00:00.000Z',
        result: 'pass',
        summary: 'All good.',
        achieved: ['Done'],
        issues: [],
        evidence_card_ids: evidenceIds,
        created_at: new Date().toISOString(),
      },
    },
  ];
}

describe('ErrorLogger', () => {
  let tmpDir: string;
  let saivageDir: string;
  let errorLogger: ErrorLogger;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-el-'));
    saivageDir = join(tmpDir, '.saivage');
    mkdirSync(join(saivageDir, 'runtime'), { recursive: true });
    errorLogger = new ErrorLogger(saivageDir);
  });

  afterEach(() => {
    errorLogger.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a record to errors.jsonl with correct fields', () => {
    const input: ErrorInput = {
      message: 'Something went wrong',
      cardId: 'card-1',
      goalId: 'goal-1',
      phase: 'executor',
    };

    const record = errorLogger.appendError(input);
    errorLogger.flushSync();

    expect(record.id).toBeTruthy();
    expect(record.id.startsWith('err-')).toBe(true);
    expect(record.kind).toBe('error');
    expect(record.timestamp).toBeTruthy();
    expect(record.message).toBe('Something went wrong');
    expect(record.cardId).toBe('card-1');
    expect(record.goalId).toBe('goal-1');
    expect(record.phase).toBe('executor');

    const logPath = errorLogger.getErrorsPath();
    expect(existsSync(logPath)).toBe(true);

    const content = readFileSync(logPath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(1);

    const parsed = JSON.parse(lines[0]) as ErrorRecord;
    expect(parsed.id).toBe(record.id);
    expect(parsed.kind).toBe('error');
    expect(parsed.timestamp).toBe(record.timestamp);
    expect(parsed.message).toBe('Something went wrong');
    expect(parsed.cardId).toBe('card-1');
    expect(parsed.goalId).toBe('goal-1');
    expect(parsed.phase).toBe('executor');
  });

  it('getErrors() reads back written records', () => {
    errorLogger.appendError({ message: 'Error 1', cardId: 'c1' });
    errorLogger.appendError({ message: 'Error 2', cardId: 'c2' });
    errorLogger.flushSync();

    const errors = errorLogger.getErrors();
    expect(errors.length).toBe(2);
    expect(errors[0].message).toBe('Error 1');
    expect(errors[0].cardId).toBe('c1');
    expect(errors[1].message).toBe('Error 2');
    expect(errors[1].cardId).toBe('c2');
  });

  it('getErrorsPath() returns the correct path', () => {
    const path = errorLogger.getErrorsPath();
    expect(path).toBe(join(saivageDir, 'runtime', 'errors.jsonl'));
  });

  it('filter by cardId works', () => {
    errorLogger.appendError({ message: 'Error for c1', cardId: 'card-a' });
    errorLogger.appendError({ message: 'Error for c2', cardId: 'card-b' });
    errorLogger.appendError({ message: 'More c1', cardId: 'card-a' });
    errorLogger.flushSync();

    const filtered = errorLogger.getErrors({ cardId: 'card-a' });
    expect(filtered.length).toBe(2);
    expect(filtered.every((e) => e.cardId === 'card-a')).toBe(true);

    const filteredB = errorLogger.getErrors({ cardId: 'card-b' });
    expect(filteredB.length).toBe(1);
    expect(filteredB[0].message).toBe('Error for c2');
  });

  it('filter by goalId works', () => {
    errorLogger.appendError({ message: 'Goal 1 error', goalId: 'goal-1' });
    errorLogger.appendError({ message: 'Goal 2 error', goalId: 'goal-2' });
    errorLogger.appendError({ message: 'Another goal 1', goalId: 'goal-1' });
    errorLogger.flushSync();

    const filtered = errorLogger.getErrors({ goalId: 'goal-1' });
    expect(filtered.length).toBe(2);
    expect(filtered.every((e) => e.goalId === 'goal-1')).toBe(true);
  });

  it('filter by phase works', () => {
    errorLogger.appendError({ message: 'Planner error', phase: 'planner' });
    errorLogger.appendError({ message: 'Executor error', phase: 'executor' });
    errorLogger.appendError({ message: 'Reviewer error', phase: 'reviewer' });
    errorLogger.flushSync();

    const filtered = errorLogger.getErrors({ phase: 'executor' });
    expect(filtered.length).toBe(1);
    expect(filtered[0].message).toBe('Executor error');
  });

  it('filter by since works', () => {
    const baseTime = new Date('2025-01-01T00:00:00Z').toISOString();

    errorLogger.appendError({
      message: 'Old error',
      timestamp: baseTime,
      cardId: 'old',
    });
    errorLogger.appendError({
      message: 'New error',
      cardId: 'new',
    });
    errorLogger.flushSync();

    const since = new Date('2025-06-01T00:00:00Z').toISOString();
    const filtered = errorLogger.getErrors({ since });
    expect(filtered.length).toBe(1);
    expect(filtered[0].message).toBe('New error');
  });

  it('filter by limit works', () => {
    for (let i = 0; i < 10; i++) {
      errorLogger.appendError({ message: `Error ${i}` });
    }
    errorLogger.flushSync();

    const limited = errorLogger.getErrors({ limit: 3 });
    expect(limited.length).toBe(3);
    expect(limited[0].message).toBe('Error 7');
    expect(limited[1].message).toBe('Error 8');
    expect(limited[2].message).toBe('Error 9');
  });

  it('filter with limit=0 returns all records', () => {
    errorLogger.appendError({ message: 'Error A' });
    errorLogger.appendError({ message: 'Error B' });
    errorLogger.flushSync();

    const all = errorLogger.getErrors({ limit: 0 });
    expect(all.length).toBe(2);
  });

  it('multiple appendError calls persist all records', () => {
    for (let i = 0; i < 50; i++) {
      errorLogger.appendError({ message: `Error ${i}`, cardId: `card-${i % 5}` });
    }
    errorLogger.flushSync();

    const errors = errorLogger.getErrors();
    expect(errors.length).toBe(50);

    const messages = new Set(errors.map((e) => e.message));
    for (let i = 0; i < 50; i++) {
      expect(messages.has(`Error ${i}`)).toBe(true);
    }
  });

  it('empty file returns empty array', () => {
    const errors = errorLogger.getErrors();
    expect(errors).toEqual([]);
  });

  it('close() stops the flush timer and flushes buffered records', () => {
    errorLogger.appendError({ message: 'Test' });
    errorLogger.close();

    const errors = errorLogger.getErrors();
    expect(errors.length).toBe(1);
    expect(errors[0].message).toBe('Test');
  });

  it('auto-generated timestamp is valid ISO string', () => {
    const record = errorLogger.appendError({ message: 'Test timestamp' });
    const parsed = Date.parse(record.timestamp);
    expect(isNaN(parsed)).toBe(false);

    const tsMs = new Date(record.timestamp).getTime();
    const nowMs = Date.now();
    expect(nowMs - tsMs).toBeLessThan(5000);
  });

  it('preserves extra fields on the error record', () => {
    errorLogger.appendError({
      message: 'Custom error',
      cardId: 'c1',
      customField: 'extra-value',
      nested: { foo: 'bar' },
    });
    errorLogger.flushSync();

    const errors = errorLogger.getErrors();
    expect(errors[0].customField).toBe('extra-value');
    expect(errors[0].nested).toEqual({ foo: 'bar' });
  });

  it('generates unique error IDs', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const record = errorLogger.appendError({ message: `Error ${i}` });
      ids.add(record.id);
    }
    expect(ids.size).toBe(100);
  });

  it('skips malformed lines in the file', () => {
    errorLogger.appendError({ message: 'Valid error' });
    errorLogger.flushSync();

    const logPath = errorLogger.getErrorsPath();
    const existing = readFileSync(logPath, 'utf-8');
    writeFileSync(logPath, existing + 'NOT VALID JSON\n');

    const errors = errorLogger.getErrors();
    expect(errors.length).toBe(1);
    expect(errors[0].message).toBe('Valid error');
  });

  it('filter combinations AND together', () => {
    errorLogger.appendError({ message: 'A', cardId: 'c1', goalId: 'g1', phase: 'planner' });
    errorLogger.appendError({ message: 'B', cardId: 'c1', goalId: 'g1', phase: 'executor' });
    errorLogger.appendError({ message: 'C', cardId: 'c2', goalId: 'g1', phase: 'planner' });
    errorLogger.appendError({ message: 'D', cardId: 'c1', goalId: 'g2', phase: 'planner' });
    errorLogger.flushSync();

    const filtered = errorLogger.getErrors({
      cardId: 'c1',
      goalId: 'g1',
    });
    expect(filtered.length).toBe(2);
    expect(filtered.map((e) => e.message).sort()).toEqual(['A', 'B']);
  });

  it('filter with limit and other criteria', () => {
    for (let i = 0; i < 5; i++) {
      errorLogger.appendError({ message: `E${i}`, cardId: 'cX' });
    }
    for (let i = 0; i < 5; i++) {
      errorLogger.appendError({ message: `E${i + 5}`, cardId: 'cY' });
    }
    errorLogger.flushSync();

    const filtered = errorLogger.getErrors({ cardId: 'cX', limit: 3 });
    expect(filtered.length).toBe(3);
    expect(filtered.map((e) => e.message)).toEqual(['E2', 'E3', 'E4']);
  });

  it('flushSync writes buffered records to disk immediately', () => {
    errorLogger.appendError({ message: 'Buffered' });
    errorLogger.flushSync();

    const logPath = errorLogger.getErrorsPath();
    const content = readFileSync(logPath, 'utf-8');
    expect(content).toContain('Buffered');
  });
});

describe('Runtime Integration — Error Propagation', () => {
  let tmpDir: string;
  let fixtureDir: string;
  let dispatchTools: RuntimeCoreTestContainer['dispatchTestTools'];
  let runtimeApi: RuntimeCoreTestContainer['api'];
  let loggerTools: RuntimeCoreTestContainer['loggerTestTools'];
  let harness: RuntimeCoreTestContainer;

  function makeRuntime(input: {
    mapping?: Record<string, string>;
    errorLogger?: ErrorLogger;
    agentRuntime?: AgentExecutionPort;
  } = {}): void {
    harness = createRuntimeCoreTestContainer({
      config: {
        projectRoot: tmpDir,
        fakeAgentConfig: {
          mapping: input.mapping ?? { '*': 'default' },
          fixtureDir,
        },
        ...(input.errorLogger ? { errorLogger: input.errorLogger } : {}),
      },
      ...(input.agentRuntime ? { agentRuntime: input.agentRuntime } : {}),
    });
    dispatchTools = harness.dispatchTestTools;
    runtimeApi = harness.api;
    loggerTools = harness.loggerTestTools;
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-rt-el-'));
    fixtureDir = makeFixtureDir(tmpDir);
    initProjectTree(tmpDir);
  });

  afterEach(() => {
    try {
      releaseLock(tmpDir);
    } catch {
      // ignore
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('errorLogger is exposed through the runtime harness', () => {
    makeRuntime();

    expect(loggerTools.getErrorsPath()).toBe(join(tmpDir, '.saivage', 'runtime', 'errors.jsonl'));
    loggerTools.closeErrorLogger();
  });

  it('logger test tools appendError() writes to errors.jsonl', () => {
    makeRuntime();

    loggerTools.appendError({
      message: 'Test from runtime',
      cardId: 'card-rt-1',
      goalId: 'goal-rt-1',
      phase: 'executor',
    });
    loggerTools.flushErrors();

    const errors = loggerTools.getErrors();
    expect(errors.length).toBe(1);
    expect(errors[0].message).toBe('Test from runtime');
    expect(errors[0].cardId).toBe('card-rt-1');
    expect(errors[0].goalId).toBe('goal-rt-1');
    expect(errors[0].phase).toBe('executor');

    loggerTools.closeErrorLogger();
  });

  it('logger test tools getErrors() returns persisted records', () => {
    makeRuntime();

    loggerTools.appendError({ message: 'E1', cardId: 'c1' });
    loggerTools.appendError({ message: 'E2', cardId: 'c2' });
    loggerTools.flushErrors();

    const errors = loggerTools.getErrors();
    expect(errors.length).toBe(2);
    expect(errors[0].message).toBe('E1');
    expect(errors[1].message).toBe('E2');

    loggerTools.closeErrorLogger();
  });

  it('errorLogger.getErrorsPath() points to .saivage/runtime/errors.jsonl', () => {
    makeRuntime();

    const path = loggerTools.getErrorsPath();
    expect(path).toBe(join(tmpDir, '.saivage', 'runtime', 'errors.jsonl'));

    loggerTools.closeErrorLogger();
  });

  it('after successful dispatchGoal, errorLogger is accessible', async () => {
    const store = new CardStore(tmpDir);
    const goal = makeGoalCard(store, 'Happy Goal');
    const code = makeTerminalCard(store, goal.id, 'Happy work');

    const fixture: FakeAgentFixture = {
      name: 'happy-err-test',
      planner: [
        {
          status: 'continue',
          summary: 'Planner continued after direct card setup.',
        },
        {
          status: 'done',
        },
        {
          status: 'done',
        },
        {
          status: 'done',
        },
      ],
      executor: {
        [code.id]: { card_id: code.id, status: 'done', status_text: 'Completed successfully', result: { evidence: 'happy card completed' } },
      },
      reviewer: makePassReviewer(goal.id, 'unused-plan-id', [code.id]),
    };
    writeFixture(fixtureDir, 'happy-err-test', fixture);

    makeRuntime({
      mapping: { [goal.id]: 'happy-err-test', project: 'happy-err-test' },
      agentRuntime: new ActivatingFakeAgentAdapter(
        tmpDir,
        { mapping: { [goal.id]: 'happy-err-test', project: 'happy-err-test' }, fixtureDir },
        { [goal.id]: [code.id] },
      ),
    });

    await runtimeApi.start();
    seedPlannerRun(tmpDir, goal.id);
    await dispatchTools.dispatchGoal(goal.id);
    await waitForBackgroundDispatchesToDrain(harness);

    expect(store.read(goal.id)).not.toBeNull();

    const errors = loggerTools.getErrors();
    expect(Array.isArray(errors)).toBe(true);

    await runtimeApi.shutdown();
  });

  it('executor throw during dispatchGoal logs to errors.jsonl and events.jsonl', async () => {
    const store = new CardStore(tmpDir);
    const goal = makeGoalCard(store, 'Throw Goal');
    const code = makeTerminalCard(store, goal.id, 'Throwing work');

    const fixture: FakeAgentFixture = {
      name: 'throw-err',
      planner: [
        {
          status: 'continue',
          summary: 'Planner continued after direct card setup.',
        },
        {
          status: 'done',
        },
        {
          status: 'done',
        },
        {
          status: 'blocked',
          blocked_reason: 'Stop after executor-error logging assertion path.',
        },
      ],
      executor: {},
      reviewer: makePassReviewer(goal.id, 'unused-plan-id', []),
    };
    writeFixture(fixtureDir, 'throw-err', fixture);

    makeRuntime({
      mapping: { [goal.id]: 'throw-err', project: 'throw-err' },
      agentRuntime: new ActivatingFakeAgentAdapter(
        tmpDir,
        { mapping: { [goal.id]: 'throw-err', project: 'throw-err' }, fixtureDir },
        { [goal.id]: [code.id] },
      ),
    });

    const diagnosticEvents: unknown[] = [];
    runtimeApi.subscribe({ allowedKinds: ['runtime_diagnostic'], handler: (event) => { diagnosticEvents.push(event); } });

    await runtimeApi.start();
    seedPlannerRun(tmpDir, goal.id);
    await dispatchTools.dispatchGoal(goal.id);
    await waitForBackgroundDispatchesToDrain(harness);

    expect(diagnosticEvents.length).toBeGreaterThanOrEqual(1);

    const errors = loggerTools.getErrors();
    expect(errors.length).toBeGreaterThanOrEqual(1);

    const execErrors = errors.filter((e) => e.phase === 'executor');
    expect(execErrors.length).toBeGreaterThanOrEqual(1);
    expect(execErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cardId: code.id,
          goalId: goal.id,
          message: expect.stringContaining(`has no executor result for card '${code.id}'`),
          phase: 'executor',
        }),
      ]),
    );

    await runtimeApi.shutdown();
  });

  it('injected errorLogger is used instead of creating a new one', () => {
    const injected = new ErrorLogger(join(tmpDir, '.saivage'));

    makeRuntime({ errorLogger: injected });

    expect(loggerTools.isSameErrorLogger(injected)).toBe(true);

    injected.appendError({ message: 'Before shutdown' });
    injected.flushSync();
    const errors = loggerTools.getErrors();
    expect(errors.length).toBe(1);

    loggerTools.closeErrorLogger();
  });
});

describe('ErrorLogger — JSONL Format Compatibility', () => {
  let tmpDir: string;
  let saivageDir: string;
  let errorLogger: ErrorLogger;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-el-fmt-'));
    saivageDir = join(tmpDir, '.saivage');
    mkdirSync(join(saivageDir, 'runtime'), { recursive: true });
    errorLogger = new ErrorLogger(saivageDir);
  });

  afterEach(() => {
    errorLogger.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('every line in errors.jsonl is valid JSON with kind=error, timestamp, message', () => {
    errorLogger.appendError({
      message: 'First test error',
      cardId: 'card-fmt-1',
      goalId: 'goal-fmt-1',
      phase: 'planner',
    });
    errorLogger.appendError({
      message: 'Second test error',
      cardId: 'card-fmt-2',
      phase: 'executor',
    });
    errorLogger.appendError({
      message: 'Minimal error',
    });
    errorLogger.flushSync();

    const logPath = errorLogger.getErrorsPath();
    const content = readFileSync(logPath, 'utf-8');
    const lines = content.trim().split('\n');

    expect(lines.length).toBe(3);

    for (const line of lines) {
      let parsed: ErrorRecord;
      expect(() => {
        parsed = JSON.parse(line) as ErrorRecord;
      }).not.toThrow();

      parsed = JSON.parse(line) as ErrorRecord;
      expect(parsed.kind).toBe('error');
      expect(parsed.timestamp).toBeTruthy();
      expect(typeof parsed.timestamp).toBe('string');
      const tsMs = Date.parse(parsed.timestamp);
      expect(isNaN(tsMs)).toBe(false);
      expect(parsed.message).toBeTruthy();
      expect(typeof parsed.message).toBe('string');
      expect(parsed.id).toBeTruthy();
      expect(typeof parsed.id).toBe('string');
    }
  });

  it('file format matches what GET /api/debug/errors expects', () => {
    errorLogger.appendError({
      message: 'API test error',
      cardId: 'api-card',
      goalId: 'api-goal',
      phase: 'reviewer',
    });
    errorLogger.flushSync();

    const errorsPath = join(saivageDir, 'runtime', 'errors.jsonl');
    const raw = readFileSync(errorsPath, 'utf-8');
    const errors: unknown[] = [];

    for (const line of raw.split('\n').filter(Boolean)) {
      errors.push(JSON.parse(line));
    }

    expect(errors.length).toBe(1);
    const record = errors[0] as ErrorRecord;
    expect(record.kind).toBe('error');
    expect(record.message).toBe('API test error');
    expect(record.cardId).toBe('api-card');
    expect(record.goalId).toBe('api-goal');
    expect(record.phase).toBe('reviewer');
  });

  it('getErrors handles file-not-found gracefully (endpoint-compatible)', () => {
    const errors = errorLogger.getErrors();
    expect(errors).toEqual([]);
  });

  it('no trailing characters after records, each line is self-contained', () => {
    errorLogger.appendError({ message: 'Line 1' });
    errorLogger.appendError({ message: 'Line 2' });
    errorLogger.flushSync();

    const content = readFileSync(errorLogger.getErrorsPath(), 'utf-8');
    const lines = content.split('\n');
    const nonEmptyLines = lines.filter((l) => l.trim() !== '');
    expect(nonEmptyLines.length).toBe(2);

    for (const line of nonEmptyLines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

describe('ErrorLogger + EventLogger consistency', () => {
  let tmpDir: string;
  let saivageDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-el-ev-'));
    saivageDir = join(tmpDir, '.saivage');
    initProjectTree(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('Runtime with both loggers writes to both files when executor throws', async () => {
    const fixtureDir = makeFixtureDir(tmpDir);

    const store = new CardStore(tmpDir);
    const goal = makeGoalCard(store, 'Dual Log Goal');
    const code = makeTerminalCard(store, goal.id, 'Dual log missing executor work');

    const fixture: FakeAgentFixture = {
      name: 'dual-log',
      planner: [
        {
          status: 'continue',
          summary: 'Planner continued after direct card setup.',
        },
        {
          status: 'done',
        },
        {
          status: 'done',
        },
        {
          status: 'blocked',
          blocked_reason: 'Stop after dual logger executor-error assertion path.',
        },
      ],
      executor: {},
      reviewer: makePassReviewer(goal.id, 'unused-plan-id', []),
    };
    writeFixture(fixtureDir, 'dual-log', fixture);

    const harness = createRuntimeCoreTestContainer({
      config: {
        projectRoot: tmpDir,
        fakeAgentConfig: {
          mapping: { [goal.id]: 'dual-log', project: 'dual-log' },
          fixtureDir,
        },
      },
      agentRuntime: new ActivatingFakeAgentAdapter(
        tmpDir,
        { mapping: { [goal.id]: 'dual-log', project: 'dual-log' }, fixtureDir },
        { [goal.id]: [code.id] },
      ),
    });
    const diagnosticEvents: unknown[] = [];
    harness.api.subscribe({ allowedKinds: ['runtime_diagnostic'], handler: (event) => { diagnosticEvents.push(event); } });

    await harness.api.start();
    seedPlannerRun(tmpDir, goal.id);
    await harness.dispatchTestTools.dispatchGoal(goal.id);
    await waitForBackgroundDispatchesToDrain(harness);

    expect(diagnosticEvents.length).toBeGreaterThanOrEqual(1);

    const errors = harness.loggerTestTools.getErrors();
    expect(errors.length).toBeGreaterThanOrEqual(1);

    const executorErrors = errors.filter(
      (e: ErrorRecord) => e.phase === 'executor',
    );
    expect(executorErrors.length).toBeGreaterThanOrEqual(1);
    expect(executorErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cardId: code.id,
          goalId: goal.id,
          message: expect.stringContaining(`has no executor result for card '${code.id}'`),
          phase: 'executor',
        }),
      ]),
    );

    harness.loggerTestTools.flushEvents();

    const eventsPath = join(saivageDir, 'runtime', 'events.jsonl');
    expect(existsSync(eventsPath)).toBe(true);

    const eventsRaw = readFileSync(eventsPath, 'utf-8');
    const eventLines = eventsRaw.trim().split('\n').filter(Boolean);
    const loggedDiagnosticEvents = eventLines
      .map((l) => JSON.parse(l))
      .filter((e: { kind?: string }) => e.kind === 'runtime_diagnostic');
    expect(loggedDiagnosticEvents.length).toBeGreaterThanOrEqual(1);
    expect(loggedDiagnosticEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          card_id: code.id,
          error_message: expect.stringContaining(`has no executor result for card '${code.id}'`),
          goal_id: goal.id,
          phase: 'executor',
        }),
      ]),
    );

    await harness.api.shutdown();
  });
});
