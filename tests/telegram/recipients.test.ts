import { describe, it, expect } from '@jest/globals';
import {
  buildTelegramStartupDiagnosticSummary,
  evaluateTelegramRecipientReadiness,
  normalizeTelegramNotificationChatIds,
} from '../../src/telegram/recipients.js';

describe('Telegram recipient registry', () => {
  it('normalizes, deduplicates, and preserves positive and negative safe chat ids', () => {
    expect(normalizeTelegramNotificationChatIds([111111, -222222, 111111, 333333])).toEqual({
      recipients: [111111, -222222, 333333],
      invalidValues: [],
    });
  });

  it('rejects blank, non-integer, zero, string, and unsafe chat ids', () => {
    const result = normalizeTelegramNotificationChatIds([0, 1.2, '111111', true, {}, Number.MAX_SAFE_INTEGER + 1, 444444]);
    expect(result.recipients).toEqual([444444]);
    expect(result.invalidValues).toHaveLength(6);
  });

  it('computes readiness states and secret-safe diagnostics without ids or tokens', () => {
    const missingRecipients = evaluateTelegramRecipientReadiness({
      channels: ['telegram'],
      botToken: '123456:TEST_TOKEN',
      botAvailable: true,
      recipients: [],
    });
    expect(missingRecipients.state).toBe('missing_recipients');
    const summary = buildTelegramStartupDiagnosticSummary(missingRecipients);
    expect(summary).toContain('missing_recipients');
    expect(summary).toContain('recipients=0');
    expect(summary).not.toContain('123456:TEST_TOKEN');
    expect(summary).not.toContain('111111');

    expect(evaluateTelegramRecipientReadiness({ channels: ['telegram'], recipients: [111111] }).state).toBe('missing_bot_token');
    expect(evaluateTelegramRecipientReadiness({ channels: ['telegram'], botToken: '123456:TEST_TOKEN', botAvailable: true, recipients: [111111] }).state).toBe('ready');
  });
});
