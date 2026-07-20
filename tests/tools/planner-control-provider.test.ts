import { describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardServiceInvariantError, type CardActivationAdmissionProjection } from '../../src/cards/card-api.js';
import type { CardActivationOutcome } from '../../src/contracts/tool-api.js';
import type { CardRecord, CardStatus } from '../../src/schemas/index.js';
import { buildInvocationSurface, invokeTool, invokeToolForLlm } from '../../src/tools/invocation.js';
import { createPlannerControlProvider, type PlannerControlProviderContext } from '../../src/tools/planner-control-provider.js';
import { testAppLogs } from '../helpers/app-logs.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { listControlActions } from '../../src/persistence/control-action-audit.js';
import type { LlmToolInvocationContext } from '../../src/runtime/actors/executing-llm-snapshot.js';
import { RuntimeStoppedInterruption } from '../../src/runtime/actors/runtime-stopped-interruption.js';

const PARENT = 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CHILD = `${PARENT}-b`;
const DEPENDENCY_A = 'card-cccccccccccccccccccccccccccc';
const DEPENDENCY_B = 'card-dddddddddddddddddddddddddddd';

const doneOutcome: CardActivationOutcome = { status: 'done', summary: 'complete', result: { kind: 'done', summary: 'complete' } };

function card(status: CardStatus = 'backlog', id = CHILD, changes: Partial<Pick<CardRecord, 'title' | 'tags' | 'priority' | 'urgency' | 'related'>> = {}): CardRecord {
  const common = {
    id,
    type: 'code' as const,
    children: [],
    title: 'Child',
    tags: [],
    priority: 0,
    urgency: 'normal' as const,
    created_by: 'planner' as const,
    created_at: '2026-07-17T00:00:00.000Z',
    updated_at: '2026-07-17T00:00:00.000Z',
    version_seq: 1,
    depends_on: [],
    related: [],
    pending_notifications: [],
    ...changes,
  };
  if (status === 'done') return { ...common, lifecycle: { status, result: { kind: 'done', summary: 'done' }, error: null, completed_at: '2026-07-17T00:00:00.000Z' } };
  if (status === 'failed') return { ...common, lifecycle: { status, result: { kind: 'failed', summary: 'failed' }, error: 'failed', completed_at: '2026-07-17T00:00:00.000Z' } };
  if (status === 'blocked') return { ...common, lifecycle: { status, result: { kind: 'blocked', summary: 'blocked' }, error: 'blocked', completed_at: null } };
  return { ...common, lifecycle: { status, result: null, error: null, completed_at: null } };
}

function projection(child: CardRecord, dependencies: CardActivationAdmissionProjection['dependencies'] = []): CardActivationAdmissionProjection {
  return { child, dependencies };
}

type Actor = NonNullable<ReturnType<PlannerControlProviderContext['children']['get']>>;

function harness(admission: CardActivationAdmissionProjection | null, actorOverrides: Partial<Actor> = {}, options: { projectRoot?: string; reorderResult?: ReturnType<NonNullable<PlannerControlProviderContext['store']['reorderChildren']>> } = {}) {
  const events: string[] = [];
  const actor: Actor = {
    activate: jest.fn<Actor['activate']>(async (_caller, parentAdmit) => {
      events.push('activate');
      parentAdmit();
      events.push('live-owner-claimed', 'current-leaf-entered', 'processor-activated', 'provider-work', 'tool-work', 'process-work');
      return doneOutcome;
    }),
    awaitSettlement: jest.fn<Actor['awaitSettlement']>(async () => {
      events.push('await-settlement', 'parent-enter-child', 'parent-resume-arranged');
      return doneOutcome;
    }),
    ...actorOverrides,
  };
  const get = jest.fn((_cardId: string): Actor => {
    events.push('card-actor-constructed', 'card-actor-registered', 'processor-constructed', 'processor-actor-started-idle');
    return actor;
  });
  const readActivationAdmission = jest.fn((_cardId: string) => admission);
  const setStatus = jest.fn((_cardId: string, _status: 'changed' | 'running') => {
    events.push('status-running');
    return card('running');
  });
  const activateStopped = jest.fn((_cardId: string) => { events.push('status-running'); return card('running'); });
  const mutateCard = jest.fn<NonNullable<PlannerControlProviderContext['store']['mutateCard']>>((_cardId, changes) => card(admission?.child.lifecycle.status ?? 'backlog', CHILD, changes));
  const reorderChildren = jest.fn<NonNullable<PlannerControlProviderContext['store']['reorderChildren']>>(() => options.reorderResult ?? { ok: true, changed: 2 });
  const beginStructuralWait = jest.fn<PlannerControlProviderContext['beginStructuralWait']>((relationship) => { events.push('relationship-installed'); return relationship; });
  const endStructuralWait = jest.fn<PlannerControlProviderContext['endStructuralWait']>(() => { events.push('relationship-cleared'); });
  const store: PlannerControlProviderContext['store'] = {
    read: jest.fn((_cardId: string) => admission?.child ?? null),
    readActivationAdmission,
    mutateCard,
    reorderChildren,
    setStatus,
    activateStopped,
  };
  const provider = createPlannerControlProvider({
    projectRoot: options.projectRoot ?? '/test/planner-control',
    parentCardId: PARENT,
    sessionId: `planner:${PARENT}`,
    store,
    children: { get },
    cancelCard: async () => { throw new Error('unused'); },
    notifyCard: () => ({ ok: true, notificationId: 'unused' }),
    appLogs: testAppLogs(options.projectRoot ?? '/test/planner-control'),
    beginStructuralWait,
    endStructuralWait,
  });
  const surface = buildInvocationSurface('planner', [provider]);
  return {
    actor,
    events,
    get,
    readActivationAdmission,
    setStatus,
    activateStopped,
    mutateCard,
    reorderChildren,
    beginStructuralWait,
    endStructuralWait,
    surface,
    invoke: () => invokeTool(surface, 'activate_card', { card_id: CHILD }),
  };
}

