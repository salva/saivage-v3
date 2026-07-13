import { initProjectTree, CardStore, testConfigAuthority } from '../helpers/canonical-project.js';
import { describe, it, expect } from '@jest/globals';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';


import { list_card_history, get_card_history_entry, diff_card, get_card } from '../../src/tools/analyst-card-tools.js';
import type { ToolContext } from '../../src/tools/analyst-tool-types.js';

import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { createTestProcessRunner } from '../helpers/test-process-runner.js';

function setup(root: string): CardStore {
  initProjectTree(root);
  return new CardStore(root);
}

function ctx(root: string, store: CardStore): ToolContext { const processRunner = createTestProcessRunner(root); return { projectRoot: root, configAuthority: testConfigAuthority(root), mutationAuthority: () => store.currentMutationAuthority(), processRunner, processScope: processRunner.createDirectScope(processRunner.runtimeRootScope, 'test-executor', 'runtime_card'), store, actor: 'executor', surface: 'runtime', sessionId: 'sess-1', restartServerAvailable: false }; }

describe('card history and notes tools', () => {
  it('lists history, gets an entry, diffs versions, without audit writes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wave-f-history-tools-'));
    try {
      const store = setup(root);
      const goal = store.create({ type: 'goal', parent: 'project', depth: 0, title: 'goal', brief: 'Goal brief.', status: 'backlog', tags: [], priority: 1, position: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], retries: 0 } as any);
      const code = store.create({ type: 'code', parent: goal.id, depth: 0, title: 'before', brief: 'old', status: 'backlog', tags: [], priority: 1, position: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], retries: 0 } as any);
      store.mutateCard(code.id, { title: 'after', priority: 2 }, { actor: 'analyst', surface: 'web-chat', reason: 'operator edit' });
      const toolCtx = ctx(root, store);
      const history = await list_card_history(toolCtx, { cardId: code.id });
      expect(history.success).toBe(true);
      expect((history.data as Array<{ version_seq: number }>)).toHaveLength(1);
      expect((history.data as Array<{ version_seq: number }>)[0]?.version_seq).toBe(1);

      const entry = await get_card_history_entry(toolCtx, { cardId: code.id, version_seq: 1 });
      expect(entry.success).toBe(true);
      expect((entry.data as { snapshot: { title: string; priority: number } }).snapshot.title).toBe('before');
      expect((entry.data as { snapshot: { title: string; priority: number } }).snapshot.priority).toBe(1);

      const diff = await diff_card(toolCtx, { cardId: code.id });
      expect(diff.success).toBe(true);
      const fields = (diff.data as { diff: Array<{ field: string }> }).diff.map((item) => item.field);
      expect(fields).toEqual(expect.arrayContaining(['priority','title']));


      const auditPath = join(root, '.saivage', 'runtime', 'control-actions.jsonl');
      expect(existsSync(auditPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns exposed record summaries by filename without exposing card.json', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wave4-card-read-model-'));
    try {
      const store = setup(root);
      const code = store.create({ type: 'code', parent: 'project', depth: 0, title: 'task', brief: 'brief body', status: 'backlog', tags: [], priority: 1, position: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], retries: 0 } as any);
      const openStatus = store.openRecord(code.id, 'status.md');
      store.editRecord(code.id, 'status.md', openStatus.version, 'latest status narrative');
      store.closeRecord(code.id, 'status.md', openStatus.version, 'executor', code.version_seq);

      const result = await get_card(ctx(root, store), { id: code.id });

      expect(result.success).toBe(true);
      const data = result.data as { effective_updated_at: string; records: Array<{ filename: string; inline?: { content: string } }>; records_by_filename: Record<string, { filename: string; inline?: { content: string }; modifiedAt?: string }> };
      expect(data.records.map((record) => record.filename)).toEqual(['brief.md', 'status.md', 'review.md']);
      expect(data.records_by_filename['brief.md']?.inline?.content).toContain('brief body');
      expect(data.records_by_filename['status.md']?.inline?.content).toBe('latest status narrative');
      expect(data.effective_updated_at).toBe(data.records_by_filename['status.md']?.modifiedAt);
      expect(data.records_by_filename['card.json']).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
