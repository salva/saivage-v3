import { afterEach, expect, it } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { agentMessageSchema } from '../../src/schemas/index.js';
import { appendConversationBatch } from '../../src/persistence/conversation-file.js';
import { initProjectTree, TEST_WORKFLOWS } from '../helpers/canonical-project.js';
import { inventoryWorkGarbage, collectWorkGarbage } from '../../src/workspace/work-garbage-collector.js';
import { createWorkGcProgress } from '../../src/application/work-gc-progress.js';
import type { WorkGcProgress } from '../../src/contracts/work-gc.js';

let root: string;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });
it.each(['dry_run', 'delete'] as const)('observes existing completed inspections and every %s classification, not reserved temporary entries', async mode => {
  root = mkdtempSync(join(tmpdir(), 'gc-counts-')); initProjectTree(root);
  appendConversationBatch({ projectRoot: root }, [agentMessageSchema.parse({
    id: randomUUID(), session_id: 'agent:planner:project', role: 'user', kind: 'text',
    content: 'A retained current observation.',
    context_policy: { kind: 'content', storage: 'durable', replacement: { kind: 'retain' },
      audience: 'primary_and_summarizer', evidence: { kind: 'none' }, compactable: true },
    round_id: `r-user-${'0'.repeat(32)}`, message_index: 1, block_index: 0,
    timestamp: '2026-10-24T00:00:00.000Z',
  })]);
  function file(name: string, time: number) {
    const path = join(root, '.saivage/work', name);
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, 'abcd');
    utimesSync(path, time / 1000, time / 1000); return path;
  }
  file('cards/project/tmp/selected', 1000);
  file('cards/card-z/tmp/unlinked', 1100);
  const protectedPath = file('cards/project/tmp/protected', 1200);
  const stale = file('cards/project/tmp/stale', 1300);
  file('cards/project/tmp/target', 1400);
  file('cards/project/tmp/recent', 10000);
  file('cards/project/tmp/skipped.saivage-tmp', 1000);
  let time = 0;
  const snapshots: WorkGcProgress[] = [];
  const progress = createWorkGcProgress(value => snapshots.push(value), () => time += 1001)!;
  const inventory = await inventoryWorkGarbage(root, new AbortController().signal, progress);
  writeFileSync(stale, 'changed');
  const result = await collectWorkGarbage(inventory, { mode, before: 9000, targetBytes: 20 }, {
    progress, workflows: TEST_WORKFLOWS, operationalInputs: { path: protectedPath },
    protection: { retainAll: false, capturePaths: [] }, assertCollecting() {}, fatal(error): never { throw error; },
  });
  expect(result).toMatchObject({ observed_count: 6, observed_logical_bytes: 24,
    first_global_protection: null,
    retained: { opaque: 1, protected: 1, stale: 1, recent: 1, target: 1 },
    would_delete_count: mode === 'dry_run' ? 1 : 0,
    deleted_count: mode === 'delete' ? 1 : 0 });
  expect(snapshots.at(-1)).toMatchObject({ phase: 'selection', candidates_processed: 6,
    first_global_protection: null,
    observed_count: 6, observed_logical_bytes: 24, validated_cards: 1,
    ...(mode === 'dry_run' ? { would_delete_count: 1, would_delete_logical_bytes: 4 }
      : { deleted_count: 1, deleted_logical_bytes: 4 }) });
  expect(snapshots.at(-1)!.validated_segments).toBeGreaterThan(0);
  expect(snapshots.at(-1)!.validated_records).toBeGreaterThan(0);
  expect(new Set(snapshots.map(value => value.phase))).toEqual(new Set(['inventory', 'validation_marking', 'selection']));
});
