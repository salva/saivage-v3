import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardService, initProjectTree } from '../helpers/canonical-project.js';
import { bindToolProvider, invokeToolForLlm } from '../../src/tools/invocation.js';
import { buildInvocationSurfaceFixture } from '../helpers/invocation-surface-fixture.js';
import { plannerControlToolBinders, type PlannerControlProviderContext } from '../../src/tools/planner-control-provider.js';
import { ChildInvocationLease } from '../../src/runtime/actors/child-invocation-wait.js';
import { RuntimeStoppedInterruption } from '../../src/runtime/actors/runtime-stopped-interruption.js';
import { testLlmToolInvocationContext } from '../helpers/llm-test-helpers.js';
import { workflowResult } from '../helpers/workflow-result.js';
import { runtimeFailure } from '../helpers/workflow-result.js';
import type { CardRecord, CardStatus } from '../../src/schemas/index.js';

const PARENT = 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CHILD = `${PARENT}-b`;
const roots: string[] = [];
const bindPlannerControl = (context: PlannerControlProviderContext) => bindToolProvider('planner-control', plannerControlToolBinders, context);

afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('planner control provider ownership delegation', () => {
  function harness() {
    const store = {
      read: jest.fn((id:string)=>id===CHILD?{id:CHILD,type:'code'}:null), create: jest.fn(), editCard: jest.fn(), reorderChildren: jest.fn(),
    } as unknown as CardService;
    const activateChild = jest.fn(async ({ childCardId }: { childCardId: string; invocation: ChildInvocationLease }) => ({ status: 'done' as const, summary: childCardId, result: workflowResult('DONE',childCardId) }));
    const cancelChild = jest.fn(async ({ childCardId }: { childCardId: string; reason: string }) => ({ card_id: childCardId, status: 'cancelled' as const, cancelled_card_ids: [childCardId] }));
    const notifyCard = jest.fn(() => ({ ok: true as const, notificationId: 'unused' }));
    const surface = buildInvocationSurfaceFixture('planner', [bindPlannerControl({ agentName:'planner',projectRoot: '/project', parentCardId: PARENT, sessionId: `agent:planner:${PARENT}`, store, parentControl: { activateChild, cancelChild }, notifyCard,childCreationTypes:new Set(),childActivationTypes:new Set(['code']),cardTypeVocabulary:['project','goal','architecture','code','test','doc','data','research','ops'] })]);
    return { store, activateChild, cancelChild, notifyCard, surface };
  }

  it('reserves the exact child lease and delegates activation without card I/O or callbacks', async () => {
    const test = harness();
    const context = testLlmToolInvocationContext({ sessionId: `agent:planner:${PARENT}`, toolCallId: 'activate', toolName: 'activate_card' });
    await expect(invokeToolForLlm(test.surface, 'activate_card', { card_id: CHILD }, context)).resolves.toMatchObject({ success: true, data: { card_id: CHILD, outcome: 'done' } });
    expect(test.activateChild).toHaveBeenCalledWith({ childCardId: CHILD, invocation: expect.any(ChildInvocationLease) });
    expect(test.store.read).toHaveBeenCalledWith(CHILD);
  });

  it('validates immediate-child identity before reserving or delegating', async () => {
    const test = harness();
    const base = testLlmToolInvocationContext({ sessionId: `agent:planner:${PARENT}`, toolName: 'activate_card' });
    const reserve = jest.fn(base.childInvocation.reserveChild);
    const context = { ...base, childInvocation: { ...base.childInvocation, reserveChild: reserve } };
    await expect(invokeToolForLlm(test.surface, 'activate_card', { card_id: 'card-b' }, context)).resolves.toMatchObject({ success: false });
    expect(reserve).not.toHaveBeenCalled(); expect(test.activateChild).not.toHaveBeenCalled(); expect(test.store.read).not.toHaveBeenCalled();
  });

  it('delegates cancellation owner-first with no target/status/list/dependency read', async () => {
    const test = harness();
    const context = testLlmToolInvocationContext({ sessionId: `agent:planner:${PARENT}`, toolName: 'cancel_card' });
    await expect(invokeToolForLlm(test.surface, 'cancel_card', { card_id: CHILD, reason: 'obsolete' }, context)).resolves.toMatchObject({ success: true });
    expect(test.cancelChild).toHaveBeenCalledWith({ childCardId: CHILD, reason: 'obsolete' });
    expect(test.store.read).not.toHaveBeenCalled();
  });

  it('returns a current-parent zero-change reorder without card or notification follow-on work', async () => {
    const test = harness();
    jest.mocked(test.store.reorderChildren).mockReturnValue({ ok: true, changed: 0 });
    const context = testLlmToolInvocationContext({ sessionId: `agent:planner:${PARENT}`, toolName: 'reorder_child' });
    await expect(invokeToolForLlm(test.surface, 'reorder_child', { orderedChildIds: [] }, context)).resolves.toEqual({ success: true, data: { parent_id: PARENT, changed: 0 } });
    expect(test.store.reorderChildren).toHaveBeenCalledTimes(1);
    expect(test.store.reorderChildren).toHaveBeenCalledWith(PARENT, []);
    expect(test.store.read).not.toHaveBeenCalled();
    expect(test.notifyCard).not.toHaveBeenCalled();
  });

  it('preserves runtime Stop interruption identity', async () => {
    const test = harness(); const interruption = new RuntimeStoppedInterruption(); test.activateChild.mockRejectedValueOnce(interruption as never);
    const context = testLlmToolInvocationContext({ sessionId: `agent:planner:${PARENT}`, toolName: 'activate_card' });
    const controller = new AbortController(); controller.abort(interruption);
    await expect(invokeToolForLlm(test.surface, 'activate_card', { card_id: CHILD }, context, controller.signal)).rejects.toBe(interruption);
  });

  function editHarness(status: CardStatus) {
    const root = mkdtempSync(join(tmpdir(), `planner-edit-${status}-`)); roots.push(root); initProjectTree(root);
    const store = new CardService(root);
    const child = store.create({ type: 'code', parent: 'project', title: 'Original', bootstrap_content: 'Brief', tags: ['existing'], priority: 1, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    if (status === 'changed') {
      store.setStatus(child.id, 'running');
      store.commitActivationOutcome(child.id, { status: 'blocked', summary: 'blocked', result: workflowResult('BLOCKED', 'blocked') }, '2026-08-15T00:00:00.000Z');
      store.setStatus(child.id, 'changed');
    }
    else if (status === 'running') store.setStatus(child.id, 'running');
    else if (status === 'stopped') { store.setStatus(child.id, 'running'); store.stopRunningForRecovery(child.id); }
    else if (status === 'cancelled') store.setStatus(child.id, 'cancelled');
    else if (status === 'done' || status === 'failed' || status === 'blocked') {
      store.setStatus(child.id, 'running');
      if (status === 'done') store.commitActivationOutcome(child.id, { status, summary: 'done', result: workflowResult('DONE', 'done') }, '2026-08-15T00:00:00.000Z');
      else if (status === 'failed') store.commitActivationOutcome(child.id, { status, summary: 'failed', result: runtimeFailure('failed') }, '2026-08-15T00:00:00.000Z');
      else store.commitActivationOutcome(child.id, { status, summary: 'blocked', result: workflowResult('BLOCKED', 'blocked') }, '2026-08-15T00:00:00.000Z');
    }
    const provider = bindPlannerControl({ agentName: 'planner', projectRoot: root, parentCardId: 'project', sessionId: 'agent:planner:project', store, parentControl: { activateChild: jest.fn() as never, cancelChild: jest.fn() as never }, notifyCard: () => ({ ok: true, notificationId: 'unused' }), childCreationTypes: new Set(), childActivationTypes: new Set(),cardTypeVocabulary:['project','goal','architecture','code','test','doc','data','research','ops'] });
    const surface = buildInvocationSurfaceFixture('planner', [provider]);
    return { store, child: store.read(child.id)!, surface };
  }

  function invokeEdit(surface: ReturnType<typeof buildInvocationSurfaceFixture>, args: Record<string, unknown>) {
    return invokeToolForLlm(surface, 'edit_card', args, testLlmToolInvocationContext({ sessionId: 'agent:planner:project', toolName: 'edit_card' }));
  }

  it.each(['blocked', 'failed'] as const)('keeps an equal-value %s child unchanged without adding a version', async (status) => {
    const test = editHarness(status);
    const before = test.store.listCardVersions(test.child.id);
    await expect(invokeEdit(test.surface, { card_id: test.child.id, title: test.child.title })).resolves.toMatchObject({ success: true, data: { card: { status, title: test.child.title } } });
    expect(test.store.read(test.child.id)).toEqual(test.child);
    expect(test.store.listCardVersions(test.child.id)).toEqual(before);
  });

  it.each(['blocked', 'failed'] as const)('corrects and changes a %s child through one delegated edit', async (status) => {
    const test = editHarness(status);
    await expect(invokeEdit(test.surface, { card_id: test.child.id, title: 'Corrected' })).resolves.toMatchObject({ success: true, data: { card: { status: 'changed', title: 'Corrected' } } });
    expect(test.store.read(test.child.id)).toMatchObject({ title: 'Corrected', lifecycle: { status: 'changed' } });
  });

  it.each(['backlog', 'changed', 'stopped'] as const)('preserves %s lifecycle for a real edit', async (status) => {
    const test = editHarness(status);
    await expect(invokeEdit(test.surface, { card_id: test.child.id, priority: 9 })).resolves.toMatchObject({ success: true, data: { card: { status, priority: 9 } } });
    expect(test.store.read(test.child.id)).toMatchObject({ priority: 9, lifecycle: { status } });
  });

  it.each(['running', 'done', 'cancelled'] as const)('rejects a %s child before editing', async (status) => {
    const test = editHarness(status);
    const edit = jest.spyOn(test.store, 'editCard');
    await expect(invokeEdit(test.surface, { card_id: test.child.id, title: 'Rejected' })).resolves.toMatchObject({ success: false, error: expect.stringContaining(status) });
    expect(edit).not.toHaveBeenCalled();
  });

  it('delegates once without a provider-side status call', async () => {
    const blocked = { id: CHILD, type: 'code', title: 'Original', lifecycle: { status: 'blocked' } } as unknown as CardRecord;
    const updated = { ...blocked, title: 'Corrected', lifecycle: { status: 'changed' } } as CardRecord;
    const setStatus = jest.fn();
    const store = { read: jest.fn(() => blocked), editCard: jest.fn(() => updated), setStatus };
    const surface = buildInvocationSurfaceFixture('planner', [bindPlannerControl({ agentName: 'planner', projectRoot: '/project', parentCardId: PARENT, sessionId: `agent:planner:${PARENT}`, store: store as unknown as CardService, parentControl: { activateChild: jest.fn() as never, cancelChild: jest.fn() as never }, notifyCard: () => ({ ok: true, notificationId: 'unused' }), childCreationTypes: new Set(), childActivationTypes: new Set(),cardTypeVocabulary:['project','goal','architecture','code','test','doc','data','research','ops'] })]);
    await expect(invokeEdit(surface, { card_id: CHILD, title: 'Corrected' })).resolves.toMatchObject({ success: true, data: { card: { status: 'changed' } } });
    expect(store.editCard).toHaveBeenCalledTimes(1);
    expect(setStatus).not.toHaveBeenCalled();
  });
});
