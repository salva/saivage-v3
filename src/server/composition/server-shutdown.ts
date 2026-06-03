import type { FastifyInstance } from 'fastify';
import type { RuntimeApplication } from '../../application/runtime-composition.js';
import type { McpManager } from '../../mcp/manager-api.js';
import type { TelegramBot } from '../../telegram/index.js';
import { clearProjectNotificationDeliveryAdapters } from '../../notifications/index.js';
import { resetChatRouteState } from '../routes/chats-files-debug.js';
import { resetRuntimeEventSubscriptions, resetWebSocketState } from '../websocket.js';

export async function stopServerResources(options: {
  projectRoot: string;
  fastify: FastifyInstance;
  runtimeApplication?: RuntimeApplication;
  mcpManager?: McpManager;
  telegramBot?: TelegramBot;
}): Promise<void> {
  const { projectRoot, fastify, runtimeApplication, mcpManager, telegramBot } = options;
  resetChatRouteState(projectRoot);
  resetWebSocketState(projectRoot);
  clearProjectNotificationDeliveryAdapters(projectRoot);
  if (runtimeApplication) resetRuntimeEventSubscriptions(runtimeApplication.runtimeApi);

  try {
    await fastify.close();
  } finally {
    if (telegramBot) {
      try {
        await telegramBot.stop();
        fastify.log.info('Telegram bot stopped');
      } catch (err) {
        fastify.log.warn(`Telegram bot stop failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (mcpManager) {
      try {
        await mcpManager.stopAll();
        fastify.log.info('MCP manager stopped');
      } catch (err) {
        fastify.log.warn(`MCP manager stop failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (runtimeApplication) {
      try {
        await runtimeApplication.runtimeApi.shutdown();
        fastify.log.info('Runtime application stopped');
      } catch (err) {
        fastify.log.warn(`Runtime application stop failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
