/**
 * Notification Router Tests
 *
 * Verifies:
 * - shouldSend filters correctly by min_severity and categories
 * - NotificationRouter reads notifications config section
 * - Web channel broadcasts via WebSocket broadcast()
 * - Telegram channel sends via TelegramBot.sendNotification()
 * - createNotificationRouter wires up channels correctly
 * - reload() refreshes config from disk
 * - Unknown severities are handled gracefully
 */

import { describe, it, expect, afterEach, beforeAll, jest } from '@jest/globals';
import {
  writeFileSync,
  mkdirSync,
  rmSync,
  mkdtempSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type {
  NotificationEvent,
  SeverityLevel,
} from '../../src/notifications/notification-router.js';

// ═══════════════════════════════════════════════════════════════
// Mocks
// ═══════════════════════════════════════════════════════════════

const mockBroadcast = jest.fn();

jest.unstable_mockModule('../../src/server/websocket.js', () => ({
  broadcast: mockBroadcast,
}));

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

let testRoots: string[] = [];

function makeProjectRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'saivage-notif-test-'));
  testRoots.push(dir);
  return dir;
}

function writeSaivageJson(projectRoot: string, overrides: Record<string, unknown>): void {
  const saivageDir = join(projectRoot, '.saivage');
  mkdirSync(saivageDir, { recursive: true });
  const config = {
    server: { port: 8080, host: '0.0.0.0' },
    ...overrides,
  };
  writeFileSync(join(saivageDir, 'saivage.json'), JSON.stringify(config, null, 2));
}

function makeEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    category: 'goal_completed',
    severity: 'info',
    title: 'Test Event',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

afterEach(() => {
  mockBroadcast.mockClear();
  for (const dir of testRoots) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
  testRoots = [];
});

// ═══════════════════════════════════════════════════════════════
// Dynamic imports (for tests that need the mock to be applied)
// ═══════════════════════════════════════════════════════════════

/**
 * Import the notification-router module dynamically.
 * This MUST be called after jest.unstable_mockModule for the mock to apply.
 */
async function importModule() {
  return await import('../../src/notifications/notification-router.js');
}

// ═══════════════════════════════════════════════════════════════
// SEVERITY_ORDER
// ═══════════════════════════════════════════════════════════════

describe('SEVERITY_ORDER', () => {
  it('has info as the lowest severity', async () => {
    const { SEVERITY_ORDER } = await importModule();
    expect(SEVERITY_ORDER[0]).toBe('info');
  });

  it('has critical as the highest severity', async () => {
    const { SEVERITY_ORDER } = await importModule();
    expect(SEVERITY_ORDER[SEVERITY_ORDER.length - 1]).toBe('critical');
  });

  it('contains exactly four levels in ascending order', async () => {
    const { SEVERITY_ORDER } = await importModule();
    expect(SEVERITY_ORDER).toEqual(['info', 'warning', 'error', 'critical']);
  });
});

// ═══════════════════════════════════════════════════════════════
// shouldSend
// ═══════════════════════════════════════════════════════════════

