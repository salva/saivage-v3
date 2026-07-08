import { describe, expect, it, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardStore } from '../../src/cards/card-store.js';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { initRuntimeState, updateRuntimeState } from '../../src/runtime/state.js';
import { buildInvocationSurface, invokeTool } from '../../src/tools/invocation.js';
import { createPatchProvider, createWorkspaceProvider } from '../../src/tools/workspace-provider.js';
import { materializeProjectCard } from '../helpers/materialize-project-card.js';
import { closeOpenRecordSlot, readRecordSlotIndex } from '../../src/runtime/records/record-slots.js';
import { writeProject } from '../../src/tools/project-file-tools.js';

const VALID_BRIEF = '# Goal\n\nDo the work.\n\n# Instructions\n\nUse the records.\n\n# Acceptance Criteria\n\nDone.\n';

function markDone(store: CardStore, id: string): void {
  store.repairTerminalLifecycle(id, { status: 'done', lifecycle: { status: 'done', result: { kind: 'done', summary: 'done' }, error: null, completed_at: '2026-01-01T00:00:00.000Z' } });
}

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
      markDone(store, card.id);
      const notifyCard = jest.fn(() => ({ ok: true as const }));
      const surface = buildInvocationSurface('analyst', [createWorkspaceProvider({ projectRoot: root, agentRole: 'analyst', store, notifyCard })]);

      const result = await invokeTool(surface, 'write', { path: `record:///brief.md?card=${card.id}&v=next`, content: VALID_BRIEF });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { path: string; record_url: string; card_id: string };
        expect(data.card_id).toBe(card.id);
        expect(data.record_url).toBe(`record:///brief.md?card=${card.id}&v=2`);
        expect(readFileSync(join(root, data.path), 'utf8')).toBe(VALID_BRIEF);
      }
      expect(store.read(card.id)?.status).toBe('changed');
      expect(notifyCard).toHaveBeenCalledWith(card.id, expect.objectContaining({ reason: 'card_changed' }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('denies Analyst canonical brief writes while the runtime is running', async () => {
    const { root, store } = setupProject();
    try {
      const card = store.create({ type: 'goal', parent: 'project', title: 'Goal', brief: 'old', status: 'backlog', depth: 0, tags: [], priority: 1, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], retries: 0 });
      updateRuntimeState(root, { status: 'running' });
      markDone(store, card.id);
      const surface = buildInvocationSurface('analyst', [createWorkspaceProvider({ projectRoot: root, agentRole: 'analyst', store, notifyCard: () => ({ ok: true }) })]);

      const result = await invokeTool(surface, 'write', { path: `record:///brief.md?card=${card.id}&v=next`, content: VALID_BRIEF });

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('requires runtime status stopped or paused');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows Analyst brief writes to running cards without ancestor propagation', async () => {
    const { root, store } = setupProject();
    try {
      const card = store.create({ type: 'goal', parent: 'project', title: 'Goal', brief: 'old', status: 'backlog', depth: 0, tags: [], priority: 1, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], retries: 0 });
      store.setStatus(card.id, 'running');
      const notifyCard = jest.fn(() => ({ ok: true as const }));
      const surface = buildInvocationSurface('analyst', [createWorkspaceProvider({ projectRoot: root, agentRole: 'analyst', store, notifyCard })]);

      const result = await invokeTool(surface, 'write', { path: `record:///brief.md?card=${card.id}&v=next`, content: VALID_BRIEF });

      expect(result.success).toBe(true);
      expect(store.read(card.id)?.status).toBe('running');
      expect((notifyCard.mock.calls as unknown as Array<[string, unknown]>).map((call) => call[0])).toEqual([card.id]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['backlog', 'changed', 'blocked', 'cancelled'] as const)('denies Analyst brief writes to %s cards before opening a new version', async (status) => {
    const { root, store } = setupProject();
    try {
      const card = store.create({ type: 'goal', parent: 'project', title: 'Goal', brief: 'old', status: 'backlog', depth: 0, tags: [], priority: 1, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], retries: 0 });
      if (status === 'changed') {
        store.setStatus(card.id, 'running');
        store.setStatus(card.id, 'changed');
      } else if (status === 'blocked') {
        store.setStatus(card.id, 'running');
        store.setStatus(card.id, 'blocked');
      } else if (status === 'cancelled') {
        store.setStatus(card.id, 'running');
        store.setStatus(card.id, 'cancelled');
      }
      const latestBefore = readRecordSlotIndex(root, card.id, 'brief').latest;
      const surface = buildInvocationSurface('analyst', [createWorkspaceProvider({ projectRoot: root, agentRole: 'analyst', store, notifyCard: () => ({ ok: true }) })]);

      const result = await invokeTool(surface, 'write', { path: `record:///brief.md?card=${card.id}&v=next`, content: VALID_BRIEF });

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('status done, failed, or running');
      const index = readRecordSlotIndex(root, card.id, 'brief');
      expect(index.latest).toBe(latestBefore);
      expect(index.open).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('denies Analyst brief writes without notification capability before creating a version', async () => {
    const { root, store } = setupProject();
    try {
      const card = store.create({ type: 'goal', parent: 'project', title: 'Goal', brief: 'old', status: 'backlog', depth: 0, tags: [], priority: 1, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], retries: 0 });
      markDone(store, card.id);
      const surface = buildInvocationSurface('analyst', [createWorkspaceProvider({ projectRoot: root, agentRole: 'analyst', store })]);

      const result = await invokeTool(surface, 'write', { path: `record:///brief.md?card=${card.id}&v=next`, content: VALID_BRIEF });

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('notification capability');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not mask missing Analyst card-store context as a model-visible tool error', async () => {
    const { root, store } = setupProject();
    try {
      const card = store.create({ type: 'goal', parent: 'project', title: 'Goal', brief: 'old', status: 'backlog', depth: 0, tags: [], priority: 1, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], retries: 0 });
      const surface = buildInvocationSurface('analyst', [createWorkspaceProvider({ projectRoot: root, agentRole: 'analyst' })]);

      await expect(invokeTool(surface, 'write', { path: `record:///brief.md?card=${card.id}&v=next`, content: VALID_BRIEF })).rejects.toThrow('Analyst record writes require a card store.');
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

      const result = await invokeTool(surface, 'read', { path: `system:///${file.replace(/^\/+/, '')}` });

      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toMatchObject({ path: `system:///${file.replace(/^\/+/, '')}`, content: 'outside content' });
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

      const systemUrl = `system:///${systemRoot.replace(/^\/+/, '')}`;
      const globResult = await invokeTool(surface, 'glob', { directory: systemUrl, pattern: '**/*.md' });
      const grepResult = await invokeTool(surface, 'grep', { path: systemUrl, pattern: 'UNIQUE_TOKEN' });

      expect(globResult.success).toBe(true);
      if (globResult.success) expect((globResult.data as { matches: string[] }).matches).toEqual([`system:///${join(systemRoot, 'nested', 'match.md').replace(/^\/+/, '')}`]);
      expect(grepResult.success).toBe(true);
      if (grepResult.success) {
        const matches = (grepResult.data as { matches: Array<{ path: string }> }).matches;
        expect(matches.map((match) => match.path)).toEqual([`system:///${join(systemRoot, 'nested', 'match.md').replace(/^\/+/, '')}`]);
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

      const ok = await invokeTool(surface, 'write', { path: `system:///${target.replace(/^\/+/, '')}`, content: 'ok' });
      const denied = await invokeTool(surface, 'write', { path: `system:///${join(systemRoot, '.env').replace(/^\/+/, '')}`, content: 'SECRET=1' });

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

  it('routes Analyst record edit through new brief version propagation', async () => {
    const { root, store } = setupProject();
    try {
      const card = store.create({ type: 'goal', parent: 'project', title: 'Goal', brief: 'old', status: 'backlog', depth: 0, tags: [], priority: 1, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], retries: 0 });
      await writeProject({ projectRoot: root, cardId: card.id, agentRole: 'planner' }, { path: 'record:///brief.md?v=next', content: VALID_BRIEF });
      closeOpenRecordSlot(root, { cardId: card.id, filename: 'brief.md', writer: 'planner' });
      markDone(store, card.id);
      const latestBefore = readRecordSlotIndex(root, card.id, 'brief').latest!;
      const notifyCard = jest.fn(() => ({ ok: false as const, reason: 'missing_card' as const, cardId: card.id }));
      const surface = buildInvocationSurface('analyst', [createWorkspaceProvider({ projectRoot: root, agentRole: 'analyst', store, notifyCard })]);

      const result = await invokeTool(surface, 'edit', { path: `record:///brief.md?card=${card.id}&v=next`, old_string: 'Do the work.', new_string: 'Do the updated work.' });

      expect(result.success).toBe(true);
      const latestAfter = readRecordSlotIndex(root, card.id, 'brief').latest!;
      expect(latestAfter).toBe(latestBefore + 1);
      if (result.success) expect(result.data).toMatchObject({ record_url: `record:///brief.md?card=${card.id}&v=${latestAfter}` });
      expect(readFileSync(join(root, '.saivage', 'outputs', 'cards', card.id, 'brief', `${latestAfter}.md`), 'utf8')).toContain('Do the updated work.');
      expect(store.read(card.id)?.status).toBe('changed');
      expect(notifyCard).toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails unsupported Analyst record edits without raw-writing record files', async () => {
    const { root, store } = setupProject();
    try {
      const card = store.create({ type: 'goal', parent: 'project', title: 'Goal', brief: 'old', status: 'backlog', depth: 0, tags: [], priority: 1, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], retries: 0 });
      markDone(store, card.id);
      const surface = buildInvocationSurface('analyst', [createWorkspaceProvider({ projectRoot: root, agentRole: 'analyst', store, notifyCard: () => ({ ok: true }) })]);

      const result = await invokeTool(surface, 'edit', { path: `record:///status.md?card=${card.id}&v=next`, old_string: 'old', new_string: 'updated' });

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('brief.md');
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

      const analystWrite = await invokeTool(analystSurface, 'write', { path: `system:///${target.replace(/^\/+/, '')}`, content: 'operator' });
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
      markDone(store, card.id);
      const surface = buildInvocationSurface('analyst', [createWorkspaceProvider({ projectRoot: root, agentRole: 'analyst', store, notifyCard: () => ({ ok: true }) })]);

      const write = await invokeTool(surface, 'write', { path: `record:///brief.md?card=${card.id}&v=next`, content: VALID_BRIEF });
      const read = await invokeTool(surface, 'read', { path: `record:///brief.md?card=${card.id}` });
      const recordDirectoryRead = await invokeTool(surface, 'read', { path: `record:///${card.id}` });
      const glob = await invokeTool(surface, 'glob', { directory: `record:///${card.id}`, pattern: '**/*.md' });
      const grep = await invokeTool(surface, 'grep', { path: `record:///${card.id}`, pattern: 'Acceptance Criteria' });

      expect(write.success).toBe(true);
      expect(read.success).toBe(true);
      if (read.success) expect(read.data).toMatchObject({ content: VALID_BRIEF, record_url: `record:///brief.md?card=${card.id}&v=2` });
      expect(recordDirectoryRead.success).toBe(true);
      if (recordDirectoryRead.success) expect(recordDirectoryRead.data).toMatchObject({ records: expect.arrayContaining([expect.objectContaining({ filename: 'brief.md', url: `record:///brief.md?card=${card.id}&v=2` })]) });
      expect(glob.success).toBe(true);
      if (glob.success) expect((glob.data as { matches: string[] }).matches).toContain(`record:///brief.md?card=${card.id}&v=2`);
      expect(grep.success).toBe(true);
      if (grep.success) {
        expect((grep.data as { matches: Array<{ path: string; preview: string }> }).matches).toEqual([
          expect.objectContaining({ path: `record:///brief.md?card=${card.id}&v=2`, preview: '# Acceptance Criteria' }),
        ]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves project roots and invalid grep regexes as model-visible tool results', async () => {
    const { root } = setupProject();
    try {
      writeFileSync(join(root, 'SPEC.md'), 'spec', 'utf8');
      const surface = buildInvocationSurface('executor', [createWorkspaceProvider({ projectRoot: root, cardId: 'card-1', agentRole: 'executor' })]);

      const read = await invokeTool(surface, 'read', { path: 'project:///' });
      const glob = await invokeTool(surface, 'glob', { directory: 'project:///', pattern: '**/*.md' });
      const nonScopedGrep = await invokeTool(surface, 'grep', { path: '.', pattern: 'spec' });
      const grep = await invokeTool(surface, 'grep', { pattern: '(unclosed' });

      expect(read.success).toBe(true);
      if (read.success) expect(read.data).toMatchObject({ entries: expect.arrayContaining([expect.objectContaining({ name: 'SPEC.md' })]) });
      expect(glob.success).toBe(true);
      if (glob.success) expect((glob.data as { matches: string[] }).matches).toContain('SPEC.md');
      expect(nonScopedGrep.success).toBe(true);
      if (nonScopedGrep.success) expect((nonScopedGrep.data as { matches: Array<{ path: string }> }).matches).toEqual([expect.objectContaining({ path: 'SPEC.md' })]);
      expect(grep.success).toBe(false);
      if (!grep.success) expect(grep.error).toContain('Invalid regular expression');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows Analyst tmp:// access for an explicit card without an active card context', async () => {
    const { root } = setupProject();
    try {
      const surface = buildInvocationSurface('analyst', [createWorkspaceProvider({ projectRoot: root, agentRole: 'analyst' })]);

      const write = await invokeTool(surface, 'write', { path: 'tmp:///card-1/notes.txt', content: 'temporary note' });
      const read = await invokeTool(surface, 'read', { path: 'tmp:///card-1/notes.txt' });

      expect(write.success).toBe(true);
      expect(read.success).toBe(true);
      if (read.success) expect(read.data).toMatchObject({ content: 'temporary note' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads work:/// files but rejects work writes and scoped patch paths', async () => {
    const { root } = setupProject();
    try {
      mkdirSync(join(root, '.saivage-work', 'processes', 'proc-1'), { recursive: true });
      writeFileSync(join(root, '.saivage-work', 'processes', 'proc-1', 'stdout.log'), 'runtime output Authorization: Bearer secret-token', 'utf8');
      const surface = buildInvocationSurface('executor', [
        createWorkspaceProvider({ projectRoot: root, cardId: 'card-1', agentRole: 'executor' }),
        createPatchProvider({ projectRoot: root, cardId: 'card-1', agentRole: 'executor' }),
      ]);

      const read = await invokeTool(surface, 'read', { path: 'work:///processes/proc-1/stdout.log' });
      const listing = await invokeTool(surface, 'read', { path: 'work:///processes' });
      const glob = await invokeTool(surface, 'glob', { directory: 'work:///processes', pattern: '**/*.log' });
      const grep = await invokeTool(surface, 'grep', { path: 'work:///processes', pattern: 'Authorization' });
      const write = await invokeTool(surface, 'write', { path: 'work:///processes/proc-1/stdout.log', content: 'no' });
      const patch = await invokeTool(surface, 'apply_patch', { patch: '--- /dev/null\n+++ b/work:///processes/proc-1/stdout.log\n@@ -0,0 +1 @@\n+bad\n' });

      expect(read.success).toBe(true);
      if (read.success) {
        expect(read.data).toMatchObject({ path: 'work:///processes/proc-1/stdout.log' });
        expect((read.data as { content: string }).content).toContain('[REDACTED]');
        expect((read.data as { content: string }).content).not.toContain('secret-token');
      }
      expect(listing.success).toBe(true);
      if (listing.success) expect((listing.data as { entries: Array<{ name: string }> }).entries.some((entry) => entry.name === 'proc-1')).toBe(true);
      expect(glob.success).toBe(true);
      if (glob.success) expect(glob.data).toMatchObject({ directory: 'work:///processes', matches: expect.arrayContaining(['work:///processes/proc-1/stdout.log']) });
      expect(grep.success).toBe(true);
      if (grep.success) expect((grep.data as { matches: Array<{ path: string; preview: string }> }).matches[0]).toEqual(expect.objectContaining({ path: 'work:///processes/proc-1/stdout.log', preview: expect.not.stringContaining('secret-token') }));
      expect(write.success).toBe(false);
      if (!write.success) expect(write.error).toContain('read-only');
      expect(patch.success).toBe(false);
      if (!patch.success) expect(patch.error).toContain('Unsafe patch path');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
