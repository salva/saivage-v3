import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildWorkspaceContextNote } from '../../src/agents/analyst-handler.js';
import { ANALYST_CAPABILITY_CLASSES, ANALYST_UNKNOWN_CAPABILITY_TEMPLATE, ANALYST_UNSUPPORTED_ACTION_TEMPLATE, runAuditedAnalystTool } from '../../src/agents/analyst-tool-runner.js';
import { RuntimeInterventionBinding } from '../../src/application/intervention-readiness.js';
import { listControlActions } from '../../src/persistence/index.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function harness(options: { ready?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'saivage-analyst-audit-'));
  roots.push(root);
  const intervention = new RuntimeInterventionBinding();
  if (options.ready !== false) intervention.markStoppedReady();
  const context = { projectRoot: root, actor: 'analyst', surface: 'web-chat', interventionReadiness: intervention, analystPreparation: {}, analystMutations: {} } as never;
  const spec = (mutate: (...args: any[]) => any, extra: Record<string, unknown> = {}) => ({ action: 'card.test', safety_class: 'low' as const, target_kind: 'card' as const, getTargetId: () => 'project', lifecycle: 'intervention_ready' as const, mutate, ...extra });
  return { root, context, spec };
}

describe('Analyst retained navigation and capability behavior', () => {
  it('renders current workspace navigation without inventing focused state', () => {
    expect(buildWorkspaceContextNote()).toBe('[workspace-context] none — no entity is currently in focus');
    expect(buildWorkspaceContextNote({ view: 'cards', entityId: 'project', refinement: { tab: 'history', filter: 'failed' } })).toBe('[workspace-context]\nview: cards\nentity: project\nrefinement: tab=history;filter=failed');
  });

  it('keeps unsupported/unknown capability replies constrained to the registered catalog', () => {
    expect(ANALYST_CAPABILITY_CLASSES).toContain('Investigate and repair');
    expect(ANALYST_UNSUPPORTED_ACTION_TEMPLATE('Navigate', ['open_card'])).toContain('Closest available capability: Navigate');
    expect(ANALYST_UNKNOWN_CAPABILITY_TEMPLATE('delete_everything')).toContain('it is not a registered capability');
  });
});

describe('audited Analyst mutation settlement', () => {
  it('runs a supported destructive mutation once and preserves its audit classification', async () => {
    const test = harness();
    const mutate = jest.fn(() => ({ kind: 'returned' as const, success: true as const }));
    await expect(runAuditedAnalystTool(test.context, {}, { ...test.spec(mutate), safety_class: 'destructive' })).resolves.toEqual({ success: true });
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(listControlActions(test.root)).toHaveLength(1);
    expect(listControlActions(test.root)[0]).toMatchObject({ actor: 'analyst', surface: 'web-chat', safety_class: 'destructive', outcome: 'ok' });
  });

  it('audits application denial after preparation exactly once', async () => {
    const test = harness();
    const result = await runAuditedAnalystTool(test.context, {}, test.spec(() => ({ kind: 'denied', reason: 'status changed' }), { prepare: async () => ({ current: true }) }));
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('status changed') });
    expect(listControlActions(test.root)[0]).toMatchObject({ outcome: 'denied' });
  });

  it('projects and audits a returned failure', async () => {
    const test = harness();
    const result = await runAuditedAnalystTool(test.context, {}, test.spec(() => ({ kind: 'returned', success: false, error: 'owner rejected' })));
    expect(result).toEqual({ success: false, error: 'owner rejected' });
    expect(listControlActions(test.root)[0]).toMatchObject({ outcome: 'error', error: 'owner rejected' });
  });

  it('audits preparation throws and rethrows the original error', async () => {
    const test = harness();
    const error = new Error('prepare failed');
    await expect(runAuditedAnalystTool(test.context, {}, test.spec(jest.fn(), { prepare: async () => { throw error; } }))).rejects.toBe(error);
    expect(listControlActions(test.root)[0]).toMatchObject({ outcome: 'error', error: 'prepare failed' });
  });

  it('audits cancellation after preparation without calling the application', async () => {
    const test = harness();
    const controller = new AbortController();
    const mutate = jest.fn();
    await expect(runAuditedAnalystTool(test.context, {}, test.spec(mutate, { prepare: async () => { controller.abort(new Error('turn cancelled')); return {}; } }), controller.signal)).rejects.toThrow('turn cancelled');
    expect(mutate).not.toHaveBeenCalled();
    expect(listControlActions(test.root)[0]).toMatchObject({ outcome: 'error' });
  });

  it('audits readiness and application throws without calling twice', async () => {
    const readiness = harness({ ready: false });
    const mutate = jest.fn();
    await expect(runAuditedAnalystTool(readiness.context, {}, readiness.spec(mutate))).rejects.toThrow();
    expect(mutate).not.toHaveBeenCalled();
    expect(listControlActions(readiness.root)).toHaveLength(1);

    const application = harness();
    const error = new Error('owner threw');
    const throwing = jest.fn(() => { throw error; });
    await expect(runAuditedAnalystTool(application.context, {}, application.spec(throwing))).rejects.toBe(error);
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(listControlActions(application.root)[0]).toMatchObject({ outcome: 'error', error: 'owner threw' });
  });

  it('audits returned success once', async () => {
    const test = harness();
    await expect(runAuditedAnalystTool(test.context, {}, test.spec(() => ({ kind: 'returned', success: true, data: { ok: true } })))).resolves.toEqual({ success: true, data: { ok: true } });
    expect(listControlActions(test.root)[0]).toMatchObject({ outcome: 'ok' });
  });

  it.each([
    { action: 'card.reorder_child', result: { kind: 'returned' as const, success: true as const, data: { changed: 1 } }, outcome: 'ok' },
    { action: 'notification.queue', result: { kind: 'returned' as const, success: false as const, error: 'terminal_card' }, outcome: 'error' },
  ])('settles Analyst $action exactly once', async ({ action, result, outcome }) => {
    const test = harness();
    await runAuditedAnalystTool(test.context, {}, test.spec(() => result, { action }));
    expect(listControlActions(test.root)).toHaveLength(1);
    expect(listControlActions(test.root)[0]).toMatchObject({ actor: 'analyst', action, outcome });
  });

  it('keeps a committed success ok when cancellation arrives before the application returns', async () => {
    const test = harness();
    const controller = new AbortController();
    const mutate = jest.fn(async () => { controller.abort(new Error('late cancellation')); return { kind: 'returned' as const, success: true as const }; });
    await expect(runAuditedAnalystTool(test.context, {}, test.spec(mutate), controller.signal)).rejects.toThrow('late cancellation');
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(listControlActions(test.root)).toHaveLength(1);
    expect(listControlActions(test.root)[0]).toMatchObject({ outcome: 'ok' });
  });

  it('propagates audit append failure without another append attempt', async () => {
    const test = harness();
    mkdirSync(join(test.root, '.saivage', 'logs', 'app.jsonl'), { recursive: true });
    const mutate = jest.fn(() => ({ kind: 'returned' as const, success: true as const }));
    await expect(runAuditedAnalystTool(test.context, {}, test.spec(mutate))).rejects.toThrow();
    expect(mutate).toHaveBeenCalledTimes(1);
  });
});