describe('shouldSend', () => {
  let shouldSend: (event: NotificationEvent, filters?: import('../../src/notifications/notification-router.js').NotificationFilter) => boolean;

  beforeAll(async () => {
    const mod = await importModule();
    shouldSend = mod.shouldSend;
  });

  it('returns true when no filters are defined', () => {
    expect(shouldSend(makeEvent(), undefined)).toBe(true);
  });

  it('returns true when filters is an empty object', () => {
    expect(shouldSend(makeEvent(), {})).toBe(true);
  });

  it('passes events at or above min_severity', () => {
    const filters = { min_severity: 'warning' as SeverityLevel };
    expect(shouldSend(makeEvent({ severity: 'warning' }), filters)).toBe(true);
    expect(shouldSend(makeEvent({ severity: 'error' }), filters)).toBe(true);
    expect(shouldSend(makeEvent({ severity: 'critical' }), filters)).toBe(true);
  });

  it('rejects events below min_severity', () => {
    const filters = { min_severity: 'warning' as SeverityLevel };
    expect(shouldSend(makeEvent({ severity: 'info' }), filters)).toBe(false);
  });

  it('passes all when min_severity is info (lowest)', () => {
    const filters = { min_severity: 'info' as SeverityLevel };
    expect(shouldSend(makeEvent({ severity: 'info' }), filters)).toBe(true);
    expect(shouldSend(makeEvent({ severity: 'critical' }), filters)).toBe(true);
  });

  it('only passes critical when min_severity is critical', () => {
    const filters = { min_severity: 'critical' as SeverityLevel };
    expect(shouldSend(makeEvent({ severity: 'info' }), filters)).toBe(false);
    expect(shouldSend(makeEvent({ severity: 'warning' }), filters)).toBe(false);
    expect(shouldSend(makeEvent({ severity: 'error' }), filters)).toBe(false);
    expect(shouldSend(makeEvent({ severity: 'critical' }), filters)).toBe(true);
  });

  it('passes events whose category is in the list', () => {
    const filters = { categories: ['goal_completed', 'goal_failed'] };
    expect(shouldSend(makeEvent({ category: 'goal_completed' }), filters)).toBe(true);
    expect(shouldSend(makeEvent({ category: 'goal_failed' }), filters)).toBe(true);
  });

  it('rejects events whose category is not in the list', () => {
    const filters = { categories: ['goal_completed'] };
    expect(shouldSend(makeEvent({ category: 'escalation' }), filters)).toBe(false);
  });

  it('passes all when categories is an empty array', () => {
    const filters = { categories: [] };
    expect(shouldSend(makeEvent({ category: 'anything' }), filters)).toBe(true);
  });

  it('passes all when categories is absent', () => {
    const filters = { min_severity: 'info' as SeverityLevel };
    expect(shouldSend(makeEvent({ category: 'anything' }), filters)).toBe(true);
  });

  it('applies AND logic: both min_severity and categories must pass', () => {
    const filters = {
      min_severity: 'error' as SeverityLevel,
      categories: ['goal_failed', 'escalation'],
    };
    expect(shouldSend(makeEvent({ severity: 'error', category: 'escalation' }), filters)).toBe(true);
    expect(shouldSend(makeEvent({ severity: 'error', category: 'goal_completed' }), filters)).toBe(false);
    expect(shouldSend(makeEvent({ severity: 'warning', category: 'goal_failed' }), filters)).toBe(false);
    expect(shouldSend(makeEvent({ severity: 'info', category: 'review_complete' }), filters)).toBe(false);
  });

  it('handles unknown severity strings gracefully (treats as info)', () => {
    const filters = { min_severity: 'warning' as SeverityLevel };
    // @ts-expect-error — testing unknown severity
    expect(shouldSend(makeEvent({ severity: 'unknown' }), filters)).toBe(false);
  });

  it('handles unknown severity with no min_severity filter', () => {
    // @ts-expect-error — testing unknown severity
    expect(shouldSend(makeEvent({ severity: 'unknown' }), undefined)).toBe(true);
  });

  it('passes with min_severity set and categories set but empty', () => {
    const filters = { min_severity: 'error' as SeverityLevel, categories: [] };
    expect(shouldSend(makeEvent({ severity: 'error', category: 'anything' }), filters)).toBe(true);
    expect(shouldSend(makeEvent({ severity: 'warning', category: 'anything' }), filters)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// notificationToEnvelope
// ═══════════════════════════════════════════════════════════════

describe('notificationToEnvelope', () => {
  let notificationToEnvelope: (event: NotificationEvent) => import('../../src/server/websocket.js').WsEnvelope;

  beforeAll(async () => {
    const mod = await importModule();
    notificationToEnvelope = mod.notificationToEnvelope;
  });

  it('maps goal_failed to error type', () => {
    const env = notificationToEnvelope(makeEvent({ category: 'goal_failed' }));
    expect(env.type).toBe('error');
  });

  it('maps card_failed to error type', () => {
    const env = notificationToEnvelope(makeEvent({ category: 'card_failed' }));
    expect(env.type).toBe('error');
  });

  it('maps goal_completed to status type', () => {
    const env = notificationToEnvelope(makeEvent({ category: 'goal_completed' }));
    expect(env.type).toBe('status');
  });

  it('maps escalation to status type', () => {
    const env = notificationToEnvelope(makeEvent({ category: 'escalation' }));
    expect(env.type).toBe('status');
  });

  it('maps review_complete to status type', () => {
    const env = notificationToEnvelope(makeEvent({ category: 'review_complete' }));
    expect(env.type).toBe('status');
  });

  it('maps plan_updated to status type', () => {
    const env = notificationToEnvelope(makeEvent({ category: 'plan_updated' }));
    expect(env.type).toBe('status');
  });

  it('maps unknown categories to status type', () => {
    const env = notificationToEnvelope(makeEvent({ category: 'some_unknown_event' }));
    expect(env.type).toBe('status');
  });

  it('includes all event fields in content', () => {
    const event = makeEvent({
      category: 'goal_completed',
      severity: 'warning',
      title: 'Task Done',
      details: 'Details here',
      cardId: 'card-123',
      attachments: ['file1.txt'],
      timestamp: '2025-01-01T00:00:00Z',
    });
    const env = notificationToEnvelope(event);
    expect(env.content.event).toBe('goal_completed');
    expect(env.content.severity).toBe('warning');
    expect(env.content.title).toBe('Task Done');
    expect(env.content.details).toBe('Details here');
    expect(env.content.cardId).toBe('card-123');
    expect(env.content.attachments).toEqual(['file1.txt']);
    expect(env.content.timestamp).toBe('2025-01-01T00:00:00Z');
  });

  it('generates a timestamp when none is provided', () => {
    const event = makeEvent();
    delete event.timestamp;
    const env = notificationToEnvelope(event);
    expect(env.content.timestamp).toBeDefined();
    expect(typeof env.content.timestamp).toBe('string');
  });
});

// ═══════════════════════════════════════════════════════════════
// NotificationRouter — config loading
// ═══════════════════════════════════════════════════════════════

describe('NotificationRouter config loading', () => {
  let NotificationRouter: new (root: string) => import('../../src/notifications/notification-router.js').NotificationRouter;

  beforeAll(async () => {
    const mod = await importModule();
    NotificationRouter = mod.NotificationRouter;
  });

  it('reads the notifications config section from saivage.json', () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, {
      notifications: {
        channels: ['web', 'telegram'],
        filters: {
          min_severity: 'warning',
          categories: ['goal_completed', 'goal_failed'],
        },
      },
    });

    const router = new NotificationRouter(root);
    const config = router.getConfig();

    expect(config.channels).toEqual(['web', 'telegram']);
    expect(config.filters?.min_severity).toBe('warning');
    expect(config.filters?.categories).toEqual(['goal_completed', 'goal_failed']);
  });

  it('defaults channels to [web] when notifications section is absent', () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, {});

    const router = new NotificationRouter(root);
    const config = router.getConfig();

    expect(config.channels).toEqual(['web']);
    expect(config.filters).toBeUndefined();
  });

  it('uses safe defaults when saivage.json is missing', () => {
    const root = makeProjectRoot();
    const router = new NotificationRouter(root);
    const config = router.getConfig();

    expect(config.channels).toEqual(['web']);
    expect(config.filters).toBeUndefined();
  });

  it('reads filters with only min_severity', () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, {
      notifications: {
        channels: ['web'],
        filters: { min_severity: 'error' },
      },
    });

    const router = new NotificationRouter(root);
    const config = router.getConfig();

    expect(config.filters?.min_severity).toBe('error');
    expect(config.filters?.categories).toBeUndefined();
  });

  it('reads filters with only categories', () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, {
      notifications: {
        channels: ['web'],
        filters: { categories: ['escalation'] },
      },
    });

    const router = new NotificationRouter(root);
    const config = router.getConfig();

    expect(config.filters?.min_severity).toBe('info');
    expect(config.filters?.categories).toEqual(['escalation']);
  });

  it('defaults min_severity to info when filter exists but no min_severity', () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, {
      notifications: {
        channels: ['web'],
        filters: { categories: ['goal_completed'] },
      },
    });

    const router = new NotificationRouter(root);
    expect(router.getConfig().filters?.min_severity).toBe('info');
  });
});

