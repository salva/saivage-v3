import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardStore, closeTestProject, initProjectTree, testConfigAuthority } from '../helpers/canonical-project.js';
import { get_card, get_tree } from '../../src/tools/analyst-card-tools.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { createTestProcessRunner } from '../helpers/test-process-runner.js';
import { testAppLogs } from '../helpers/app-logs.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { closeTestProject(root); rmSync(root, { recursive: true, force: true }); } });

describe('canonical persisted subtree ordering', () => {
  it('preserves explicit child order across reopen and card/tree read models', async () => {
    const root = mkdtempSync(join(tmpdir(), 'canonical-subtree-order-'));
    roots.push(root);
    initProjectTree(root);
    let store = new CardStore(root);
    const make = (title: string, parent: string, type: 'goal' | 'code' = 'goal') => store.create({ type, parent, title, brief: title, status: 'backlog', depth: 1, tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], retries: 0 });
    const parent = make('Parent', 'project');
    const alpha = make('Alpha', parent.id);
    const beta = make('Beta', parent.id);
    const gamma = make('Gamma', parent.id);
    make('Alpha child', alpha.id, 'code');
    make('Beta child', beta.id, 'code');
    const expected = [beta.id, gamma.id, alpha.id];
    expect(store.reorderChildren(parent.id, expected, { actor: 'analyst', surface: 'web-chat', reason: 'test order' })).toEqual({ ok: true, changed: 3 });

    closeTestProject(root);
    store = new CardStore(root);
    expect(store.listChildren(parent.id)).toEqual(expected);
    const processRunner = createTestProcessRunner(root);
    const context = { projectRoot: root, configAuthority: testConfigAuthority(root), mutationAuthority: () => store.currentMutationAuthority(), processRunner, processScope: processRunner.createDirectScope(processRunner.analystRootScope, 'test-analyst', 'operator_session'), store, actor: 'analyst' as const, surface: 'web-chat' as const, restartServerAvailable: false, appLogs: testAppLogs(root) };
    const detail = await get_card(context, { id: parent.id });
    const tree = await get_tree(context, { rootId: parent.id });
    expect(detail.success).toBe(true);
    expect(tree.success).toBe(true);
    if (detail.success) expect((detail.data as { children: Array<{ id: string }> }).children.map(({ id }) => id)).toEqual(expected);
    if (tree.success) expect((tree.data as { children: Array<{ id: string }> }).children.map(({ id }) => id)).toEqual(expected);
  });
});