describe('planner activate_card dependency-completion admission', () => {
  it('installs one exact ordinary structural relationship only around child settlement', async () => {
    const test = harness(projection(card()));
    const context: LlmToolInvocationContext = { sessionId: `planner:${PARENT}`, sourceInputId: '11111111-1111-4111-8111-111111111111', toolCallId: 'call-1', toolName: 'activate_card', waits: { waitExternal: <T>(promise: Promise<T>) => promise, waitProcess: <T>(_id: string, promise: Promise<T>) => promise, waitChild: async <T>(relationship: unknown, promise: Promise<T>) => { test.events.push('barrier-installed'); expect(relationship).toMatchObject({ childCardId: CHILD, toolCallId: 'call-1' }); return promise; } } };
    await expect(invokeTool(test.surface, 'activate_card', { card_id: CHILD }, new AbortController().signal, context)).resolves.toEqual({ success: true, data: { card_id: CHILD, outcome: 'done', summary: 'complete', result: { kind: 'done', summary: 'complete' } } });
    expect(test.events).toEqual(expect.arrayContaining(['relationship-installed', 'barrier-installed', 'relationship-cleared']));
    expect(test.events.indexOf('relationship-installed')).toBeLessThan(test.events.indexOf('barrier-installed'));
    expect(test.events.indexOf('barrier-installed')).toBeLessThan(test.events.indexOf('relationship-cleared'));
  });
  it('reuses a stopped child through the narrow stopped activation admission', async () => {
    const test = harness(projection(card('stopped')));
    await expect(test.invoke()).resolves.toMatchObject({ success: true, data: { card_id: CHILD, outcome: 'done' } });
    expect(test.activateStopped).toHaveBeenCalledWith(CHILD);
    expect(test.setStatus).not.toHaveBeenCalled();
    expect(test.actor.activate).toHaveBeenCalledTimes(1);
  });
  it('clears the exact ordinary structural relationship when child settlement rejects', async () => {
    const test = harness(projection(card()), { activate: jest.fn<Actor['activate']>(async () => { throw new Error('child rejected'); }) });
    let waitChildCalls = 0;
    const waitChild = async <T>(_relationship: unknown, promise: Promise<T>): Promise<T> => { waitChildCalls += 1; return promise; };
    const context: LlmToolInvocationContext = { sessionId: `planner:${PARENT}`, sourceInputId: '11111111-1111-4111-8111-111111111111', toolCallId: 'call-reject', toolName: 'activate_card', waits: { waitExternal: <T>(promise: Promise<T>) => promise, waitProcess: <T>(_id: string, promise: Promise<T>) => promise, waitChild } };
    await expect(invokeTool(test.surface, 'activate_card', { card_id: CHILD }, new AbortController().signal, context)).resolves.toMatchObject({ success: false, error: 'child rejected' });
    expect(waitChildCalls).toBe(1);
    expect(test.events).toEqual(expect.arrayContaining(['relationship-installed', 'relationship-cleared']));
    expect(test.events.indexOf('relationship-installed')).toBeLessThan(test.events.indexOf('relationship-cleared'));
  });

  it('keeps validation and admission rejection active without installing either child authority', async () => {
    const test = harness(null);
    let waitChildCalls = 0;
    const waitChild = async <T>(_relationship: unknown, promise: Promise<T>): Promise<T> => { waitChildCalls += 1; return promise; };
    const context: LlmToolInvocationContext = { sessionId: `planner:${PARENT}`, sourceInputId: '11111111-1111-4111-8111-111111111111', toolCallId: 'call-invalid', toolName: 'activate_card', waits: { waitExternal: <T>(promise: Promise<T>) => promise, waitProcess: <T>(_id: string, promise: Promise<T>) => promise, waitChild } };
    await expect(invokeTool(test.surface, 'activate_card', { card_id: CHILD }, new AbortController().signal, context)).resolves.toMatchObject({ success: false });
    expect(waitChildCalls).toBe(0);
    expect(test.beginStructuralWait).not.toHaveBeenCalled();
  });
  it('clears ordinary child authority for cancellation settlement and Stop rejection', async () => {
    const context: LlmToolInvocationContext = { sessionId: `planner:${PARENT}`, sourceInputId: '11111111-1111-4111-8111-111111111111', toolCallId: 'call-end', toolName: 'activate_card', waits: { waitExternal: <T>(promise: Promise<T>) => promise, waitProcess: <T>(_id: string, promise: Promise<T>) => promise, waitChild: <T>(_relationship: unknown, promise: Promise<T>) => promise } };
    const cancelled = harness(projection(card()), { activate: jest.fn<Actor['activate']>(async () => ({ status: 'cancelled', summary: 'cancelled' })) });
    await expect(invokeTool(cancelled.surface, 'activate_card', { card_id: CHILD }, new AbortController().signal, context)).resolves.toEqual({ success: false, error: `Child card '${CHILD}' activation was cancelled.` });
    expect(cancelled.events).toEqual(expect.arrayContaining(['relationship-installed', 'relationship-cleared']));

    const controller = new AbortController();
    const interruption = new RuntimeStoppedInterruption();
    const stopped = harness(projection(card()), { activate: jest.fn<Actor['activate']>(async () => { controller.abort(interruption); throw interruption; }) });
    await expect(invokeToolForLlm(stopped.surface, 'activate_card', { card_id: CHILD }, controller.signal, context)).rejects.toBe(interruption);
    expect(stopped.events).toEqual(expect.arrayContaining(['relationship-installed', 'relationship-cleared']));
  });
  it('rejects type as an extra edit_card field before mutating the card', async () => {
    const test = harness(projection(card()));

    await expect(invokeTool(test.surface, 'edit_card', { card_id: CHILD, title: 'Retitle', type: 'test' }))
      .resolves.toMatchObject({ success: false, error: expect.stringContaining('Unrecognized key') });
    expect(test.mutateCard).not.toHaveBeenCalled();
    expect(test.setStatus).not.toHaveBeenCalled();
  });

  it('edits an immediate stopped child without reopening it as changed', async () => {
    const test = harness(projection(card('stopped')));

    await expect(invokeTool(test.surface, 'edit_card', { card_id: CHILD, title: 'Retitle stopped work' }))
      .resolves.toMatchObject({ success: true, data: { card: { status: 'stopped', title: 'Retitle stopped work' } } });
    expect(test.setStatus).not.toHaveBeenCalled();
    expect(test.mutateCard).toHaveBeenCalledWith(CHILD, { title: 'Retitle stopped work' }, { actor: 'planner', surface: 'runtime', reason: 'planner edit_card' });
  });

  it.each(['blocked', 'failed'] as const)('reopens an immediate %s child before editing', async (status) => {
    const test = harness(projection(card(status)));

    await expect(invokeTool(test.surface, 'edit_card', { card_id: CHILD, title: 'Retitle reopened work' }))
      .resolves.toMatchObject({ success: true });
    expect(test.setStatus).toHaveBeenCalledWith(CHILD, 'changed');
    expect(test.mutateCard).toHaveBeenCalledWith(CHILD, { title: 'Retitle reopened work' }, { actor: 'planner', surface: 'runtime', reason: 'planner edit_card' });
  });

  it.each([
    { name: 'real reorder', result: { ok: true as const, changed: 2 }, success: true, outcome: 'ok' },
    { name: 'no-op reorder', result: { ok: true as const, changed: 0 }, success: true, outcome: 'ok' },
    { name: 'mismatch', result: { ok: false as const, reason: 'ordered child ids do not match current children', missing: [CHILD], extra: [DEPENDENCY_A] }, success: false, outcome: 'error' },
  ])('preserves running-parent planner reorder result and audit shapes for $name', async ({ result, success, outcome }) => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-planner-reorder-'));
    try {
      initProjectTree(root);
      const test = harness(projection(card()), {}, { projectRoot: root, reorderResult: result });
      const toolResult = await invokeTool(test.surface, 'reorder_child', { orderedChildIds: [CHILD, DEPENDENCY_A] });
      expect(toolResult.success).toBe(success);
      if (result.ok) expect(toolResult).toEqual({ success: true, data: { parent_id: PARENT, changed: result.changed } });
      else expect(toolResult).toEqual({ success: false, error: `reorder_child set mismatch: missing=${CHILD} extra=${DEPENDENCY_A}` });
      expect(test.reorderChildren).toHaveBeenCalledWith(PARENT, [CHILD, DEPENDENCY_A], { actor: 'planner', surface: 'runtime', reason: 'planner reorder_child' });
      expect(listControlActions(root).at(0)).toMatchObject({ action: 'card.reorder_child', target_id: PARENT, outcome, outcome_summary: result.ok ? 'mutation applied' : 'reorder_set_mismatch' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves missing-target and immediate-child failures before actor lookup', async () => {
    const missing = harness(null);
    await expect(missing.invoke()).resolves.toEqual({ success: false, error: `Child card '${CHILD}' not found.` });
    expect(missing.get).not.toHaveBeenCalled();

    const foreign = harness(projection(card('backlog', `${DEPENDENCY_A}-a`)));
    await expect(foreign.invoke()).resolves.toEqual({ success: false, error: `Planner can activate only immediate children of '${PARENT}'.` });
    expect(foreign.get).not.toHaveBeenCalled();
  });

  it('rejects a new activation before child construction, idle start, mutation, ownership, currentness, and work', async () => {
    const test = harness(projection(card(), [{ id: DEPENDENCY_A, status: 'backlog' }]));

    await expect(test.invoke()).resolves.toEqual({
      success: false,
      error: `Child card '${CHILD}' has incomplete dependencies: ${DEPENDENCY_A} (backlog).`,
    });

    expect(test.readActivationAdmission).toHaveBeenCalledTimes(1);
    expect(test.get).not.toHaveBeenCalled();
    expect(test.setStatus).not.toHaveBeenCalled();
    expect(test.actor.activate).not.toHaveBeenCalled();
    expect(test.actor.awaitSettlement).not.toHaveBeenCalled();
    expect(test.events).toEqual([]);
  });

  it('rejects a running join without changing held pre-existing sentinels and lets that activation settle independently', async () => {
    const held = {
      owner: 'existing-owner' as string | null,
      currentLeaf: CHILD as string | null,
      parentWaits: 1,
      processorActivations: 1,
      providerWork: 1,
      toolWork: 1,
      processWork: 1,
      settled: false,
    };
    let release!: () => void;
    const existingSettlement = new Promise<void>((resolve) => {
      release = () => {
        held.owner = null;
        held.currentLeaf = null;
        held.parentWaits = 0;
        held.settled = true;
        resolve();
      };
    });
    const baseline = { ...held };
    const test = harness(projection(card('running'), [{ id: DEPENDENCY_A, status: 'blocked' }]));

    await expect(test.invoke()).resolves.toMatchObject({ success: false });
    expect(test.get).not.toHaveBeenCalled();
    expect(test.actor.awaitSettlement).not.toHaveBeenCalled();
    expect(test.actor.activate).not.toHaveBeenCalled();
    expect(held).toEqual(baseline);

    release();
    await existingSettlement;
    expect(held).toEqual({ ...baseline, owner: null, currentLeaf: null, parentWaits: 0, settled: true });
  });

  it.each(['backlog', 'changed', 'running', 'blocked', 'failed', 'cancelled'] as const)(
    'rejects dependency status %s and admits only literal done',
    async (status) => {
      const rejected = harness(projection(card(), [{ id: DEPENDENCY_A, status }]));
      await expect(rejected.invoke()).resolves.toMatchObject({ success: false, error: expect.stringContaining(`${DEPENDENCY_A} (${status})`) });
      expect(rejected.get).not.toHaveBeenCalled();

      const admitted = harness(projection(card(), [{ id: DEPENDENCY_A, status: 'done' }]));
      await expect(admitted.invoke()).resolves.toMatchObject({ success: true });
      expect(admitted.get).toHaveBeenCalledTimes(1);
    },
  );

  it('reports every incomplete dependency in declared order from one projection', async () => {
    const test = harness(projection(card(), [
      { id: DEPENDENCY_B, status: 'failed' },
      { id: DEPENDENCY_A, status: 'done' },
      { id: CHILD, status: 'running' },
    ]));

    await expect(test.invoke()).resolves.toEqual({
      success: false,
      error: `Child card '${CHILD}' has incomplete dependencies: ${DEPENDENCY_B} (failed), ${CHILD} (running).`,
    });
    expect(test.readActivationAdmission).toHaveBeenCalledTimes(1);
    expect(test.get).not.toHaveBeenCalled();
  });

  it.each(['backlog', 'changed', 'blocked'] as const)(
    'preserves lookup idle-start then status/ownership/currentness/processor-work ordering for admitted %s activation',
    async (status) => {
      const test = harness(projection(card(status), [{ id: DEPENDENCY_A, status: 'done' }]));
      await expect(test.invoke()).resolves.toEqual({ success: true, data: { card_id: CHILD, outcome: 'done', summary: 'complete', result: doneOutcome.result } });
      expect(test.events).toEqual([
        'card-actor-constructed', 'card-actor-registered', 'processor-constructed', 'processor-actor-started-idle',
        'activate', 'status-running', 'live-owner-claimed', 'current-leaf-entered',
        'processor-activated', 'provider-work', 'tool-work', 'process-work',
      ]);
      expect(test.setStatus).toHaveBeenCalledWith(CHILD, 'running');
    },
  );

  it('admits a zero-dependency child', async () => {
    const test = harness(projection(card(), []));
    await expect(test.invoke()).resolves.toMatchObject({ success: true });
    expect(test.get).toHaveBeenCalledTimes(1);
  });

  it('preserves an admitted running join without reactivation or status mutation', async () => {
    const test = harness(projection(card('running'), [{ id: DEPENDENCY_A, status: 'done' }]));
    await expect(test.invoke()).resolves.toMatchObject({ success: true });
    expect(test.events).toEqual([
      'card-actor-constructed', 'card-actor-registered', 'processor-constructed', 'processor-actor-started-idle',
      'await-settlement', 'parent-enter-child', 'parent-resume-arranged',
    ]);
    expect(test.actor.awaitSettlement).toHaveBeenCalledWith({ kind: 'parent', cardId: PARENT, sessionId: `planner:${PARENT}` });
    expect(test.actor.activate).not.toHaveBeenCalled();
    expect(test.setStatus).not.toHaveBeenCalled();
  });

  it('rejects an incomplete terminal child before lookup', async () => {
    const test = harness(projection(card('done'), [{ id: DEPENDENCY_A, status: 'cancelled' }]));
    await expect(test.invoke()).resolves.toMatchObject({ success: false });
    expect(test.get).not.toHaveBeenCalled();
    expect(test.actor.activate).not.toHaveBeenCalled();
  });

  it.each(['done', 'failed', 'cancelled'] as const)('rejects terminal %s before actor lookup after all-done admission', async (status) => {
    const test = harness(projection(card(status), [{ id: DEPENDENCY_A, status: 'done' }]));
    await expect(test.invoke()).resolves.toEqual({ success: false, error: `Card '${CHILD}' in status '${status}' is not activatable.` });
    expect(test.get).not.toHaveBeenCalled();
    expect(test.actor.activate).not.toHaveBeenCalled();
    expect(test.actor.awaitSettlement).not.toHaveBeenCalled();
    expect(test.setStatus).not.toHaveBeenCalled();
    expect(test.activateStopped).not.toHaveBeenCalled();
    expect(test.beginStructuralWait).not.toHaveBeenCalled();
    expect(test.events).toEqual([]);
  });

  it('propagates projection invariants outside actor-operation failure conversion', async () => {
    const test = harness(projection(card()));
    test.readActivationAdmission.mockImplementation(() => { throw new CardServiceInvariantError('invalid canonical dependency graph'); });
    await expect(test.invoke()).rejects.toThrow(CardServiceInvariantError);
    expect(test.get).not.toHaveBeenCalled();
  });
});
