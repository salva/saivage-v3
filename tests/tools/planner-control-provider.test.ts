import { describe, expect, it, jest } from '@jest/globals';
import { CardService } from '../../src/cards/card-service.js';
import { buildInvocationSurface, invokeToolForLlm } from '../../src/tools/invocation.js';
import { createPlannerControlProvider } from '../../src/tools/planner-control-provider.js';
import { ChildInvocationLease } from '../../src/runtime/actors/child-invocation-wait.js';
import { RuntimeStoppedInterruption } from '../../src/runtime/actors/runtime-stopped-interruption.js';
import { testLlmToolInvocationContext } from '../helpers/llm-test-helpers.js';

const PARENT = 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CHILD = `${PARENT}-b`;

describe('planner control provider ownership delegation', () => {
  function harness() {
    const store = {
      read: jest.fn(), create: jest.fn(), mutateCard: jest.fn(), setStatus: jest.fn(), reorderChildren: jest.fn(),
    } as unknown as CardService;
    const activateChild = jest.fn(async ({ childCardId }: { childCardId: string; invocation: ChildInvocationLease }) => ({ status: 'done' as const, summary: childCardId, result: { kind: 'done' as const, summary: childCardId } }));
    const cancelChild = jest.fn(async ({ childCardId }: { childCardId: string; reason: string }) => ({ card_id: childCardId, status: 'cancelled' as const, cancelled_card_ids: [childCardId] }));
    const surface = buildInvocationSurface('planner', [createPlannerControlProvider({ projectRoot: '/project', parentCardId: PARENT, sessionId: `planner:${PARENT}`, store, parentControl: { activateChild, cancelChild }, notifyCard: () => ({ ok: true, notificationId: 'unused' }) })]);
    return { store, activateChild, cancelChild, surface };
  }

  it('reserves the exact child lease and delegates activation without card I/O or callbacks', async () => {
    const test = harness();
    const context = testLlmToolInvocationContext({ sessionId: `planner:${PARENT}`, toolCallId: 'activate', toolName: 'activate_card' });
    await expect(invokeToolForLlm(test.surface, 'activate_card', { card_id: CHILD }, context)).resolves.toMatchObject({ success: true, data: { card_id: CHILD, outcome: 'done' } });
    expect(test.activateChild).toHaveBeenCalledWith({ childCardId: CHILD, invocation: expect.any(ChildInvocationLease) });
    expect(test.store.read).not.toHaveBeenCalled();
  });

  it('validates immediate-child identity before reserving or delegating', async () => {
    const test = harness();
    const base = testLlmToolInvocationContext({ sessionId: `planner:${PARENT}`, toolName: 'activate_card' });
    const reserve = jest.fn(base.childInvocation.reserveChild);
    const context = { ...base, childInvocation: { ...base.childInvocation, reserveChild: reserve } };
    await expect(invokeToolForLlm(test.surface, 'activate_card', { card_id: 'card-b' }, context)).resolves.toMatchObject({ success: false });
    expect(reserve).not.toHaveBeenCalled(); expect(test.activateChild).not.toHaveBeenCalled(); expect(test.store.read).not.toHaveBeenCalled();
  });

  it('delegates cancellation owner-first with no target/status/list/dependency read', async () => {
    const test = harness();
    const context = testLlmToolInvocationContext({ sessionId: `planner:${PARENT}`, toolName: 'cancel_card' });
    await expect(invokeToolForLlm(test.surface, 'cancel_card', { card_id: CHILD, reason: 'obsolete' }, context)).resolves.toMatchObject({ success: true });
    expect(test.cancelChild).toHaveBeenCalledWith({ childCardId: CHILD, reason: 'obsolete' });
    expect(test.store.read).not.toHaveBeenCalled();
  });

  it('preserves runtime Stop interruption identity', async () => {
    const test = harness(); const interruption = new RuntimeStoppedInterruption(); test.activateChild.mockRejectedValueOnce(interruption as never);
    const context = testLlmToolInvocationContext({ sessionId: `planner:${PARENT}`, toolName: 'activate_card' });
    const controller = new AbortController(); controller.abort(interruption);
    await expect(invokeToolForLlm(test.surface, 'activate_card', { card_id: CHILD }, context, controller.signal)).rejects.toBe(interruption);
  });
});
