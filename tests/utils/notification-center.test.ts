import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/utils/file-tree.js';
import { NotificationCenter } from '../../src/utils/notification-center.js';

describe('NotificationCenter', () => {
  let projectRoot: string;
  let center: NotificationCenter;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-notification-center-'));
    initProjectTree(projectRoot);
    center = new NotificationCenter(projectRoot);
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function enqueue(id: string, sessionId = 'sess-1', severity: 'info' | 'warn' | 'block' = 'warn') {
    return center.enqueueForSession(sessionId, {
      id,
      kind: 'card_changed',
      severity,
      payload_summary: `summary-${id}`,
      related_card_id: 'card-1',
      related_version_seq: 2,
      source_actor: 'analyst',
      source_surface: 'web-chat',
    });
  }

  it('enqueue/drain/mark/acknowledge round trip is latest-entry-wins and drain is idempotent', () => {
    enqueue('n-1');
    expect(center.drainPendingForSession('sess-1').map((item) => item.id)).toEqual(['n-1']);
    expect(center.drainPendingForSession('sess-1').map((item) => item.id)).toEqual(['n-1']);
    center.markDeliveredForSession('sess-1', ['n-1']);
    expect(center.drainPendingForSession('sess-1')).toEqual([]);
    expect(center.hasBlockingPendingForSession('sess-1')).toBe(false);
    const acked = center.acknowledge('sess-1', 'n-1');
    expect(acked?.acknowledged_at).toEqual(expect.any(String));
  });

  it('preserves ordering across multiple records and blocking queries only return unacknowledged block items', () => {
    enqueue('n-1', 'sess-1', 'warn');
    enqueue('n-2', 'sess-1', 'block');
    enqueue('n-3', 'sess-1', 'block');
    expect(center.drainPendingForSession('sess-1').map((item) => item.id)).toEqual(['n-1', 'n-2', 'n-3']);
    expect(center.hasBlockingPendingForSession('sess-1')).toBe(true);
    expect(center.listUnacknowledgedBlockingForSession('sess-1').map((item) => item.id)).toEqual(['n-2', 'n-3']);
    center.acknowledge('sess-1', 'n-2');
    expect(center.listUnacknowledgedBlockingForSession('sess-1').map((item) => item.id)).toEqual(['n-3']);
  });

  it('operator notifications are independent from session queues', () => {
    enqueue('n-1', 'sess-1');
    center.enqueueForOperator({
      id: 'op-1',
      kind: 'runtime_state',
      severity: 'info',
      payload_summary: 'runtime paused',
      source_actor: 'analyst',
      source_surface: 'web-ui',
    });
    expect(center.drainPendingForSession('sess-1').map((item) => item.id)).toEqual(['n-1']);
    expect(center.listForOperator().map((item) => item.id)).toEqual(['op-1']);
    center.acknowledgeForOperator('op-1');
    expect(center.listForOperator()[0]?.acknowledged_at).toEqual(expect.any(String));
    expect(center.drainPendingForSession('sess-1').map((item) => item.id)).toEqual(['n-1']);
  });

  it('is restart-safe by reopening and replaying pending state from disk', () => {
    enqueue('n-1', 'sess-99', 'block');
    center.markDeliveredForSession('sess-99', []);
    const reopened = new NotificationCenter(projectRoot);
    expect(reopened.drainPendingForSession('sess-99').map((item) => item.id)).toEqual(['n-1']);
    expect(reopened.hasBlockingPendingForSession('sess-99')).toBe(true);
  });
});
