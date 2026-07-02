import { describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  it('reads files outside the project through system:// scope', async () => {
    const { root } = setupProject();
    const systemRoot = mkdtempSync(join(tmpdir(), 'workspace-provider-system-'));
    try {
      const file = join(systemRoot, 'outside.txt');
      writeFileSync(file, 'outside content', 'utf8');
      const surface = buildInvocationSurface('executor', [createWorkspaceProvider({ projectRoot: root, cardId: 'card-1', agentRole: 'executor' })]);

      const result = await invokeTool(surface, 'read', { path: `system://${file}` });

      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toMatchObject({ path: `system://${file}`, content: 'outside content' });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(systemRoot, { recursive: true, force: true });
    }
  });

  it('globs and greps files outside the project through system:// scope while skipping secrets', async () => {
    const { root } = setupProject();
    const systemRoot = mkdtempSync(join(tmpdir(), 'workspace-provider-system-'));
    try {
      mkdirSync(join(systemRoot, 'nested'));
      writeFileSync(join(systemRoot, 'nested', 'match.md'), 'UNIQUE_TOKEN visible', 'utf8');
      writeFileSync(join(systemRoot, '.env'), 'UNIQUE_TOKEN secret', 'utf8');
      const surface = buildInvocationSurface('executor', [createWorkspaceProvider({ projectRoot: root, cardId: 'card-1', agentRole: 'executor' })]);

      const globResult = await invokeTool(surface, 'glob', { directory: `system://${systemRoot}`, pattern: '**/*.md' });
      const grepResult = await invokeTool(surface, 'grep', { path: `system://${systemRoot}`, pattern: 'UNIQUE_TOKEN' });

      expect(globResult.success).toBe(true);
      if (globResult.success) expect((globResult.data as { matches: string[] }).matches).toEqual([`system://${join(systemRoot, 'nested', 'match.md')}`]);
      expect(grepResult.success).toBe(true);
      if (grepResult.success) {
        const matches = (grepResult.data as { matches: Array<{ path: string }> }).matches;
        expect(matches.map((match) => match.path)).toEqual([`system://${join(systemRoot, 'nested', 'match.md')}`]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(systemRoot, { recursive: true, force: true });
    }
  });

  it('allows executor system:// writes and denies secret-looking system writes', async () => {
    const { root } = setupProject();
    const systemRoot = mkdtempSync(join(tmpdir(), 'workspace-provider-system-'));
    try {
      const surface = buildInvocationSurface('executor', [createWorkspaceProvider({ projectRoot: root, cardId: 'card-1', agentRole: 'executor' })]);
      const target = join(systemRoot, 'out.txt');

      const ok = await invokeTool(surface, 'write', { path: `system://${target}`, content: 'ok' });
      const denied = await invokeTool(surface, 'write', { path: `system://${join(systemRoot, '.env')}`, content: 'SECRET=1' });

      expect(ok.success).toBe(true);
      expect(readFileSync(target, 'utf8')).toBe('ok');
      expect(denied.success).toBe(false);
      if (!denied.success) expect(denied.error).toContain('blocked for security reasons');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(systemRoot, { recursive: true, force: true });
    }
  });

  it('allows Analyst project write/edit/apply_patch through canonical workspace tools', async () => {
    const { root } = setupProject();
    try {
      const surface = buildInvocationSurface('analyst', [
        createWorkspaceProvider({ projectRoot: root, agentRole: 'analyst' }),
        createPatchProvider({ projectRoot: root, agentRole: 'analyst' }),
      ]);

      const write = await invokeTool(surface, 'write', { path: 'notes.txt', content: 'before' });
      const edit = await invokeTool(surface, 'edit', { path: 'notes.txt', old_string: 'before', new_string: 'after' });
      const patch = await invokeTool(surface, 'apply_patch', { patch: '--- /dev/null\n+++ b/patched.txt\n@@ -0,0 +1 @@\n+patched\n' });

      expect(write.success).toBe(true);
      expect(edit.success).toBe(true);
      expect(patch.success).toBe(true);
      expect(readFileSync(join(root, 'notes.txt'), 'utf8')).toBe('after');
      expect(readFileSync(join(root, 'patched.txt'), 'utf8')).toBe('patched\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows Analyst system:// writes while preserving planner write denial', async () => {
    const { root } = setupProject();
    const systemRoot = mkdtempSync(join(tmpdir(), 'workspace-provider-system-'));
    try {
      const analystSurface = buildInvocationSurface('analyst', [createWorkspaceProvider({ projectRoot: root, agentRole: 'analyst' })]);
      const plannerSurface = buildInvocationSurface('planner', [createWorkspaceProvider({ projectRoot: root, cardId: 'card-1', agentRole: 'planner' })]);
      const target = join(systemRoot, 'analyst-out.txt');

      const analystWrite = await invokeTool(analystSurface, 'write', { path: `system://${target}`, content: 'operator' });
      const plannerWrite = await invokeTool(plannerSurface, 'write', { path: 'planner-out.txt', content: 'nope' });

      expect(analystWrite.success).toBe(true);
      expect(readFileSync(target, 'utf8')).toBe('operator');
      expect(plannerWrite.success).toBe(false);
      if (!plannerWrite.success) expect(plannerWrite.error).toContain('planner cannot write project files');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(systemRoot, { recursive: true, force: true });
    }
  });

  it('allows Analyst explicit-card record reads and searches without an active card context', async () => {
    const { root, store } = setupProject();
    try {
      const card = store.create({ type: 'goal', parent: 'project', title: 'Goal', brief: 'old', status: 'backlog', depth: 0, tags: [], priority: 1, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], retries: 0 });
      const surface = buildInvocationSurface('analyst', [createWorkspaceProvider({ projectRoot: root, agentRole: 'analyst', store })]);

      const write = await invokeTool(surface, 'write', { path: `record://brief.md?card=${card.id}&v=next`, content: VALID_BRIEF });
      const read = await invokeTool(surface, 'read', { path: `record://brief.md?card=${card.id}` });
      const glob = await invokeTool(surface, 'glob', { directory: `record://${card.id}`, pattern: '**/*.md' });
      const grep = await invokeTool(surface, 'grep', { path: `record://${card.id}/brief.md`, pattern: 'Acceptance Criteria' });

      expect(write.success).toBe(true);
      expect(read.success).toBe(true);
      if (read.success) expect(read.data).toMatchObject({ content: VALID_BRIEF, record_url: `record://brief.md?card=${card.id}&v=2` });
      expect(glob.success).toBe(true);
      if (glob.success) expect((glob.data as { matches: string[] }).matches.some((path) => path.endsWith('/brief/2.md'))).toBe(true);
      expect(grep.success).toBe(true);
      if (grep.success) expect((grep.data as { matches: Array<{ preview: string }> }).matches.some((match) => match.preview.includes('Acceptance Criteria'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows Analyst tmp:// access for an explicit card without an active card context', async () => {
    const { root } = setupProject();
    try {
      const surface = buildInvocationSurface('analyst', [createWorkspaceProvider({ projectRoot: root, agentRole: 'analyst' })]);

      const write = await invokeTool(surface, 'write', { path: 'tmp://card-1/notes.txt', content: 'temporary note' });
      const read = await invokeTool(surface, 'read', { path: 'tmp://card-1/notes.txt' });

      expect(write.success).toBe(true);
      expect(read.success).toBe(true);
      if (read.success) expect(read.data).toMatchObject({ content: 'temporary note' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