// ═══════════════════════════════════════════════════════════════
// NotificationRouter — reload
// ═══════════════════════════════════════════════════════════════

describe('NotificationRouter reload', () => {
  let NotificationRouter: new (root: string) => import('../../src/notifications/notification-router.js').NotificationRouter;

  beforeAll(async () => {
    const mod = await importModule();
    NotificationRouter = mod.NotificationRouter;
  });

  it('reloads config from disk', () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, { notifications: { channels: ['web'] } });

    const router = new NotificationRouter(root);
    expect(router.getConfig().channels).toEqual(['web']);

    writeSaivageJson(root, {
      notifications: {
        channels: ['telegram'],
        filters: { min_severity: 'error' },
      },
    });

    router.reload();

    expect(router.getConfig().channels).toEqual(['telegram']);
    expect(router.getConfig().filters?.min_severity).toBe('error');
  });

  it('reload preserves registered channel handlers', () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, { notifications: { channels: ['web'] } });

    const router = new NotificationRouter(root);
    const handler = jest.fn(async () => {});
    router.registerChannel('custom', handler);

    writeSaivageJson(root, { notifications: { channels: ['web', 'custom'] } });
    router.reload();

    expect(router.getConfig().channels).toEqual(['web', 'custom']);
  });
});

// ═══════════════════════════════════════════════════════════════
// NotificationRouter — publish
// ═══════════════════════════════════════════════════════════════

