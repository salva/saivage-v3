import { afterEach, expect, it } from '@jest/globals';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { basename, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { agentMessageSchema } from '../../src/schemas/index.js';
import { appendConversationBatch } from '../../src/persistence/conversation-file.js';
import { CardService, initProjectTree, TEST_WORKFLOWS } from '../helpers/canonical-project.js';
import { inventoryWorkGarbage, collectWorkGarbage } from '../../src/workspace/work-garbage-collector.js';
import { createObservedWorkGcProgress, createWorkGcProgress } from '../../src/application/work-gc-progress.js';
import { WorkGcStatusSchema, type WorkGcActiveStatus, type WorkGcProgress } from '../../src/contracts/work-gc.js';
import { compactWorkGcCard } from '../helpers/work-gc-compaction.js';

let root: string;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });
it.each(['dry_run', 'delete'] as const)('observes existing completed inspections and every %s classification, not reserved temporary entries', async mode => {
  root = mkdtempSync(join(tmpdir(), 'gc-counts-')); initProjectTree(root);
  compactWorkGcCard(root, TEST_WORKFLOWS);
  appendConversationBatch({ projectRoot: root }, [agentMessageSchema.parse({
    id: randomUUID(), session_id: 'agent:planner:project', role: 'user', kind: 'text',
    content: 'A retained current observation.',
    context_policy: { kind: 'content', storage: 'durable', replacement: { kind: 'retain' },
      audience: 'primary_and_summarizer', evidence: { kind: 'none' }, compactable: true },
    round_id: `r-user-${'0'.repeat(32)}`, message_index: 1, block_index: 0,
    timestamp: '2026-10-24T00:00:00.000Z',
  })]);
  function file(name: string, time: number, content = 'abcd') {
    const path = join(root, '.saivage/work', name);
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content);
    utimesSync(path, time / 1000, time / 1000); return path;
  }
  file('cards/project/tmp/selected', 1000);
  file('cards/card-z/tmp/unlinked', 1100);
  const protectedPath = file('cards/project/tmp/protected', 1200);
  const stale = file('cards/project/tmp/stale', 1300);
  file('cards/project/tmp/target', 1400);
  file('cards/project/tmp/small', 1500, 'abc');
  file('cards/project/tmp/recent', 10000);
  file('cards/project/tmp/skipped.saivage-tmp', 1000);
  let time = 0;
  const snapshots: WorkGcProgress[] = [];
  const progress = createWorkGcProgress(value => snapshots.push(value), () => time += 1001)!;
  const inventory = await inventoryWorkGarbage(root, new AbortController().signal, progress);
  writeFileSync(stale, 'abc');
  utimesSync(stale, 1.3, 1.3);
  const result = await collectWorkGarbage(inventory, { mode, before: 9000, targetBytes: 23, minFileBytes: 4 }, {
    progress, workflows: TEST_WORKFLOWS, operationalInputs: { path: protectedPath },
    protection: { retainAll: false, capturePaths: [] }, assertCollecting() {}, fatal(error): never { throw error; },
  });
  expect(result).toMatchObject({ observed_count: 7, observed_logical_bytes: 27,
    first_global_protection: null,
    retained: { opaque: 1, protected: 1, stale: 1, recent: 1, target: 1, below_min_file_bytes: 1 },
    would_delete_count: mode === 'dry_run' ? 1 : 0,
    deleted_count: mode === 'delete' ? 1 : 0 });
  expect(snapshots.at(-1)).toMatchObject({ phase: 'selection', candidates_processed: 7,
    first_global_protection: null,
    observed_count: 7, observed_logical_bytes: 27, inspected_cards: 1,
    ...(mode === 'dry_run' ? { would_delete_count: 1, would_delete_logical_bytes: 4 }
      : { deleted_count: 1, deleted_logical_bytes: 4 }) });
  expect(snapshots.at(-1)!.inspected_sessions).toBeGreaterThan(0);
  expect(snapshots.at(-1)!.inspected_records).toBeGreaterThan(0);
  expect(new Set(snapshots.map(value => value.phase))).toEqual(new Set(['inventory', 'retention_marking', 'selection']));
});

it.each(['matcher', 'quoted prose'] as const)('samples advancing %s visits inside one unfinished record', async kind => {
  root = mkdtempSync(join(tmpdir(), 'gc-record-checkpoints-'));
  initProjectTree(root);
  compactWorkGcCard(root, TEST_WORKFLOWS);
  const work = join(root, '.saivage/work');
  const directory = join(work, 'cards/project/tmp/private-fixture-scope');
  const count = kind === 'matcher' ? 800 : 2;
  mkdirSync(directory, { recursive: true });
  for (let index = 0; index < count; index++) {
    const path = join(directory, `file-${index}.txt`);
    writeFileSync(path, 'synthetic work');
    utimesSync(path, 1, 1);
  }
  let time = 0;
  const { progress, read } = createObservedWorkGcProgress('delete', undefined, () => time);
  const inventory = await inventoryWorkGarbage(root, new AbortController().signal, progress);
  // Use actual inventory order so the matcher cannot find its useful candidate early.
  const kept = join(work, inventory.candidates.at(-1)!.path);
  const removed = join(work, inventory.candidates[0]!.path);
  const marker = 'private-fixture-record';
  const content = kind === 'matcher'
    ? `${marker} directory=${JSON.stringify(directory)}, pattern="?${basename(kept).slice(1)}"`
    : `${Array.from({ length: 800 }, (_, i) => `label="${marker}-${i}"`).join('\n')}\nKeep \`work:///${inventory.candidates.at(-1)!.path}\`.`;
  new CardService(root).acceptRecord('project', 'review-private-fixture.md', content, { kind: 'agent', agent: 'analyst' });

  const snapshots: WorkGcActiveStatus[] = [];
  let sampled = 0;
  const result = await collectWorkGarbage(inventory, { mode: 'delete' }, {
    progress, workflows: TEST_WORKFLOWS, operationalInputs: {},
    protection: { retainAll: false, capturePaths: [] },
    assertCollecting() {
      // The existing cancellation check immediately after the visit's yield observes
      // that batch before the next part of the record can run.
      time++;
      const status = read();
      const visits = status.counters.reference_visits ?? 0;
      if (visits === sampled) return;
      sampled = visits;
      if (status.substep === 'record_projection') snapshots.push(status);
    },
    fatal(error): never { throw error; },
  });
  expect(snapshots.length).toBeGreaterThanOrEqual(2);
  const [first, second] = snapshots;
  expect(first!.phase).toBe('retention_marking');
  expect(second!.counters.inspected_records).toBe(first!.counters.inspected_records);
  expect(second!.counters.reference_visits! - first!.counters.reference_visits!).toBe(256);
  expect(second!.last_checkpoint_elapsed_ms).toBeGreaterThan(first!.last_checkpoint_elapsed_ms);
  for (const active of snapshots) expect(WorkGcStatusSchema.parse({ active })).toEqual({ active });
  for (const raw of [marker, directory, basename(kept), 'review-private-fixture.md'])
    expect(JSON.stringify(snapshots)).not.toContain(raw);
  expect(result).toMatchObject({ first_global_protection: null, retained: { protected: 1 }, deleted_count: count - 1 });
  expect(existsSync(kept)).toBe(true);
  expect(existsSync(removed)).toBe(false);
});
