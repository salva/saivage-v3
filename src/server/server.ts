/**
 * Core Fastify server module.
 *
 * Provides:
 *  - Fastify instance creation with logger, CORS, static files
 *  - Auth plugin registration
 *  - /health endpoint (no auth, reads actual runtime state)
 *  - All route registrations (cards, runtime/config/notes, chats/files/debug, events)
 *  - Runtime dispatch/status routes (conditionally registered with ActiveRuntime)
 *  - WebSocket endpoint registration
 *  - MCP server manager lifecycle
 *  - Telegram bot lifecycle
 *  - ActiveRuntime lifecycle (optional, controlled by createRuntime flag)
 *  - Notification router with WebSocket broadcast integration
 *  - MCP status API endpoint
 *  - startServer() / stopServer() lifecycle functions
 *  - Server config read from saivage.json
 *  - Dev-mode host validation when SAIVAGE_API_TOKEN is unset
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
import { registerEventsRoute } from './routes/events.js';
import { registerWebSocket } from './websocket.js';
import { loadConfig, type SaivageConfig } from '../agents/config-schema.js';
import { McpManager } from '../mcp/index.js';
import { TelegramBot } from '../telegram/index.js';
import { createNotificationRouter } from '../notifications/index.js';
import type { NotificationRouter } from '../notifications/index.js';
import { ActiveRuntime } from '../utils/active-runtime.js';

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
  activeRuntime?: ActiveRuntime;
  stop: () => Promise<void>;
}

// ── Dev-Mode Host Validation ──────────────────────────────────

/**
 * Check whether a host string is a loopback / localhost address.
 *
 * Returns true for:
 *   - '127.0.0.1'
 *   - 'localhost'
 *   - '::1'       (IPv6 loopback)
 *   - '0:0:0:0:0:0:0:1' (IPv6 loopback full form)
 *
 * Returns false for:
 *   - '0.0.0.0'   (all interfaces — dangerous without auth)
 *   - Any other IP or hostname
 */
export function isLocalhost(host: string): boolean {
  // Canonical IPv4 loopback
  if (host === '127.0.0.1') return true;

  // Hostname form
  if (host === 'localhost') return true;

  // IPv6 loopback (compressed / full)
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;

  return false;
}

/**
 * Validate that the server host binding is safe when no API token is set.
 *
 * - If SAIVAGE_API_TOKEN is set → any host is allowed (production-ready).
 * - If SAIVAGE_API_TOKEN is NOT set → warn about dev mode and only allow
 *   localhost / 127.0.0.1 / ::1.  Non-localhost binds (e.g. 0.0.0.0) throw.
 *
 * This implements the fail-closed security behaviour from 05-security.md
 * and future.md #23: the auth plugin should fail closed for non-local binds
 * when SAIVAGE_API_TOKEN is unset.
 */
export function validateDevModeHost(host: string | undefined): void {
  const token = process.env['SAIVAGE_API_TOKEN'];
  if (token) {
    return; // Token is set — any host is fine
  }

  // No token — warn about dev mode
  console.warn(
    '⚠  SAIVAGE_API_TOKEN is not set. Server is running in DEVELOPMENT MODE with auth disabled.\n' +
    '   Set SAIVAGE_API_TOKEN to a secure random string for production use.',
  );

  const resolvedHost = host ?? '0.0.0.0';
  if (!isLocalhost(resolvedHost)) {
    throw new Error(
      `Cannot bind to ${resolvedHost} without SAIVAGE_API_TOKEN. ` +
      `For development, bind to 127.0.0.1 or localhost. ` +
      `For production, set SAIVAGE_API_TOKEN.`,
    );
  }
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
  let host = '0.0.0.0';
  let port = 8080;

  try {
    const { config } = loadConfig(projectRoot);
    host = config.server.host ?? host;
    port = config.server.port ?? port;
  } catch {
    // Use defaults
  }

  // Environment variable overrides (set by CLI or by user)
  if (process.env['SAIVAGE_HOST']) {
    host = process.env['SAIVAGE_HOST'];
  }
  if (process.env['SAIVAGE_PORT']) {
    const parsed = parseInt(process.env['SAIVAGE_PORT'], 10);
    if (!isNaN(parsed) && parsed >= 1 && parsed <= 65535) {
      port = parsed;
    }
  }

  return { host, port, projectRoot };
}

// ── Runtime Dispatch & Status Routes ─────────────────────────

/**
 * Register runtime dispatch and status routes that use the ActiveRuntime.
 *
 * POST /api/runtime/dispatch — dispatches a goal through ActiveRuntime
 * GET  /api/runtime/status   — returns runtime status from ActiveRuntime or state file
 *
 * These routes are registered AFTER all other routes so they have access to
 * the ActiveRuntime from the closure.
 */
