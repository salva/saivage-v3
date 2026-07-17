import { describe, expect, it, jest } from '@jest/globals';

import { CardServiceInvariantError, type CardActivationAdmissionProjection } from '../../src/cards/card-api.js';
import type { CardActivationOutcome } from '../../src/runtime/actors/card-actor.js';
import type { CardRecord, CardStatus } from '../../src/schemas/index.js';
import { buildInvocationSurface, invokeTool } from '../../src/tools/invocation.js';
import { createPlannerControlProvider, type PlannerControlProviderContext } from '../../src/tools/planner-control-provider.js';
import { testAppLogs } from '../helpers/app-logs.js';

const PARENT = '11111111-1111-4111-8111-111111111111';
const CHILD = '22222222-2222-4222-8222-222222222222';
const DEPENDENCY_A = '33333333-3333-4333-8333-333333333333';
const DEPENDENCY_B = '44444444-4444-4444-8444-444444444444';

const doneOutcome: CardActivationOutcome = { status: 'done', summary: 'complete', result: { kind: 'done', summary: 'complete' } };

function card(status: CardStatus = 'backlog', changes: Partial<CardRecord> = {}): CardRecord {
  return {
    id: CHILD,
    type: 'code',
    parent: PARENT,
    depth: 2,
    position: 0,
    title: 'Child',
    status,
    tags: [],
    priority: 0,
    urgency: 'normal',
    created_by: 'planner',
    created_at: '2026-07-17T00:00:00.000Z',
    updated_at: '2026-07-17T00:00:00.000Z',
    version_seq: 1,
    depends_on: [],
    related: [],
    lifecycle: { status, result: null, error: null, completed_at: null },
    pending_notifications: [],
    ...changes,
  } as CardRecord;
}

function projection(child: CardRecord, dependencies: CardActivationAdmissionProjection['dependencies'] = []): CardActivationAdmissionProjection {
  return { child, dependencies };
}

type Actor = NonNullable<ReturnType<PlannerControlProviderContext['children']['get']>>;

function harness(admission: CardActivationAdmissionProjection | null, actorOverrides: Partial<Actor> = {}) {
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
  const store: PlannerControlProviderContext['store'] = {
    read: jest.fn((_cardId: string) => admission?.child ?? null),
    readActivationAdmission,
    setStatus,
  };
  const provider = createPlannerControlProvider({
    projectRoot: '/test/planner-control',
    parentCardId: PARENT,
    sessionId: `planner:${PARENT}`,
    store,
    children: { get },
    cancelCard: async () => { throw new Error('unused'); },
    appLogs: testAppLogs('/test/planner-control'),
  });
  return {
    actor,
    events,
    get,
    readActivationAdmission,
    setStatus,
    invoke: () => invokeTool(buildInvocationSurface('planner', [provider]), 'activate_card', { card_id: CHILD }),
  };
}

describe('planner activate_card dependency-completion admission', () => {
  it('preserves missing-target and immediate-child failures before actor lookup', async () => {
    const missing = harness(null);
    await expect(missing.invoke()).resolves.toEqual({ success: false, error: `Child card '${CHILD}' not found.` });
    expect(missing.get).not.toHaveBeenCalled();

    const foreign = harness(projection(card('backlog', { parent: DEPENDENCY_A })));
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

  it.each(['done', 'failed', 'cancelled'] as const)('preserves existing %s target activation errors after all-done admission', async (status) => {
    const activate = jest.fn<Actor['activate']>(async () => { throw new Error(`Card '${CHILD}' in status '${status}' is not activatable.`); });
    const test = harness(projection(card(status), [{ id: DEPENDENCY_A, status: 'done' }]), { activate });
    await expect(test.invoke()).resolves.toEqual({ success: false, error: `Card '${CHILD}' in status '${status}' is not activatable.` });
    expect(test.get).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it('propagates projection invariants outside actor-operation failure conversion', async () => {
    const test = harness(projection(card()));
    test.readActivationAdmission.mockImplementation(() => { throw new CardServiceInvariantError('invalid canonical dependency graph'); });
    await expect(test.invoke()).rejects.toThrow(CardServiceInvariantError);
    expect(test.get).not.toHaveBeenCalled();
  });
});
