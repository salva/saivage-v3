import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { NotificationCenter } from '../../src/notifications/notification-center.js';

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

  it('recreates pending, delivered, and acknowledged state without duplicating latest user-visible records for the same id', () => {
    enqueue('n-1', 'sess-1', 'block');
    enqueue('n-2', 'sess-1', 'warn');
    center.markDeliveredForSession('sess-1', ['n-1']);
    center.acknowledge('sess-1', 'n-1');

    const path = join(projectRoot, '.saivage', 'runtime', 'notifications', 'by-session', 'sess-1.jsonl');
    const rawLines = readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean);
    expect(rawLines).toHaveLength(4);

    const reopened = new NotificationCenter(projectRoot);
    expect(reopened.drainPendingForSession('sess-1').map((item) => item.id)).toEqual(['n-2']);
    expect(reopened.hasBlockingPendingForSession('sess-1')).toBe(false);
    expect(reopened.listUnacknowledgedBlockingForSession('sess-1')).toEqual([]);

    const latestN1 = reopened.acknowledge('sess-1', 'n-1');
    expect(latestN1?.delivered_at).toEqual(expect.any(String));
    expect(latestN1?.acknowledged_at).toEqual(expect.any(String));
    expect(reopened.markDeliveredForSession('sess-1', ['n-1'])).toEqual([]);
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

  it('operator notifications are independent from session queues and latest-entry-per-id wins after recreation', () => {
    enqueue('n-1', 'sess-1');
    center.enqueueForOperator({
      id: 'op-1',
      kind: 'runtime_state',
      severity: 'info',
      payload_summary: 'runtime paused',
      source_actor: 'analyst',
      source_surface: 'web-ui',
    });
    center.acknowledgeForOperator('op-1');

    const reopened = new NotificationCenter(projectRoot);
    expect(reopened.drainPendingForSession('sess-1').map((item) => item.id)).toEqual(['n-1']);
    expect(reopened.listForOperator().map((item) => item.id)).toEqual(['op-1']);
    expect(reopened.listForOperator()[0]?.acknowledged_at).toEqual(expect.any(String));
    expect(reopened.drainPendingForSession('sess-1').map((item) => item.id)).toEqual(['n-1']);
  });

  it('is restart-safe by reopening and replaying pending state from disk without pre-marking delivery', () => {
    enqueue('n-1', 'sess-99', 'block');
    const reopened = new NotificationCenter(projectRoot);
    const firstDrain = reopened.drainPendingForSession('sess-99');
    const secondDrain = reopened.drainPendingForSession('sess-99');
    expect(firstDrain.map((item) => item.id)).toEqual(['n-1']);
    expect(secondDrain.map((item) => item.id)).toEqual(['n-1']);
    expect(reopened.hasBlockingPendingForSession('sess-99')).toBe(true);
    reopened.markDeliveredForSession('sess-99', ['n-1']);
    const afterMark = new NotificationCenter(projectRoot);
    expect(afterMark.drainPendingForSession('sess-99')).toEqual([]);
    expect(afterMark.hasBlockingPendingForSession('sess-99')).toBe(true);
  });
});

describe('NotificationDeliveryService canonical fan-out', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-notification-delivery-'));
    initProjectTree(projectRoot);
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('persists canonical NotificationCenter records before invoking delivery adapters', async () => {
    const { NotificationDeliveryService } = await import('../../src/notifications/notification-delivery.js');
    const delivered: Array<{ id: string; target: string; sessionId?: string }> = [];
    const center = new NotificationCenter(projectRoot);
    const service = new NotificationDeliveryService(center, [{
      name: 'capture',
      deliver(record, context) {
        delivered.push({ id: record.id, target: context.target, sessionId: context.sessionId });
      },
    }]);

    service.enqueueForSession('sess-canonical', {
      id: 'canonical-1',
      kind: 'runtime_state',
      severity: 'block',
      payload_summary: 'Runtime paused with token [REDACTED]',
      source_actor: 'runtime',
      source_surface: 'rest',
    });
    service.enqueueForOperator({
      id: 'canonical-op-1',
      kind: 'runtime_state',
      severity: 'info',
      payload_summary: 'Runtime resumed',
      source_actor: 'runtime',
      source_surface: 'rest',
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(center.drainPendingForSession('sess-canonical')[0]?.id).toBe('canonical-1');
    expect(center.listForOperator()[0]?.id).toBe('canonical-op-1');
    expect(delivered).toEqual([
      { id: 'canonical-1', target: 'session', sessionId: 'sess-canonical' },
      { id: 'canonical-op-1', target: 'operator' },
    ]);
  });
});

describe('TelegramNotificationDeliveryAdapter', () => {
  it('sends durable records once per normalized synthetic recipient and skips startup diagnostics', async () => {
    const { TelegramNotificationDeliveryAdapter } = await import('../../src/telegram/recipients.js');
    const sendDurableNotification = jest.fn(async () => {});
    const adapter = new TelegramNotificationDeliveryAdapter({ sendDurableNotification } as never, [111111, -222222]);
    const record = {
      id: 'n-telegram-1',
      session_id: null,
      kind: 'runtime_state',
      severity: 'warn',
      payload_summary: 'runtime warning',
      source_actor: 'runtime',
      source_surface: 'rest',
      created_at: new Date().toISOString(),
      delivered_at: null,
      acknowledged_at: null,
    } as const;
    await adapter.deliver(record, { target: 'operator' });
    expect(sendDurableNotification).toHaveBeenCalledTimes(2);
    expect(sendDurableNotification).toHaveBeenNthCalledWith(1, 111111, record);
    expect(sendDurableNotification).toHaveBeenNthCalledWith(2, -222222, record);

    await adapter.deliver({ ...record, id: 'telegram-startup-missing_recipients', payload_summary: 'Telegram notification readiness: missing_recipients; recipients=0' }, { target: 'operator' });
    expect(sendDurableNotification).toHaveBeenCalledTimes(2);
  });
});
