import { describe, expect, it, jest } from '@jest/globals';
import { submitNotificationTool } from '../../src/tools/tool-api.js';
import type { NotificationSubmissionPort } from '../../src/runtime/runtime-api.js';
import { uuidV4Schema } from '../../src/schemas/index.js';

describe('notification tool submission ownership', () => {
  const input = { card_id: 'project', kind: 'finding', body: 'evidence', urgency: 'urgent' } as const;

  it('constructs a fresh UUID immediately for the held port and carries the same identity into its receipt', async () => {
    const signal = new AbortController().signal;
    const before = Date.now();
    const submit = jest.fn<NotificationSubmissionPort>(async (cardId, notification, urgency, passedSignal) => {
      expect(cardId).toBe(input.card_id);
      expect(notification).toMatchObject({ content: input.body, source: input.kind });
      expect(Date.parse(notification.created_at)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(notification.created_at)).toBeLessThanOrEqual(Date.now());
      expect(uuidV4Schema.parse(notification.id)).toBe(notification.id);
      expect(urgency).toBe(input.urgency);
      expect(passedSignal).toBe(signal);
      return { queued: true, cardId, notificationId: notification.id, interruption: { status: 'not_requested' } };
    });
    const result = await submitNotificationTool(input, submit, signal);
    expect(result).toEqual({
      kind: 'succeeded',
      data: { queued: true, card_id: 'project', notification_id: submit.mock.calls[0]![1].id, body: input.body, interruption: { status: 'not_requested' } },
    });
    expect(submit).toHaveBeenCalledTimes(1);
    await submitNotificationTool(input, submit, signal);
    expect(submit.mock.calls[1]![1].id).not.toBe(submit.mock.calls[0]![1].id);
  });

  it.each([
    { queued: false as const, reason: 'missing_card' as const, cardId: 'project' },
    { queued: false as const, reason: 'terminal_card' as const, cardId: 'project', status: 'done' as const },
    { queued: false as const, reason: 'activation_closed' as const, cardId: 'project' },
  ])('projects $reason without reporting acceptance', async (portResult) => {
    const submit = jest.fn<NotificationSubmissionPort>(async () => portResult);
    const result = await submitNotificationTool(input, submit, new AbortController().signal);
    expect(result).toMatchObject({ kind: 'failed', data: { queued: false, reason: portResult.reason, card_id: 'project' } });
    expect(submit).toHaveBeenCalledTimes(1);
  });
});
