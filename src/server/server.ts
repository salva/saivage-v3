import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import authPlugin from './auth.js';
import { registerCardRoutes } from './routes/cards.js';
import { registerRuntimeConfigNotesRoutes } from './routes/runtime-config-notes.js';
import { registerChatsFilesDebugRoutes } from './routes/chats-files-debug.js';
import { registerEventsRoute } from './routes/events.js';
import { registerProcessRoutes } from './routes/processes.js';
import { registerWebSocket, wireRuntimeEvents } from './websocket.js';
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

export function isLocalhost(host: string): boolean {
  if (host === '127.0.0.1') return true;
  if (host === 'localhost') return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  return false;
}

export function validateDevModeHost(host: string | undefined): void {
  const token = process.env['SAIVAGE_API_TOKEN'];
  if (token) {
    return;
  }

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

function registerHealth(
  fastify: FastifyInstance,
  projectRoot: string,
  _saivageConfig: SaivageConfig,
): void {
  fastify.get('/health', async (_request, _reply) => {
    let runtimeStatus = 'unknown';
    let frozenReason: string | undefined;

    try {
      const { readRuntimeState } = await import('../utils/runtime-state.js');
      const state = readRuntimeState(projectRoot);
      if (state) {
        runtimeStatus = state.status;
        if (state.status === 'frozen') {
          const manifest = readFreezeManifest(projectRoot);
          if (manifest) {
            frozenReason = manifest.reason;
          }
        }
      }
    } catch {
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

export function getServerConfig(projectRoot: string): ServerConfig {
  let host = '0.0.0.0';
  let port = 8080;

  try {
    const { config } = loadConfig(projectRoot);
    host = config.server.host ?? host;
    port = config.server.port ?? port;
  } catch {
  }

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

function registerRuntimeDispatchRoutes(
  fastify: FastifyInstance,
  projectRoot: string,
  activeRuntime?: ActiveRuntime,
): void {
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

      const goal = activeRuntime.runtime.cardStore.read(body.goalId);
      if (!goal) {
        return reply.status(404).send({ error: 'Goal not found', goalId: body.goalId });
      }

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

  fastify.post('/api/runtime/freeze', async (request, reply) => {
    try {
      const body = request.body as { reason?: string } | undefined;
      const reason = body?.reason;

      if (activeRuntime) {
        const manifest = activeRuntime.freeze(reason);
        return reply.send({
          status: 'frozen',
          freeze_id: manifest.freeze_id,
          reason: manifest.reason,
          created_at: manifest.created_at,
        });
      }

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
        running_processes: (state.running_processes ?? []).map((id) => ({ id, action: 'reattach' })),
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

  fastify.post('/api/runtime/resume-from-freeze', async (_request, reply) => {
    try {
      if (activeRuntime) {
        const result = activeRuntime.resumeFromFreeze();
        return reply.send({
          status: 'resumed',
          freeze_id: result.freeze_id,
          restored_queue: result.restored_queue,
          restored_processes: result.restored_processes,
          restored_card_id: result.restored_card_id,
        });
      }

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

export async function createServer(
  projectRoot: string,
  createRuntime?: boolean,
): Promise<ServerInstance> {
  const serverConfig = getServerConfig(projectRoot);

  let saivageConfig: SaivageConfig;
  try {
    const { config } = loadConfig(projectRoot);
    saivageConfig = config;
  } catch {
    saivageConfig = {} as SaivageConfig;
  }

  let transportOpt: { target: string; options: Record<string, unknown> } | undefined;
  if (process.env['NODE_ENV'] === 'development') {
    try {
      await import('pino-pretty');
      transportOpt = { target: 'pino-pretty', options: { colorize: true } };
    } catch (err) {
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

  await fastify.register(cors);
  await fastify.register(websocket);
  await fastify.register(authPlugin);

  const thisFile = fileURLToPath(import.meta.url);
  const inDist = thisFile.includes('/dist/src/') || thisFile.includes('\\dist\\src\\');
  const packageRoot = fileURLToPath(new URL(inDist ? '../../..' : '../..', import.meta.url));

  const webDistDir = join(packageRoot, 'web', 'dist');
  if (existsSync(webDistDir)) {
    await fastify.register(fastifyStatic, {
      root: webDistDir,
      prefix: '/',
      wildcard: false,
    });

    fastify.setNotFoundHandler((_request, reply) => {
      reply.sendFile('index.html');
    });
  }

  const docsDistDir = join(packageRoot, 'docs', '.vitepress', 'dist');
  if (existsSync(docsDistDir)) {
    await fastify.register(fastifyStatic, {
      root: docsDistDir,
      prefix: '/docs/',
      wildcard: false,
      decorateReply: false,
    });
  } else {
    fastify.get('/docs/*', async (_request, reply) => {
      return reply.status(404).send({
        error: 'Documentation not built. Run vitepress build docs/ to generate.',
      });
    });

    fastify.get('/docs', async (_request, reply) => {
      return reply.status(404).send({
        error: 'Documentation not built. Run vitepress build docs/ to generate.',
      });
    });
  }

  registerHealth(fastify, projectRoot, saivageConfig);

  let activeRuntime: ActiveRuntime | undefined;
  if (createRuntime) {
    try {
      activeRuntime = new ActiveRuntime(projectRoot);
      await activeRuntime.start();
      wireRuntimeEvents(activeRuntime.runtime);
      fastify.log.info('ActiveRuntime started');
    } catch (err) {
      fastify.log.warn(
        `ActiveRuntime initialization failed (continuing without runtime): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

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
  registerRuntimeDispatchRoutes(fastify, projectRoot, activeRuntime);
  registerWebSocket(fastify, projectRoot);

  let mcpManager: McpManager | undefined;
  try {
    mcpManager = new McpManager(projectRoot);
    await mcpManager.startAll();
    fastify.log.info('MCP manager started');
  } catch (err) {
    fastify.log.warn(
      `MCP manager initialization failed (continuing without MCP): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (activeRuntime && mcpManager) {
    activeRuntime.agentAdapter.setMcpManager(mcpManager);
    mcpManager.setEventLogger(activeRuntime.eventLogger);
  }

  fastify.get('/api/mcp/status', async (_request, reply) => {
    if (!mcpManager) {
      return reply.send({ servers: [] });
    }
    return reply.send({ servers: mcpManager.getStatus() });
  });

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

  const notificationRouter = createNotificationRouter(
    projectRoot,
    telegramBot,
  );

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

export async function startServer(
  projectRoot: string,
  createRuntime?: boolean,
): Promise<ServerInstance> {
  const server = await createServer(projectRoot, createRuntime);
  validateDevModeHost(server.config.host);

  await server.fastify.listen({
    host: server.config.host,
    port: server.config.port,
  });
  return server;
}

export async function stopServer(server: ServerInstance): Promise<void> {
  await server.stop();
}