function registerRuntimeDispatchRoutes(
  fastify: FastifyInstance,
  projectRoot: string,
  activeRuntime: ActiveRuntime,
): void {
  // ── POST /api/runtime/dispatch ────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  fastify.post('/api/runtime/dispatch', async (request, reply) => {
    try {
      const body = request.body as { goalId?: string };
      if (!body.goalId) {
        return reply.status(400).send({ error: 'goalId is required' });
      }

      // Check the goal exists
      const goal = activeRuntime.runtime.cardStore.read(body.goalId);
      if (!goal) {
        return reply.status(404).send({ error: 'Goal not found', goalId: body.goalId });
      }

      // Dispatch asynchronously (fire and forget — runtime runs in background)
      activeRuntime.dispatchGoal(body.goalId).catch((err: unknown) => {
        fastify.log.error({ goalId: body.goalId, err }, 'Goal dispatch failed');
      });

      return reply.send({ status: 'dispatched', goalId: body.goalId });
    } catch (err) {
      return reply.status(500).send({
        error: 'Failed to dispatch goal',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ── GET /api/runtime/status ───────────────────────────────

  fastify.get('/api/runtime/status', async (_request, reply) => {
    try {
      const status = activeRuntime.getStatus();
      return reply.send({
        runtime: status.status,
        paused: status.paused,
        currentCardId: status.currentCardId,
        goalCount: status.goalCount,
      });
    } catch (err) {
      return reply.status(500).send({
        error: 'Failed to get runtime status',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

// ── Server Factory ────────────────────────────────────────────

export async function createServer(
  projectRoot: string,
  createRuntime?: boolean,
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

  // ── ActiveRuntime Lifecycle ────────────────────────────────

  let activeRuntime: ActiveRuntime | undefined;
  if (createRuntime) {
    try {
      activeRuntime = new ActiveRuntime(projectRoot);
      await activeRuntime.start();
      fastify.log.info('ActiveRuntime started');
    } catch (err) {
      fastify.log.warn(
        `ActiveRuntime initialization failed (continuing without runtime): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // Register all API route handlers.
  // Pass pause/resume callbacks that also control the ActiveRuntime's
  // in-memory _paused flag, so both the state file and the runtime's
  // internal state stay in sync.
  registerCardRoutes(fastify, projectRoot);
  registerRuntimeConfigNotesRoutes(
    fastify,
    projectRoot,
    activeRuntime ? () => activeRuntime.pause() : undefined,
    activeRuntime ? () => activeRuntime.resume() : undefined,
  );
  registerChatsFilesDebugRoutes(fastify, projectRoot);
  registerEventsRoute(fastify, projectRoot);

  // Register runtime dispatch/status routes when ActiveRuntime is available.
  // These are registered AFTER the other routes to ensure the closure works.
  if (activeRuntime) {
    registerRuntimeDispatchRoutes(fastify, projectRoot, activeRuntime);
  } else {
    // When no ActiveRuntime, provide a GET /api/runtime/status fallback
    // that reads from the state file directly.
    fastify.get('/api/runtime/status', async (_request, reply) => {
      try {
        const { readRuntimeState } = await import('../utils/runtime-state.js');
        const state = readRuntimeState(projectRoot);
        return reply.send({
          runtime: state?.status ?? 'unknown',
          paused: state?.paused ?? false,
          currentCardId: state?.current_card_id ?? null,
          goalCount: 0,
        });
      } catch (err) {
        return reply.status(500).send({
          error: 'Failed to get runtime status',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

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

  // ── MCP Tools API Endpoint ─────────────────────────────────

  fastify.get('/api/mcp/tools', async (_request, reply) => {
    if (!mcpManager) {
      return reply.send({ tools: [], servers: [], invocationStats: {} });
    }
    const tools = mcpManager.getTools();
    const servers = mcpManager.getToolServers();
    const invocationStats = mcpManager.getInvocationStats();
    return reply.send({ tools, servers, invocationStats });
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
    if (activeRuntime) {
      try {
        await activeRuntime.stop();
        fastify.log.info('ActiveRuntime stopped');
      } catch (err) {
        fastify.log.warn(
          `ActiveRuntime stop failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
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
    activeRuntime,
    stop,
  };
}

// ── Convenience Lifecycle Functions ───────────────────────────

/**
 * Create and start the server, listening on the configured host:port.
 *
 * Before listening, validates that the host binding is safe when no
 * SAIVAGE_API_TOKEN is configured (dev-mode host validation).
 * Non-localhost binds without a token will cause this function to throw.
 */
export async function startServer(
  projectRoot: string,
  createRuntime?: boolean,
): Promise<ServerInstance> {
  const server = await createServer(projectRoot, createRuntime);

  // Validate dev-mode host binding before listening.
  // If SAIVAGE_API_TOKEN is unset and the host is non-localhost, this throws.
  validateDevModeHost(server.config.host);

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
