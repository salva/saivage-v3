/**
 * Core Fastify server module.
 *
 * Provides:
 *  - Fastify instance creation with logger, CORS, static files
 *  - Auth plugin registration
 *  - /health endpoint (no auth, reads actual runtime state)
 *  - All route registrations (cards, runtime/config/notes, chats/files/debug)
 *  - WebSocket endpoint registration
 *  - MCP server manager lifecycle
 *  - Telegram bot lifecycle
 *  - Notification router with WebSocket broadcast integration
 *  - MCP status API endpoint
 *  - startServer() / stopServer() lifecycle functions
 *  - Server config read from saivage.json
 */

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import authPlugin from './auth.js';
import { registerCardRoutes } from './routes/cards.js';
import { registerRuntimeConfigNotesRoutes } from './routes/runtime-config-notes.js';
import { registerChatsFilesDebugRoutes } from './routes/chats-files-debug.js';
import { registerWebSocket } from './websocket.js';
import { loadConfig, type SaivageConfig } from '../agents/config-schema.js';
import { McpManager } from '../mcp/index.js';
import { TelegramBot } from '../telegram/index.js';
import { createNotificationRouter } from '../notifications/index.js';
import type { NotificationRouter } from '../notifications/index.js';

// ── Types ─────────────────────────────────────────────────────

export interface ServerConfig {
  host: string;
  port: number;
  projectRoot: string;
}

export interface ServerInstance {
  fastify: FastifyInstance;
  config: ServerConfig;
  saivageConfig: SaivageConfig;
  mcpManager?: McpManager;
  telegramBot?: TelegramBot;
  notificationRouter?: NotificationRouter;
  stop: () => Promise<void>;
}

// ── Health Endpoint ───────────────────────────────────────────

function registerHealth(fastify: FastifyInstance, _saivageConfig: SaivageConfig): void {
  fastify.get('/health', async (_request, _reply) => {
    let runtimeStatus = 'unknown';

    // Read actual runtime state from .saivage/runtime/state.json
    try {
      const { readRuntimeState } = await import('../utils/runtime-state.js');
      const state = readRuntimeState(process.cwd());
      if (state) {
        runtimeStatus = state.status;
      }
    } catch {
      // File doesn't exist or can't be read — leave as 'unknown'
    }

    return {
      status: 'ok',
      version: '0.1.0',
      project: 'saivage-v3',
      runtime: runtimeStatus,
    };
  });
}

// ── Server Config from saivage.json ───────────────────────────

export function getServerConfig(projectRoot: string): ServerConfig {
  try {
    const { config } = loadConfig(projectRoot);
    return {
      host: config.server.host,
      port: config.server.port,
      projectRoot,
    };
  } catch {
    // Fallback defaults if config doesn't exist
    return {
      host: '0.0.0.0',
      port: 8080,
      projectRoot,
    };
  }
}

// ── Server Factory ────────────────────────────────────────────

export async function createServer(
  projectRoot: string,
): Promise<ServerInstance> {
  const serverConfig = getServerConfig(projectRoot);

  // Load saivage config for other consumers
  let saivageConfig: SaivageConfig;
  try {
    const { config } = loadConfig(projectRoot);
    saivageConfig = config;
  } catch {
    // Use a minimal default config
    saivageConfig = {} as SaivageConfig;
  }

  const fastify = Fastify({
    logger: {
      level: process.env['LOG_LEVEL'] ?? 'info',
      transport: process.env['NODE_ENV'] === 'development'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
    },
  });

  // Register plugins (order matters: cors + websocket before routes)
  await fastify.register(cors);
  await fastify.register(websocket);
  await fastify.register(authPlugin);

  // Register static file serving for SPA if web/dist/ exists
  const webDistDir = join(projectRoot, 'web', 'dist');
  if (existsSync(webDistDir)) {
    await fastify.register(fastifyStatic, {
      root: webDistDir,
      prefix: '/',
      wildcard: false,
    });

    // SPA fallback: non-matching GETs -> index.html
    fastify.setNotFoundHandler((_request, reply) => {
      reply.sendFile('index.html');
    });
  }

  // Register health endpoint (no auth)
  registerHealth(fastify, saivageConfig);

  // Register all API route handlers
  registerCardRoutes(fastify, projectRoot);
  registerRuntimeConfigNotesRoutes(fastify, projectRoot);
  registerChatsFilesDebugRoutes(fastify, projectRoot);

  // Register WebSocket endpoint (auth checked internally on upgrade)
  registerWebSocket(fastify, projectRoot);

  // ── MCP Manager Lifecycle ──────────────────────────────────

  let mcpManager: McpManager | undefined;
  try {
    mcpManager = new McpManager(projectRoot);
    // Start all autostart servers (disabled servers are skipped)
    await mcpManager.startAll();
    fastify.log.info('MCP manager started');
  } catch (err) {
    fastify.log.warn(
      `MCP manager initialization failed (continuing without MCP): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // ── MCP Status API Endpoint ────────────────────────────────

  fastify.get('/api/mcp/status', async (_request, reply) => {
    if (!mcpManager) {
      return reply.send({ servers: [] });
    }
    return reply.send({ servers: mcpManager.getStatus() });
  });

  // ── Telegram Bot Lifecycle ─────────────────────────────────

  let telegramBot: TelegramBot | undefined;
  const botToken = saivageConfig.telegram?.botToken;
  if (botToken) {
    try {
      telegramBot = new TelegramBot(projectRoot);
      await telegramBot.start();
      fastify.log.info('Telegram bot started');
    } catch (err) {
      fastify.log.warn(
        `Telegram bot initialization failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // ── Notification Router ────────────────────────────────────

  const notificationRouter = createNotificationRouter(
    projectRoot,
    telegramBot,
  );

  // ── Shutdown ───────────────────────────────────────────────

  async function stop(): Promise<void> {
    if (telegramBot) {
      try {
        await telegramBot.stop();
        fastify.log.info('Telegram bot stopped');
      } catch (err) {
        fastify.log.warn(
          `Telegram bot stop failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    if (mcpManager) {
      try {
        await mcpManager.stopAll();
        fastify.log.info('MCP manager stopped');
      } catch (err) {
        fastify.log.warn(
          `MCP manager stop failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    await fastify.close();
  }

  return {
    fastify,
    config: serverConfig,
    saivageConfig,
    mcpManager,
    telegramBot,
    notificationRouter,
    stop,
  };
}

// ── Convenience Lifecycle Functions ───────────────────────────

/**
 * Create and start the server, listening on the configured host:port.
 */
export async function startServer(
  projectRoot: string,
): Promise<ServerInstance> {
  const server = await createServer(projectRoot);
  await server.fastify.listen({
    host: server.config.host,
    port: server.config.port,
  });
  return server;
}

/**
 * Stop a running server.
 */
export async function stopServer(server: ServerInstance): Promise<void> {
  await server.stop();
}
