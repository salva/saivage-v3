import { describe, expect, it } from '@jest/globals';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeOpenRecordSlot, discardOpenRecordSlot, openRecordSlot, readRecordSlotIndex } from '../../src/runtime/records/record-slots.js';

function withTempProject<T>(fn: (projectRoot: string) => T): T {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-record-slots-'));
  try { return fn(projectRoot); } finally { rmSync(projectRoot, { recursive: true, force: true }); }
}

describe('record slots', () => {
  it('opens, reuses, and closes slot-local versions', () => withTempProject((projectRoot) => {
    const first = openRecordSlot(projectRoot, { cardId: 'card-1', filename: 'status.md' });
    const reused = openRecordSlot(projectRoot, { cardId: 'card-1', filename: 'status.md' });
    expect(reused.recordUrl).toBe(first.recordUrl);
    writeFileSync(first.absolutePath, 'done', 'utf8');

    const closed = closeOpenRecordSlot(projectRoot, { cardId: 'card-1', filename: 'status.md' });
    expect(closed.recordUrl).toBe('record://status.md?card=card-1&v=1');
    expect(readRecordSlotIndex(projectRoot, 'card-1', 'status')).toMatchObject({ latest: 1, open: null });

    const second = openRecordSlot(projectRoot, { cardId: 'card-1', filename: 'status.md' });
    expect(second.recordUrl).toBe('record://status.md?card=card-1&v=2');
  }));

  it('discards stale open records without advancing latest', () => withTempProject((projectRoot) => {
    const first = openRecordSlot(projectRoot, { cardId: 'card-1', filename: 'review.md' });
    writeFileSync(first.absolutePath, 'stale', 'utf8');
    const discarded = discardOpenRecordSlot(projectRoot, { cardId: 'card-1', filename: 'review.md', reason: 'stale_review' });

    expect(discarded?.recordUrl).toBe('record://review.md?card=card-1&v=1');
    expect(readRecordSlotIndex(projectRoot, 'card-1', 'review')).toMatchObject({ latest: null, open: null, versions: { '1': { status: 'discarded' } } });
    expect(existsSync(first.absolutePath)).toBe(true);
    expect(openRecordSlot(projectRoot, { cardId: 'card-1', filename: 'review.md' }).recordUrl).toBe('record://review.md?card=card-1&v=2');
  }));
});