describe('NotificationRouter publish', () => {
  let NotificationRouter: new (root: string) => import('../../src/notifications/notification-router.js').NotificationRouter;

  beforeAll(async () => {
    const mod = await importModule();
    NotificationRouter = mod.NotificationRouter;
  });

  it('routes events to all configured channels', async () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, { notifications: { channels: ['web', 'telegram'] } });

    const router = new NotificationRouter(root);
    const webHandler = jest.fn(async () => {});
    const tgHandler = jest.fn(async () => {});

    router.registerChannel('web', webHandler);
    router.registerChannel('telegram', tgHandler);

    const event = makeEvent({ category: 'goal_completed', severity: 'info' });
    await router.publish(event);

    expect(webHandler).toHaveBeenCalledTimes(1);
    expect(webHandler).toHaveBeenCalledWith(event);
    expect(tgHandler).toHaveBeenCalledTimes(1);
    expect(tgHandler).toHaveBeenCalledWith(event);
  });

  it('skips channels that are not in the config', async () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, { notifications: { channels: ['web'] } });

    const router = new NotificationRouter(root);
    const webHandler = jest.fn(async () => {});
    const tgHandler = jest.fn(async () => {});

    router.registerChannel('web', webHandler);
    router.registerChannel('telegram', tgHandler);

    const event = makeEvent();
    await router.publish(event);

    expect(webHandler).toHaveBeenCalledTimes(1);
    expect(tgHandler).not.toHaveBeenCalled();
  });

  it('does not route when event is filtered out', async () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, {
      notifications: {
        channels: ['web'],
        filters: { min_severity: 'warning', categories: ['escalation'] },
      },
    });

    const router = new NotificationRouter(root);
    const handler = jest.fn(async () => {});
    router.registerChannel('web', handler);

    await router.publish(makeEvent({ severity: 'info', category: 'goal_completed' }));
    expect(handler).not.toHaveBeenCalled();
  });

  it('routes events that pass filters', async () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, {
      notifications: {
        channels: ['web'],
        filters: { min_severity: 'warning', categories: ['escalation'] },
      },
    });

    const router = new NotificationRouter(root);
    const handler = jest.fn(async () => {});
    router.registerChannel('web', handler);

    await router.publish(makeEvent({ severity: 'error', category: 'escalation' }));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('handles channel handler errors without crashing', async () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, { notifications: { channels: ['web', 'telegram'] } });

    const router = new NotificationRouter(root);
    const failingHandler = jest.fn(async () => {
      throw new Error('Channel down');
    });
    const successHandler = jest.fn(async () => {});

    router.registerChannel('web', failingHandler);
    router.registerChannel('telegram', successHandler);

    const event = makeEvent();
    await router.publish(event);

    expect(failingHandler).toHaveBeenCalledTimes(1);
    expect(successHandler).toHaveBeenCalledTimes(1);
  });

  it('does not route to channels with no registered handler', async () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, { notifications: { channels: ['web', 'sms'] } });

    const router = new NotificationRouter(root);
    const webHandler = jest.fn(async () => {});
    router.registerChannel('web', webHandler);

    const event = makeEvent();
    await router.publish(event);

    expect(webHandler).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// createNotificationRouter — web channel
// ═══════════════════════════════════════════════════════════════

describe('createNotificationRouter — web channel', () => {
  it('registers the web channel that calls broadcast()', async () => {
    mockBroadcast.mockClear();

    const root = makeProjectRoot();
    writeSaivageJson(root, { notifications: { channels: ['web'] } });

    const { createNotificationRouter } = await importModule();

    const router = createNotificationRouter(root);
    const event = makeEvent({ category: 'escalation', severity: 'error' });
    await router.publish(event);

    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    const envelope = mockBroadcast.mock.calls[0][0] as { type: string; content: Record<string, unknown> };
    expect(envelope.type).toBe('status');
    expect(envelope.content.event).toBe('escalation');
  });
});

// ═══════════════════════════════════════════════════════════════
// createNotificationRouter — telegram channel
// ═══════════════════════════════════════════════════════════════

