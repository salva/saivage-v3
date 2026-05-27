import type { FastifyInstance } from 'fastify';
import type { SaivageConfig } from '../../agents/config-api.js';
import type { ActiveRuntime } from '../../runtime/control-api.js';
import { setProjectNotificationDeliveryAdapters, clearProjectNotificationDeliveryAdapters } from '../../notifications/index.js';
import {
  TelegramBot,
  TelegramNotificationDeliveryAdapter,
  buildTelegramStartupDiagnosticSummary,
  evaluateTelegramRecipientReadiness,
  normalizeTelegramNotificationChatIds,
} from '../../telegram/index.js';

export async function startTelegramNotifications(options: {
  projectRoot: string;
  saivageConfig: SaivageConfig;
  fastify: FastifyInstance;
  activeRuntime?: ActiveRuntime;
}): Promise<TelegramBot | undefined> {
  const { projectRoot, saivageConfig, fastify, activeRuntime } = options;
  let telegramBot: TelegramBot | undefined;
  const botToken = saivageConfig.telegram?.botToken;
  const recipientRegistry = normalizeTelegramNotificationChatIds(saivageConfig.telegram?.notificationChatIds);

  if (recipientRegistry.invalidValues.length > 0) fastify.log.warn(`Telegram notification recipient config ignored ${recipientRegistry.invalidValues.length} invalid value(s)`);
  if (botToken) {
    try {
      if (!activeRuntime) throw new Error('Telegram bot requires ActiveRuntime.');
      telegramBot = new TelegramBot(projectRoot, activeRuntime, saivageConfig);
      await telegramBot.start();
      fastify.log.info('Telegram bot started');
    } catch (err) {
      fastify.log.warn(`Telegram bot initialization failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const telegramReadiness = evaluateTelegramRecipientReadiness({
    channels: saivageConfig.notifications?.channels,
    botToken,
    botAvailable: Boolean(telegramBot),
    recipients: recipientRegistry.recipients,
    invalidRecipientCount: recipientRegistry.invalidValues.length,
  });

  if (telegramReadiness.state === 'ready' && telegramBot) setProjectNotificationDeliveryAdapters(projectRoot, [new TelegramNotificationDeliveryAdapter(telegramBot, recipientRegistry.recipients)]);
  else clearProjectNotificationDeliveryAdapters(projectRoot);

  const diagnosticSummary = buildTelegramStartupDiagnosticSummary(telegramReadiness);
  if (diagnosticSummary) fastify.log.warn(diagnosticSummary);
  return telegramBot;
}
