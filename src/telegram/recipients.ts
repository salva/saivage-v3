import type { NotificationRecord } from '../schemas/types.js';
import type { NotificationDeliveryAdapter, NotificationDeliveryContext } from '../utils/notification-delivery.js';
import type { TelegramBot } from './bot.js';

export type TelegramReadinessState = 'channel_not_enabled' | 'missing_bot_token' | 'missing_recipients' | 'ready';

export interface TelegramRecipientRegistry {
  recipients: number[];
  invalidValues: unknown[];
}

export interface TelegramRecipientReadiness {
  state: TelegramReadinessState;
  channelEnabled: boolean;
  botTokenConfigured: boolean;
  botAvailable: boolean;
  recipientCount: number;
  invalidRecipientCount: number;
}

export function normalizeTelegramNotificationChatIds(raw: unknown): TelegramRecipientRegistry {
  if (raw === undefined || raw === null) return { recipients: [], invalidValues: [] };
  if (!Array.isArray(raw)) return { recipients: [], invalidValues: [raw] };
  const seen = new Set<number>();
  const recipients: number[] = [];
  const invalidValues: unknown[] = [];
  for (const value of raw) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value === 0) {
      invalidValues.push(value);
      continue;
    }
    if (!seen.has(value)) {
      seen.add(value);
      recipients.push(value);
    }
  }
  return { recipients, invalidValues };
}

export function evaluateTelegramRecipientReadiness(input: {
  channels?: string[];
  botToken?: string;
  botAvailable?: boolean;
  recipients?: number[];
  invalidRecipientCount?: number;
}): TelegramRecipientReadiness {
  const channelEnabled = input.channels?.includes('telegram') ?? false;
  const botTokenConfigured = Boolean(input.botToken);
  const botAvailable = Boolean(input.botAvailable);
  const recipientCount = input.recipients?.length ?? 0;
  const invalidRecipientCount = input.invalidRecipientCount ?? 0;
  let state: TelegramReadinessState = 'channel_not_enabled';
  if (channelEnabled) {
    if (!botTokenConfigured || !botAvailable) state = 'missing_bot_token';
    else if (recipientCount === 0) state = 'missing_recipients';
    else state = 'ready';
  } else if (recipientCount > 0 && (!botTokenConfigured || !botAvailable)) {
    state = 'missing_bot_token';
  } else if (botTokenConfigured && botAvailable && recipientCount === 0) {
    state = 'missing_recipients';
  }
  return { state, channelEnabled, botTokenConfigured, botAvailable, recipientCount, invalidRecipientCount };
}

export function buildTelegramStartupDiagnosticSummary(readiness: TelegramRecipientReadiness): string | null {
  if (readiness.state === 'ready' || readiness.state === 'channel_not_enabled') return null;
  const parts = [
    `Telegram notification readiness: ${readiness.state}`,
    `channel=${readiness.channelEnabled ? 'enabled' : 'disabled'}`,
    `bot=${readiness.botTokenConfigured && readiness.botAvailable ? 'available' : 'unavailable'}`,
    `recipients=${readiness.recipientCount}`,
  ];
  if (readiness.invalidRecipientCount > 0) parts.push(`invalid_recipients=${readiness.invalidRecipientCount}`);
  return parts.join('; ');
}

export function isTelegramStartupDiagnostic(record: NotificationRecord): boolean {
  return record.id.startsWith('telegram-startup-') || record.payload_summary.includes('Telegram notification readiness:');
}

export class TelegramNotificationDeliveryAdapter implements NotificationDeliveryAdapter {
  readonly name = 'telegram';

  constructor(
    private readonly bot: Pick<TelegramBot, 'sendDurableNotification'>,
    private readonly recipients: number[],
  ) {}

  async deliver(record: NotificationRecord, _context: NotificationDeliveryContext): Promise<void> {
    if (isTelegramStartupDiagnostic(record)) return;
    for (const chatId of this.recipients) {
      await this.bot.sendDurableNotification(chatId, record);
    }
  }
}
