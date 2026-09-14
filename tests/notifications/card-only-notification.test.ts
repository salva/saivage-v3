import { describe, expect, it } from '@jest/globals';
import { queueNotification } from '../../src/notifications/index.js';

describe('card-only notification contract', () => {
  it('persists only through the addressed submission port and returns its notification id', async () => {
    const calls: Array<{ cardId: string; id: string }> = [];
    const result = await queueNotification('project', 'operator', 'Recheck current facts.', 'normal', async (cardId, notification) => {
      calls.push({ cardId, id: notification.id });
      return { queued: true, cardId, notificationId: 'port-selected-id', interruption: { status: 'not_requested' } };
    });
    expect(result).toEqual({ queued: true, cardId: 'project', notificationId: 'port-selected-id', interruption: { status: 'not_requested' } });
    if (!result.queued) throw new Error('Expected success.');
    expect(result.notificationId).not.toBe(calls[0]!.id);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cardId).toBe('project');
  });

  it('preserves exact terminal-card rejection without reporting acceptance', async () => {
    await expect(queueNotification('project', 'operator', 'late', 'urgent', async (cardId) => ({ queued: false, reason: 'terminal_card', cardId, status: 'done' }))).resolves.toEqual({ queued: false, reason: 'terminal_card', cardId: 'project', status: 'done' });
  });

  it.each([
    { queued: false as const, reason: 'missing_card' as const, cardId: 'project' },
    { queued: false as const, reason: 'terminal_card' as const, cardId: 'project', status: 'failed' as const },
    { queued: false as const, reason: 'activation_closed' as const, cardId: 'project' },
  ])('passes through $reason without normalization', async (portResult) => {
    await expect(queueNotification('project', 'operator', 'late', 'normal', async () => portResult)).resolves.toBe(portResult);
  });
});
