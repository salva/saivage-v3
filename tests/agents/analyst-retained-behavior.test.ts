import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildWorkspaceContextNote } from '../../src/agents/analyst-handler.js';
import { ANALYST_CAPABILITY_CLASSES, ANALYST_UNKNOWN_CAPABILITY_TEMPLATE, ANALYST_UNSUPPORTED_ACTION_TEMPLATE, runAuditedAnalystTool } from '../../src/agents/analyst-tool-runner.js';
import { EventBus } from '../../src/events/index.js';
import { RuntimeInterventionBinding } from '../../src/application/intervention-readiness.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('Analyst retained navigation, safety, and mutation admission', () => {
  it('renders current workspace navigation without inventing focused state', () => {
    expect(buildWorkspaceContextNote()).toBe('[workspace-context] none — no entity is currently in focus');
    expect(buildWorkspaceContextNote({ view: 'cards', entityId: 'project', refinement: { tab: 'history', filter: 'failed' } })).toBe('[workspace-context]\nview: cards\nentity: project\nrefinement: tab=history;filter=failed');
  });

  it('keeps unsupported/unknown capability replies constrained to the registered catalog', () => {
    expect(ANALYST_CAPABILITY_CLASSES).toContain('Investigate and repair');
    expect(ANALYST_UNSUPPORTED_ACTION_TEMPLATE('Navigate', ['open_card'])).toContain('Closest available capability: Navigate');
    expect(ANALYST_UNKNOWN_CAPABILITY_TEMPLATE('delete_everything')).toContain('it is not a registered capability');
  });

  it('checks cancellation after async preparation and before permission/commit/audit success', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-analyst-admission-'));
    roots.push(root);
    const intervention = new RuntimeInterventionBinding();
    intervention.markStoppedReady();
    const controller = new AbortController();
    const commit = jest.fn(async () => ({ success: true as const, data: { ok: true } }));
    const recheck = jest.fn(() => ({ allowed: true as const }));
    const context = {
      projectRoot: root, actor: 'analyst', surface: 'web-chat', appLogs: { projectRoot: root }, eventBus: new EventBus(), interventionReadiness: intervention,
      analystPreparation: {}, analystMutations: {},
    } as never;
    const pending = runAuditedAnalystTool(context, { card_id: 'project' }, {
      action: 'edit_card', safety_class: 'low', target_kind: 'card', getTargetId: (params) => params.card_id, lifecycle: 'intervention_ready',
      prepare: async () => { controller.abort(new Error('turn cancelled')); return { current: true }; },
      recheck, commit,
    }, controller.signal);

    await expect(pending).rejects.toThrow('turn cancelled');
    expect(recheck).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it('rechecks permission immediately before commit and records no mutation when denied', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-analyst-admission-'));
    roots.push(root);
    const intervention = new RuntimeInterventionBinding();
    intervention.markStoppedReady();
    const commit = jest.fn(async () => ({ success: true as const }));
    const result = await runAuditedAnalystTool({ projectRoot: root, actor: 'analyst', surface: 'web-chat', appLogs: { projectRoot: root }, eventBus: new EventBus(), interventionReadiness: intervention, analystPreparation: {}, analystMutations: {} } as never, { card_id: 'project' }, {
      action: 'edit_card', safety_class: 'low', target_kind: 'card', getTargetId: (params) => params.card_id, lifecycle: 'intervention_ready',
      prepare: async () => ({ current: true }), recheck: () => ({ allowed: false, reason: 'status changed' }), commit,
    });
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('status changed') });
    expect(commit).not.toHaveBeenCalled();
  });
});
