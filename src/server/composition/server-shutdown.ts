import type { FastifyInstance } from 'fastify';
import type { ActiveRuntime } from '../../runtime/index.js';
import type { McpManager } from '../../mcp/index.js';
import type { TelegramBot } from '../../telegram/index.js';
import { clearProjectNotificationDeliveryAdapters } from '../../notifications/index.js';
import { resetChatRouteState } from '../routes/chats-files-debug.js';
import { resetRuntimeEventSubscriptions, resetWebSocketState } from '../websocket.js';

export async function stopServerResources(options: {
  projectRoot: string;
  fastify: FastifyInstance;
  activeRuntime?: ActiveRuntime;
  mcpManager?: McpManager;
  telegramBot?: TelegramBot;
}): Promise<void> {
  const { projectRoot, fastify, activeRuntime, mcpManager, telegramBot } = options;
  resetChatRouteState(projectRoot);
  resetWebSocketState(projectRoot);
  clearProjectNotificationDeliveryAdapters(projectRoot);
  if (activeRuntime) resetRuntimeEventSubscriptions(activeRuntime.runtime);

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
    if (activeRuntime) {
      try {
        await activeRuntime.stop();
        fastify.log.info('ActiveRuntime stopped');
      } catch (err) {
        fastify.log.warn(`ActiveRuntime stop failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