describe('createNotificationRouter — telegram channel', () => {
  it('registers telegram channel when TelegramBot is provided', async () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, { notifications: { channels: ['telegram'] } });

    const sendNotificationMock = jest.fn(async () => {});
    const fakeBot = {
      sendDurableNotification: sendNotificationMock,
    } as unknown as import('../../src/telegram/bot.js').TelegramBot;

    const { createNotificationRouter } = await importModule();

    const router = createNotificationRouter(root, fakeBot, [123456, 789012]);

    const event = makeEvent({
      category: 'goal_failed',
      severity: 'error',
      title: 'Build Failed',
      cardId: 'card-abc',
      attachments: ['log.txt'],
      details: 'Compilation error',
    });

    await router.publish(event);

    expect(sendNotificationMock).toHaveBeenCalledTimes(2);
    expect(sendNotificationMock).toHaveBeenNthCalledWith(1, 123456, expect.objectContaining({
      kind: 'card_changed',
      severity: 'warn',
      payload_summary: 'Build Failed: Compilation error',
      related_card_id: 'card-abc',
    }), {
      title: 'Build Failed',
      attachments: ['log.txt'],
    });
    expect(sendNotificationMock).toHaveBeenNthCalledWith(2, 789012, expect.objectContaining({
      kind: 'card_changed',
      severity: 'warn',
      payload_summary: 'Build Failed: Compilation error',
      related_card_id: 'card-abc',
    }), {
      title: 'Build Failed',
      attachments: ['log.txt'],
    });
  });

  it('skips telegram registration when no TelegramBot is provided', async () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, { notifications: { channels: ['web', 'telegram'] } });

    const { createNotificationRouter } = await importModule();

    const router = createNotificationRouter(root);
    const config = router.getConfig();
    expect(config.channels).toEqual(['web', 'telegram']);

    const event = makeEvent();
    await expect(router.publish(event)).resolves.toBeUndefined();
  });

  it('skips telegram registration when chat IDs are empty', async () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, { notifications: { channels: ['telegram'] } });

    const sendNotificationMock = jest.fn(async () => {});
    const fakeBot = {
      sendDurableNotification: sendNotificationMock,
    } as unknown as import('../../src/telegram/bot.js').TelegramBot;

    const { createNotificationRouter } = await importModule();

    createNotificationRouter(root, fakeBot, []);
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════
// registerChannel
// ═══════════════════════════════════════════════════════════════

describe('registerChannel', () => {
  let NotificationRouter: new (root: string) => import('../../src/notifications/notification-router.js').NotificationRouter;

  beforeAll(async () => {
    const mod = await importModule();
    NotificationRouter = mod.NotificationRouter;
  });

  it('allows registering custom channels beyond web and telegram', async () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, { notifications: { channels: ['web', 'slack'] } });

    const router = new NotificationRouter(root);
    const slackHandler = jest.fn(async () => {});

    router.registerChannel('slack', slackHandler);

    const event = makeEvent();
    await router.publish(event);

    expect(slackHandler).toHaveBeenCalledTimes(1);
  });

  it('overwrites an existing handler for the same channel name', async () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, { notifications: { channels: ['web'] } });

    const router = new NotificationRouter(root);
    const handler1 = jest.fn(async () => {});
    const handler2 = jest.fn(async () => {});

    router.registerChannel('web', handler1);
    router.registerChannel('web', handler2);

    await router.publish(makeEvent());

    expect(handler1).not.toHaveBeenCalled();
    expect(handler2).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// getConfig
// ═══════════════════════════════════════════════════════════════

describe('getConfig', () => {
  let NotificationRouter: new (root: string) => import('../../src/notifications/notification-router.js').NotificationRouter;

  beforeAll(async () => {
    const mod = await importModule();
    NotificationRouter = mod.NotificationRouter;
  });

  it('returns the current config snapshot', () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, {
      notifications: {
        channels: ['web'],
        filters: { min_severity: 'error', categories: ['goal_failed'] },
      },
    });

    const router = new NotificationRouter(root);
    const config = router.getConfig();

    expect(config.channels).toEqual(['web']);
    expect(config.filters).toEqual({
      min_severity: 'error',
      categories: ['goal_failed'],
    });
  });
});

describe('NotificationRouter durable compatibility mapping', () => {
  it('maps legacy severities and categories to durable NotificationCenter semantics explicitly', async () => {
    const { mapLegacyEventToDurableNotification } = await importModule();

    expect(mapLegacyEventToDurableNotification(makeEvent({ category: 'escalation', severity: 'critical', title: 'Stop', details: 'Needs operator' }))).toMatchObject({
      kind: 'card_changed',
      severity: 'block',
      payload_summary: 'Stop: Needs operator',
    });
    expect(mapLegacyEventToDurableNotification(makeEvent({ category: 'process_reconciled_dead', severity: 'error', title: 'Process dead' }))).toMatchObject({
      kind: 'process_state',
      severity: 'warn',
    });
    expect(mapLegacyEventToDurableNotification(makeEvent({ category: 'resumed', severity: 'info', title: 'Runtime resumed' }))).toMatchObject({
      kind: 'runtime_state',
      severity: 'info',
    });
  });
});
