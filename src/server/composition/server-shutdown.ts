import type { FastifyInstance } from 'fastify';
import type { RuntimeApplication } from '../../application/runtime-composition.js';
import type { McpManager } from '../../mcp/manager-api.js';
import type { TelegramBot } from '../../telegram/index.js';
import { clearProjectNotificationDeliveryAdapters } from '../../notifications/index.js';
import type { LiveSyncSocket } from '../live-sync-socket.js';
import type { SyncHub } from '../sync-hub.js';

export async function stopServerResources(options: {
  projectRoot: string;
  fastify: FastifyInstance;
  runtimeApplication?: RuntimeApplication;
  mcpManager?: McpManager;
  telegramBot?: TelegramBot;
  liveSyncSocket?: LiveSyncSocket;
  syncHub?: SyncHub;
}): Promise<void> {
  const { projectRoot, fastify, runtimeApplication, mcpManager, telegramBot, liveSyncSocket, syncHub } = options;
  liveSyncSocket?.dispose();
  clearProjectNotificationDeliveryAdapters(projectRoot);
  if (runtimeApplication) syncHub?.dispose(runtimeApplication.runtimeApi);

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
