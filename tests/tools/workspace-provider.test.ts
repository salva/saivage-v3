import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardStore } from '../../src/cards/card-store.js';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { initRuntimeState, updateRuntimeState } from '../../src/runtime/state.js';
import { buildInvocationSurface, invokeTool } from '../../src/tools/invocation.js';
import { createPatchProvider, createWorkspaceProvider } from '../../src/tools/workspace-provider.js';
import { materializeProjectCard } from '../helpers/materialize-project-card.js';

const VALID_BRIEF = '# Goal\n\nDo the work.\n\n# Instructions\n\nUse the records.\n\n# Acceptance Criteria\n\nDone.\n';

function setupProject(): { root: string; store: CardStore } {
  const root = mkdtempSync(join(tmpdir(), 'workspace-provider-'));
  initProjectTree(root);
  materializeProjectCard(root);
  initRuntimeState(root);
  return { root, store: new CardStore(root) };
}

describe('workspace and patch providers', () => {
  it('exposes canonical workspace tools', () => {
    const surface = buildInvocationSurface('executor', [createWorkspaceProvider({ projectRoot: process.cwd(), cardId: 'card-1', agentRole: 'executor' })]);

    expect([...surface.tools.keys()]).toEqual(['read', 'write', 'edit', 'glob', 'grep']);
  });

  it('keeps apply_patch in a separate provider', () => {
    const surface = buildInvocationSurface('executor', [
      createWorkspaceProvider({ projectRoot: process.cwd(), cardId: 'card-1', agentRole: 'executor' }),
      createPatchProvider({ projectRoot: process.cwd(), cardId: 'card-1', agentRole: 'executor' }),
    ]);

    expect([...surface.tools.keys()]).toContain('apply_patch');
  });

  it('returns model-visible file errors instead of throwing', async () => {
    const surface = buildInvocationSurface('executor', [createWorkspaceProvider({ projectRoot: process.cwd(), cardId: 'card-1', agentRole: 'executor' })]);

    const result = await invokeTool(surface, 'read', { path: 'definitely-missing-file.txt' });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('ENOENT');
  });

  it('lets Analyst canonical write create a closed brief record for an explicit card', async () => {
    const { root, store } = setupProject();
    try {
      const card = store.create({ type: 'goal', parent: 'project', title: 'Goal', brief: 'old', status: 'backlog', depth: 0, tags: [], priority: 1, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], retries: 0 });
      const surface = buildInvocationSurface('analyst', [createWorkspaceProvider({ projectRoot: root, agentRole: 'analyst', store })]);

      const result = await invokeTool(surface, 'write', { path: `record://brief.md?card=${card.id}&v=next`, content: VALID_BRIEF });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { path: string; record_url: string; card_id: string };
        expect(data.card_id).toBe(card.id);
        expect(data.record_url).toBe(`record://brief.md?card=${card.id}&v=2`);
        expect(readFileSync(join(root, data.path), 'utf8')).toBe(VALID_BRIEF);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('denies Analyst canonical brief writes while the runtime is running', async () => {
    const { root, store } = setupProject();
    try {
      const card = store.create({ type: 'goal', parent: 'project', title: 'Goal', brief: 'old', status: 'backlog', depth: 0, tags: [], priority: 1, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], retries: 0 });
      updateRuntimeState(root, { status: 'running' });
      const surface = buildInvocationSurface('analyst', [createWorkspaceProvider({ projectRoot: root, agentRole: 'analyst', store })]);

      const result = await invokeTool(surface, 'write', { path: `record://brief.md?card=${card.id}&v=next`, content: VALID_BRIEF });

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('requires runtime status stopped or paused');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not mask missing Analyst card-store context as a model-visible tool error', async () => {
    const { root, store } = setupProject();
    try {
      const card = store.create({ type: 'goal', parent: 'project', title: 'Goal', brief: 'old', status: 'backlog', depth: 0, tags: [], priority: 1, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], retries: 0 });
      const surface = buildInvocationSurface('analyst', [createWorkspaceProvider({ projectRoot: root, agentRole: 'analyst' })]);

      await expect(invokeTool(surface, 'write', { path: `record://brief.md?card=${card.id}&v=next`, content: VALID_BRIEF })).rejects.toThrow('Analyst record writes require a card store.');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
