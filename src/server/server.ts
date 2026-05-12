/**
 * Core Fastify server module.
 *
 * Provides:
 *  - Fastify instance creation with logger, CORS, static files
 *  - Auth plugin registration
 *  - /health endpoint (no auth, reads actual runtime state, frozen status, frozen_reason)
 *  - All route registrations (cards, runtime/config/notes, chats/files/debug, events, processes)
 *  - Runtime dispatch/status routes (conditionally registered with ActiveRuntime)
 *  - Freeze/resume routes (always registered, work with or without ActiveRuntime)
 *  - WebSocket endpoint registration
 *  - MCP server manager lifecycle
 *  - Telegram bot lifecycle
 *  - ActiveRuntime lifecycle (optional, controlled by createRuntime flag)
 *  - Notification router with WebSocket broadcast integration
 *  - MCP status API endpoint
 *  - startServer() / stopServer() lifecycle functions
 *  - Server config read from saivage.json
 *  - Dev-mode host validation when SAIVAGE_API_TOKEN is unset
 *  - VitePress documentation static serving at /docs/ from docs/.vitepress/dist/
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
import { registerProcessRoutes } from './routes/processes.js';
import { registerWebSocket } from './websocket.js';
import { loadConfig, type SaivageConfig } from '../agents/config-schema.js';
import { McpManager } from '../mcp/index.js';
import { TelegramBot } from '../telegram/index.js';
import { createNotificationRouter } from '../notifications/index.js';
import type { NotificationRouter } from '../notifications/index.js';
import { ActiveRuntime } from '../utils/active-runtime.js';
import {
  saveFreezeManifest,
  readFreezeManifest,
  clearFreezeManifest,
} from '../utils/freeze-manifest.js';
import type { FreezeManifest } from '../schemas/types.js';

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
    let frozenReason: string | undefined;

    // Read actual runtime state from .saivage/runtime/state.json
    try {
      const { readRuntimeState } = await import('../utils/runtime-state.js');
      const state = readRuntimeState(process.cwd());
      if (state) {
        runtimeStatus = state.status;

        // When frozen, also read the freeze manifest for the reason
        if (state.status === 'frozen') {
          const { readFreezeManifest: readFm } = await import('../utils/freeze-manifest.js');
          const manifest = readFm(process.cwd());
          if (manifest) {
            frozenReason = manifest.reason;
          }
        }
      }
    } catch {
      // File doesn't exist or can't be read — leave as 'unknown'
    }

    const response: Record<string, unknown> = {
      status: 'ok',
      version: '0.1.0',
      project: 'saivage-v3',
      runtime: runtimeStatus,
    };

    if (frozenReason !== undefined) {
      response.frozen_reason = frozenReason;
    }

    return response;
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
 * Register runtime dispatch, status, freeze, and resume-from-freeze routes.
 *
 * POST /api/runtime/dispatch        — dispatches a goal through ActiveRuntime
 * GET  /api/runtime/status          — returns runtime status from ActiveRuntime or state file
 * POST /api/runtime/freeze          — freezes the runtime (stops dispatch, persists manifest)
 * POST /api/runtime/resume-from-freeze — resumes from a saved freeze manifest
 *
 * Freeze/resume-from-freeze endpoints work with or without ActiveRuntime.
 * When no ActiveRuntime is provided, they use file-based freeze-manifest operations directly.
 */
