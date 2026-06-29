/**
 * Smoke test for cleanup.ts
 *
 * Verifies the safe cleanup utility operates correctly:
 * - cleanCardTmp removes only cards/<id>/tmp/
 * - cleanStaleStash removes old files, keeps new files
 * - Cleanup never touches durable records, downloads, quarantine
 * - cleanStaleProcessOutput respects running registry status
 * - Stale previews/uploads are cleaned up
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { initProjectTree } from '../../src/persistence/file-tree.js';
import { CardStore } from '../../src/cards/card-store.js';
import {
  cleanCardTmp,
  cleanStaleStash,
  cleanStalePreviews,
  cleanStaleUploads,
  cleanStaleProcessOutput,
  cleanAll,
} from '../../src/runtime/cleanup.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Cleanup Utility Smoke Tests', () => {
  let root: string;
  let store: CardStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cleanup-'));
    initProjectTree(root);
    store = new CardStore(root);
  });

  afterEach(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
    }
  });

  function saivageWorkDir(): string {
    return join(root, '.saivage-work');
  }

  it('cleanCardTmp: removes cards/<id>/tmp/ directory', () => {
    const swd = saivageWorkDir();
    const cardId = 'test-card-1';
    const tmpDir = join(swd, 'cards', cardId, 'tmp');
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'scratch.txt'), 'temp data');

    expect(existsSync(tmpDir)).toBe(true);
    const result = cleanCardTmp(swd, cardId);
    expect(result).toBe(true);
    expect(existsSync(tmpDir)).toBe(false);
  });

  it('cleanCardTmp: returns false for nonexistent card tmp', () => {
    const swd = saivageWorkDir();
    const result = cleanCardTmp(swd, 'nonexistent');
    expect(result).toBe(false);
  });

  it('cleanCardTmp: does NOT touch durable card records', () => {
    const swd = saivageWorkDir();
    const cardId = 'card-protected';
    const recordDir = join(root, '.saivage', 'outputs', 'cards', cardId, 'status');
    mkdirSync(recordDir, { recursive: true });
    writeFileSync(join(recordDir, '1.md'), 'durable status');
    const tmpDir = join(swd, 'cards', cardId, 'tmp');
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'temp.txt'), 'temp');

    cleanCardTmp(swd, cardId);

    expect(existsSync(tmpDir)).toBe(false);
    expect(existsSync(recordDir)).toBe(true);
    expect(existsSync(join(recordDir, '1.md'))).toBe(true);
  });

  it('cleanStaleStash: removes files older than maxAgeMs', async () => {
    const swd = saivageWorkDir();
    const stashDir = join(swd, 'tmp', 'stash');
    mkdirSync(stashDir, { recursive: true });
    writeFileSync(join(stashDir, 'old.txt'), 'old data');
    await sleep(100);
    const removed = cleanStaleStash(swd, 1);
    expect(removed).toBe(1);
    expect(existsSync(join(stashDir, 'old.txt'))).toBe(false);
  });

  it('cleanStaleStash: keeps newer files', () => {
    const swd = saivageWorkDir();
    const stashDir = join(swd, 'tmp', 'stash');
    mkdirSync(stashDir, { recursive: true });
    writeFileSync(join(stashDir, 'new.txt'), 'new data');
    const removed = cleanStaleStash(swd, 24 * 60 * 60 * 1000);
    expect(removed).toBe(0);
    expect(existsSync(join(stashDir, 'new.txt'))).toBe(true);
  });

  it('cleanStalePreviews: removes old preview files', async () => {
    const swd = saivageWorkDir();
    const previewsDir = join(swd, 'tmp', 'previews');
    mkdirSync(previewsDir, { recursive: true });
    writeFileSync(join(previewsDir, 'old-preview.png'), 'preview data');
    await sleep(100);
    const removed = cleanStalePreviews(swd, 1);
    expect(removed).toBe(1);
    expect(existsSync(join(previewsDir, 'old-preview.png'))).toBe(false);
  });

  it('cleanStaleUploads: removes old upload files', async () => {
    const swd = saivageWorkDir();
    const uploadsDir = join(swd, 'tmp', 'uploads');
    mkdirSync(uploadsDir, { recursive: true });
    writeFileSync(join(uploadsDir, 'old-upload.bin'), 'upload data');
    await sleep(100);
    const removed = cleanStaleUploads(swd, 1);
    expect(removed).toBe(1);
  });

  it('cleanStaleProcessOutput: removes old completed process dirs', async () => {
    const swd = saivageWorkDir();
    const procDir = join(swd, 'processes', 'proc-test-1');
    mkdirSync(procDir, { recursive: true });
    writeFileSync(join(procDir, 'combined.log'), 'process output');
    await sleep(150);
    const cleaned = cleanStaleProcessOutput({ saivageWorkDir: swd, store, maxAgeMs: 1 });
    expect(cleaned).toBe(1);
    expect(existsSync(procDir)).toBe(false);
  });

  it('cleanStaleProcessOutput: ignores malformed legacy process registry files as cleanup blockers', async () => {
    const swd = saivageWorkDir();
    const procId = 'proc-legacy-running-1';
    const procDir = join(swd, 'processes', procId);
    mkdirSync(procDir, { recursive: true });
    writeFileSync(join(procDir, 'combined.log'), 'legacy running');
    const registryPath = join(root, '.saivage', 'runtime', 'processes.json');
    writeFileSync(registryPath, JSON.stringify([{ id: procId, status: 'running' }], null, 2));
    await sleep(150);

    expect(() => cleanStaleProcessOutput({ saivageWorkDir: swd, store, maxAgeMs: 1 })).toThrow(/ProcessRecord registry validation failed/);
    expect(existsSync(procDir)).toBe(true);
    expect(existsSync(registryPath)).toBe(true);
  });

  it('cleanAll: returns summary counts', () => {
    const swd = saivageWorkDir();
    const card = store.create({
      type: 'code',
      parent: 'project',
      title: 'card-with-tmp',
      brief: 'test',
      status: 'done',
      lifecycle: {
        status: 'done',
        result: { kind: 'planner_done', summary: 'done' },
        error: null,
        completed_at: new Date().toISOString(),
      },
      depends_on: [],
      priority: 1,
      tags: [],
      urgency: 'normal',
      created_by: 'planner',
      related: [],
      retries: 0,
      depth: 0,
    });

    const cardTmp = join(swd, 'cards', card.id, 'tmp');
    mkdirSync(cardTmp, { recursive: true });
    writeFileSync(join(cardTmp, 'junk.txt'), 'junk');

    const result = cleanAll(swd, store);
    expect(result.cardTmpCleaned).toBe(1);
  });

  it('cleanCardTmp: does NOT remove entire cards/ subtree', () => {
    const swd = saivageWorkDir();
    const cardId = 'safe-card';
    const scratchSibling = join(swd, 'cards', cardId, 'scratch');
    mkdirSync(scratchSibling, { recursive: true });
    writeFileSync(join(scratchSibling, 'keep.txt'), 'do not delete');
    const tmpDir = join(swd, 'cards', cardId, 'tmp');
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'temp.txt'), 'temp');

    cleanCardTmp(swd, cardId);

    expect(existsSync(tmpDir)).toBe(false);
    expect(existsSync(scratchSibling)).toBe(true);
    expect(existsSync(join(scratchSibling, 'keep.txt'))).toBe(true);
  });

  it('cleanAll: does not touch downloads/ or quarantine/', () => {
    const swd = saivageWorkDir();
    const dlDir = join(swd, 'downloads', 'dl-test');
    mkdirSync(dlDir, { recursive: true });
    writeFileSync(join(dlDir, 'review.json'), 'download review');
    writeFileSync(join(dlDir, 'meta.json'), 'download meta');
    const qDir = join(swd, 'quarantine', 'q-test');
    mkdirSync(qDir, { recursive: true });
    writeFileSync(join(qDir, 'meta.json'), 'quarantine meta');

    cleanAll(swd, store);

    expect(existsSync(join(dlDir, 'review.json'))).toBe(true);
    expect(existsSync(join(dlDir, 'meta.json'))).toBe(true);
    expect(existsSync(join(qDir, 'meta.json'))).toBe(true);
  });
});
