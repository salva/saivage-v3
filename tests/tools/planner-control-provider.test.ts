import { initProjectTree, CardStore } from '../helpers/canonical-project.js';
import { describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';



import { buildInvocationSurface, invokeTool, replayToolForRecovery } from '../../src/tools/invocation.js';
import { createPlannerControlProvider } from '../../src/tools/planner-control-provider.js';
import type { CardRecord } from '../../src/schemas/index.js';

function withRoot<T>(fn: (projectRoot: string) => Promise<T> | T): Promise<T> | T {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-planner-control-'));
  const result = fn(projectRoot);
  if (result instanceof Promise) return result.finally(() => rmSync(projectRoot, { recursive: true, force: true }));
  rmSync(projectRoot, { recursive: true, force: true });
  return result;
}

function createChild(store: CardStore, status: CardRecord['status'] = 'backlog'): CardRecord {
  const child = store.create({ type: 'goal', parent: 'project', depth: 1, title: 'child', brief: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], retries: 0 });
  if (status === 'done') return store.commitTerminalLifecyclePatch(child.id, { status: 'done', lifecycle: { status: 'done', result: { kind: 'done', summary: 'child done' }, error: null, completed_at: '2026-06-12T00:00:00.000Z' } });
  if (status !== 'backlog') return store.setStatus(child.id, status);
  return child;
}

describe('planner activate_card recovery dispatch', () => {
  it('replays terminal child results as settled recovery output', async () => withRoot(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const child = createChild(store, 'done');
    const surface = buildInvocationSurface('planner', [createPlannerControlProvider({ projectRoot, parentCardId: 'project', sessionId: 'planner:project', store, children: { get: () => null } })]);

    const replay = await replayToolForRecovery(surface, 'activate_card', { card_id: child.id });

    expect(replay).toEqual({ kind: 'settled', result: { success: true, data: { card_id: child.id, outcome: 'done', summary: 'child done', result: { kind: 'done', summary: 'child done' } } } });
  }));

  it('uses recoverCurrentCardState before awaiting a running child', async () => withRoot(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const child = createChild(store, 'running');
    const calls: string[] = [];
    const childActor = {
      activate: jest.fn(async () => { calls.push('activate'); return { status: 'done', summary: 'fresh' }; }),
      recoverCurrentCardState: jest.fn(() => { calls.push('recoverCurrentCardState'); }),
      awaitSettlement: jest.fn(async () => { calls.push('awaitSettlement'); return { status: 'done', summary: 'recovered', result: { kind: 'done', summary: 'recovered' } }; }),
      cancel: jest.fn(),
    };
    const surface = buildInvocationSurface('planner', [createPlannerControlProvider({ projectRoot, parentCardId: 'project', sessionId: 'planner:project', store, children: { get: () => childActor } })]);

    const result = await invokeTool(surface, 'activate_card', { card_id: child.id });

    expect(result).toEqual({ success: true, data: { card_id: child.id, outcome: 'done', summary: 'recovered', result: { kind: 'done', summary: 'recovered' } } });
    expect(childActor.activate).not.toHaveBeenCalled();
    expect(calls).toEqual(['recoverCurrentCardState', 'awaitSettlement']);
  }));
});
