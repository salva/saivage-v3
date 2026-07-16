import { describe, expect, it } from '@jest/globals';
import { queueNotification } from '../../src/notifications/index.js';

describe('card-only notification contract', () => {
  it('persists only through the addressed card port and returns its notification id', () => {
    const calls: Array<{ cardId: string; id: string }> = [];
    const result = queueNotification('project', 'operator', 'Recheck current facts.', { actor: 'analyst', surface: 'web-chat' }, (cardId, notification) => {
      calls.push({ cardId, id: notification.id });
      return { ok: true, notificationId: notification.id };
    });
    expect(result).toEqual({ ok: true, notificationId: calls[0]!.id });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cardId).toBe('project');
  });

  it('preserves exact terminal-card rejection without reporting acceptance', () => {
    expect(queueNotification('project', 'operator', 'late', { actor: 'analyst', surface: 'web-chat' }, (cardId) => ({ ok: false, reason: 'terminal_card', cardId, status: 'done' }))).toEqual({ ok: false, reason: 'terminal_card', cardId: 'project', status: 'done' });
  });
});