function registerRuntimeDispatchRoutes(
  fastify: FastifyInstance,
  projectRoot: string,
  activeRuntime?: ActiveRuntime,
): void {
  // ── POST /api/runtime/dispatch ────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  fastify.post('/api/runtime/dispatch', async (request, reply) => {
    if (!activeRuntime) {
      return reply.status(503).send({
        error: 'No active runtime available. Dispatch requires a running ActiveRuntime.',
      });
    }

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
      if (activeRuntime) {
        const status = activeRuntime.getStatus();
        return reply.send({
          runtime: status.status,
          paused: status.paused,
          currentCardId: status.currentCardId,
          goalCount: status.goalCount,
        });
      }

      // Fallback: read from state file
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

  // ── POST /api/runtime/freeze ───────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  fastify.post('/api/runtime/freeze', async (request, reply) => {
    try {
      const body = request.body as { reason?: string } | undefined;
      const reason = body?.reason;

      if (activeRuntime) {
        // Use ActiveRuntime path if available
        const manifest = activeRuntime.freeze(reason);
        return reply.send({
          status: 'frozen',
          freeze_id: manifest.freeze_id,
          reason: manifest.reason,
          created_at: manifest.created_at,
        });
      }

      // Fallback: Direct file operations (no live runtime dispatcher)
      const existing = readFreezeManifest(projectRoot);
      if (existing) {
        return reply.send({
          status: 'already_frozen',
          freeze_id: existing.freeze_id,
          reason: existing.reason,
          created_at: existing.created_at,
        });
      }

      const { readRuntimeState, updateRuntimeState } = await import('../utils/runtime-state.js');
      const state = readRuntimeState(projectRoot);
      if (!state) {
        return reply.status(400).send({
          error: 'Cannot freeze: runtime state not initialized.',
        });
      }

      const now = new Date();
      const freezeId = `freeze-${now.toISOString().replace(/[:.]/g, '-')}`;

      const manifest: FreezeManifest = {
        freeze_id: freezeId,
        reason: reason ?? 'operator requested freeze',
        created_at: now.toISOString(),
        status: 'frozen',
        project_id: 'project',
        pid: process.pid,
        started_at: state.started_at,
        current_card_id: state.current_card_id ?? null,
        current_agent_session_id: state.current_agent_session_id ?? null,
        queue: state.queue,
        running_processes: (state.running_processes ?? []).map((id) => ({ id, action: "reattach" })),
        handoff_summaries: [],
        schema_version: 1,
        runtime_version: '0.1.0',
      };

      saveFreezeManifest(projectRoot, manifest);
      updateRuntimeState(projectRoot, {
        status: 'frozen' as never,
        paused: true,
        paused_at: now.toISOString(),
      });

      return reply.send({
        status: 'frozen',
        freeze_id: manifest.freeze_id,
        reason: manifest.reason,
        created_at: manifest.created_at,
      });
    } catch (err) {
      return reply.status(500).send({
        error: 'Failed to freeze runtime',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ── POST /api/runtime/resume-from-freeze ────────────────────

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  fastify.post('/api/runtime/resume-from-freeze', async (_request, reply) => {
    try {
      if (activeRuntime) {
        // Use ActiveRuntime path if available
        const result = activeRuntime.resumeFromFreeze();
        return reply.send({
          status: 'resumed',
          freeze_id: result.freeze_id,
          restored_queue: result.restored_queue,
          restored_processes: result.restored_processes,
          restored_card_id: result.restored_card_id,
        });
      }

      // Fallback: Direct file operations
      const manifest = readFreezeManifest(projectRoot);
      if (!manifest) {
        return reply.status(400).send({
          error: 'Cannot resume from freeze: no freeze manifest found. The runtime is not frozen.',
        });
      }

      const { updateRuntimeState } = await import('../utils/runtime-state.js');

      updateRuntimeState(projectRoot, {
        status: 'idle',
        current_card_id: manifest.current_card_id,
        current_agent_session_id: manifest.current_agent_session_id,
        paused: false,
        paused_at: null,
        queue: manifest.queue,
        running_processes: manifest.running_processes.map((p) => p.id),
      });

      clearFreezeManifest(projectRoot);

      return reply.send({
        status: 'resumed',
        freeze_id: manifest.freeze_id,
        restored_queue: manifest.queue,
        restored_processes: manifest.running_processes.map((p) => p.id),
        restored_card_id: manifest.current_card_id,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('no freeze manifest found')) {
        return reply.status(400).send({
          error: 'Cannot resume from freeze: no freeze manifest found. The runtime is not frozen.',
        });
      }
      return reply.status(500).send({
        error: 'Failed to resume from freeze',
        message,
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

  // Determine logger transport for development mode.
  // When NODE_ENV=development and pino-pretty is available, use the pretty-print
  // transport for human-readable logs.  When pino-pretty is not installed, fall
  // back to standard JSON transport without crashing so tests and tooling that
  // happen to set NODE_ENV=development still work.
  let transportOpt: { target: string; options: Record<string, unknown> } | undefined;
  if (process.env['NODE_ENV'] === 'development') {
    try {
      await import('pino-pretty');
      transportOpt = { target: 'pino-pretty', options: { colorize: true } };
    } catch (err) {
      // pino-pretty not available -- fall back to standard JSON transport
      console.warn(
        `pino-pretty not available, falling back to JSON transport: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const fastify = Fastify({
    logger: {
      level: process.env['LOG_LEVEL'] ?? 'info',
      transport: transportOpt,
    },
  });

  // Register plugins (order matters: cors + websocket before routes)
  await fastify.register(cors);
  await fastify.register(websocket);
  await fastify.register(authPlugin);

  // ── Register static file serving for SPA if web/dist/ exists
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

  // ── Register VitePress docs serving at /docs/
  // Must be registered AFTER the SPA static serving so that /docs/ routes
  // take priority over the SPA not-found handler.  If the VitePress build
  // output exists, @fastify/static serves it; otherwise an explicit catch-all
  // returns a helpful 404 (the SPA fallback must not swallow /docs/ requests).
  //
  // Pass decorateReply: false because @fastify/static may have already been
  // registered for the SPA above, which decorates reply.sendFile() once.
  const docsDistDir = join(projectRoot, 'docs', '.vitepress', 'dist');
  if (existsSync(docsDistDir)) {
    await fastify.register(fastifyStatic, {
      root: docsDistDir,
      prefix: '/docs/',
      wildcard: false,
      decorateReply: false,
    });
  } else {
    // VitePress not built — return a graceful 404 for any /docs/ request
    fastify.get('/docs/*', async (_request, reply) => {
      return reply.status(404).send({
        error: 'Documentation not built. Run vitepress build docs/ to generate.',
      });
    });

    // Also handle exact /docs (no trailing slash)
    fastify.get('/docs', async (_request, reply) => {
      return reply.status(404).send({
        error: 'Documentation not built. Run vitepress build docs/ to generate.',
      });
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
  registerProcessRoutes(fastify, projectRoot);

  // Register runtime dispatch, status, freeze, and resume-from-freeze routes.
  // These are always registered — freeze/resume work with or without ActiveRuntime,
  // while dispatch returns 503 when no ActiveRuntime is available.
  registerRuntimeDispatchRoutes(fastify, projectRoot, activeRuntime);

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

  // ── Wire McpManager into ActiveRuntime ─────────────────────
  // After both ActiveRuntime and McpManager are created, wire them
  // together so agents can invoke MCP tools at execution time and
  // MCP tool invocations are logged through the shared EventLogger.

  if (activeRuntime && mcpManager) {
    activeRuntime.agentAdapter.setMcpManager(mcpManager);
    mcpManager.setEventLogger(activeRuntime.eventLogger);
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
      return reply.send({
        tools: [],
        servers: [],
        invocationStats: {},
        serverDetails: [],
      });
    }
    const tools = mcpManager.getTools();
    const servers = mcpManager.getToolServers();
    const invocationStats = mcpManager.getInvocationStats();

    // Build per-server detailed data
    const serverDetails = mcpManager.getStatus().map((status) => {
      const toolDefs = mcpManager.getServerTools(status.name) ?? [];
      const toolList = toolDefs.map((td) => {
        const statsKey = `${status.name}:${td.name}`;
        const stats = invocationStats[statsKey] ?? {
          total: 0,
          success: 0,
          error: 0,
        };
        return {
          name: td.name,
          description: td.description,
          inputSchema: td.inputSchema,
          stats,
        };
      });

      return {
        name: status.name,
        transport: status.transport,
        status: status.status,
        toolCount: toolDefs.length,
        tools: toolList,
      };
    });

    return reply.send({ tools, servers, invocationStats, serverDetails });
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
