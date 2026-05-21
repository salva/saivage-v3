import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import authPlugin from './auth.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerCardRoutes } from './routes/cards.js';
import { registerRuntimeConfigNotesRoutes } from './routes/runtime-config-notes.js';
import { registerChatsFilesDebugRoutes, resetChatRouteState } from './routes/chats-files-debug.js';
import { registerEventsRoute } from './routes/events.js';
import { registerProcessRoutes } from './routes/processes.js';
import { registerWebSocket, resetRuntimeEventSubscriptions, resetWebSocketState, wireRuntimeEvents } from './websocket.js';
import { loadConfig, type SaivageConfig } from '../agents/config-schema.js';
import { McpManager } from '../mcp/index.js';
import { TelegramBot } from '../telegram/index.js';
import { createNotificationRouter } from '../notifications/index.js';
import { createNotificationDeliveryService, setProjectNotificationDeliveryAdapters, clearProjectNotificationDeliveryAdapters } from '../utils/notification-delivery.js';
import { TelegramNotificationDeliveryAdapter, buildTelegramStartupDiagnosticSummary, evaluateTelegramRecipientReadiness, normalizeTelegramNotificationChatIds } from '../telegram/recipients.js';
import type { NotificationRouter } from '../notifications/index.js';
import { ActiveRuntime } from '../runtime/lifecycle.js';
import { buildCardRunsResponse, markGoalNeedsCorrections, normalizeAnalystIssues } from '../utils/analyst-stage6.js';
import { readFreezeManifest } from '../utils/freeze-manifest.js';
import { buildServerAvailability, type ServerAvailabilityInputs } from './availability.js';

export interface ServerConfig { host: string; port: number; projectRoot: string; }
export interface ServerInstance { fastify: FastifyInstance; config: ServerConfig; saivageConfig: SaivageConfig; mcpManager?: McpManager; telegramBot?: TelegramBot; notificationRouter?: NotificationRouter; activeRuntime?: ActiveRuntime; stop: () => Promise<void>; }
export function isLocalhost(host: string): boolean { return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1'; }
export function validateDevModeHost(host: string | undefined): void { const token = process.env['SAIVAGE_API_TOKEN']; if (token) return; console.warn('⚠  SAIVAGE_API_TOKEN is not set. Server is running in DEVELOPMENT MODE with auth disabled.\n' + '   Set SAIVAGE_API_TOKEN to a secure random string for production use.'); const resolvedHost = host ?? '0.0.0.0'; if (!isLocalhost(resolvedHost)) throw new Error(`Cannot bind to ${resolvedHost} without SAIVAGE_API_TOKEN. For development, bind to 127.0.0.1 or localhost. For production, set SAIVAGE_API_TOKEN.`); }
function registerHealth(fastify: FastifyInstance, projectRoot: string, _saivageConfig: SaivageConfig, availabilityInputs?: ServerAvailabilityInputs): void { fastify.get('/health', async () => { let runtimeStatus = 'unknown'; let frozenReason: string | undefined; try { const { readRuntimeState } = await import('../runtime/state.js'); const state = readRuntimeState(projectRoot); if (state) { runtimeStatus = state.status; if (state.status === 'frozen') { const manifest = readFreezeManifest(projectRoot); if (manifest) frozenReason = manifest.reason; } } } catch {} const response: Record<string, unknown> = { status: 'ok', version: '0.1.0', project: 'saivage-v3', runtime: runtimeStatus }; if (frozenReason !== undefined) response.frozen_reason = frozenReason; if (availabilityInputs) response.serverAvailability = buildServerAvailability(availabilityInputs); return response; }); }
export function getServerConfig(projectRoot: string): ServerConfig { let host = '0.0.0.0'; let port = 8080; try { const { config } = loadConfig(projectRoot); host = config.server.host ?? host; port = config.server.port ?? port; } catch {} if (process.env['SAIVAGE_HOST']) host = process.env['SAIVAGE_HOST']; if (process.env['SAIVAGE_PORT']) { const parsed = parseInt(process.env['SAIVAGE_PORT'], 10); if (!isNaN(parsed) && parsed >= 1 && parsed <= 65535) port = parsed; } return { host, port, projectRoot }; }

function registerStage6RuntimeRoutes(fastify: FastifyInstance, projectRoot: string, activeRuntime?: ActiveRuntime): void {
  fastify.post('/api/runtime/goals/:id/needs_corrections', async (request, reply) => {
    try {
      const params = request.params as { id: string };
      const body = (request.body ?? {}) as { issues?: unknown[]; note?: string };
      const issues = normalizeAnalystIssues(body.issues ?? []);
      return reply.send(markGoalNeedsCorrections(projectRoot, params.id, issues, body.note));
    } catch (err) { return reply.status(400).send({ error: 'Failed to record goal corrections', message: err instanceof Error ? err.message : String(err) }); }
  });
  fastify.get('/api/runtime/card-runs', async (_request, reply) => reply.send(buildCardRunsResponse(projectRoot)));
}
function registerRuntimeDispatchRoutes(fastify: FastifyInstance, projectRoot: string, activeRuntime?: ActiveRuntime, availabilityInputs?: ServerAvailabilityInputs): void { fastify.get('/api/runtime/status', async (_request, reply) => { try { const serverAvailability = availabilityInputs ? buildServerAvailability(availabilityInputs) : undefined; if (activeRuntime) { const status = activeRuntime.getStatus(); return reply.send({ runtime: status.status, paused: status.paused, currentCardId: status.currentCardId, goalCount: status.goalCount, ...(serverAvailability ? { serverAvailability } : {}) }); } const { readRuntimeState } = await import('../runtime/state.js'); const state = readRuntimeState(projectRoot); return reply.send({ runtime: state?.status ?? 'unknown', paused: state?.paused ?? false, currentCardId: state?.current_card_id ?? null, goalCount: 0, ...(serverAvailability ? { serverAvailability } : {}) }); } catch (err) { return reply.status(500).send({ error: 'Failed to get runtime status', message: err instanceof Error ? err.message : String(err) }); } }); }
export async function createServer(projectRoot: string, createRuntime?: boolean): Promise<ServerInstance> {
  const serverConfig = getServerConfig(projectRoot);
  let saivageConfig: SaivageConfig;
  try { const { config } = loadConfig(projectRoot); saivageConfig = config; } catch { saivageConfig = {} as SaivageConfig; }
  let transportOpt: { target: string; options: Record<string, unknown> } | undefined;
  if (process.env['NODE_ENV'] === 'development') { try { await import('pino-pretty'); transportOpt = { target: 'pino-pretty', options: { colorize: true } }; } catch (err) { console.warn(`pino-pretty not available, falling back to JSON transport: ${err instanceof Error ? err.message : String(err)}`); } }
  const fastify = Fastify({ logger: { level: process.env['LOG_LEVEL'] ?? 'info', transport: transportOpt } });
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    const rawBody = typeof body === 'string' ? body : body.toString('utf-8');
    if (rawBody.trim() === '') {
      done(null, null);
      return;
    }
    try {
      done(null, JSON.parse(rawBody));
    } catch (err) {
      done(err instanceof Error ? err : new Error(String(err)), undefined);
    }
  });
  await fastify.register(cors); await fastify.register(websocket); await fastify.register(authPlugin); registerAuthRoutes(fastify);
  const thisFile = fileURLToPath(import.meta.url); const inDist = thisFile.includes('/dist/src/') || thisFile.includes('\\dist\\src\\'); const packageRoot = fileURLToPath(new URL(inDist ? '../../..' : '../..', import.meta.url));
  const docsDistDir = join(packageRoot, 'docs', '.vitepress', 'dist'); const docsBuilt = existsSync(docsDistDir);
  if (docsBuilt) { await fastify.register(fastifyStatic, { root: docsDistDir, prefix: '/docs/', wildcard: false, decorateReply: false }); fastify.get('/docs', async (_request, reply) => reply.redirect('/docs/')); } else { const docsUnavailable = async (_request: FastifyRequest, reply: FastifyReply) => reply.status(404).send({ error: 'Documentation not built. Run vitepress build docs/ to generate.' }); fastify.get('/docs/*', docsUnavailable); fastify.get('/docs', docsUnavailable); }
  const webDistDir = join(packageRoot, 'web', 'dist');
  if (existsSync(webDistDir)) { await fastify.register(fastifyStatic, { root: webDistDir, prefix: '/', wildcard: false }); fastify.setNotFoundHandler((request, reply) => { if (request.url === '/docs' || request.url.startsWith('/docs/')) { if (docsBuilt) return reply.callNotFound(); return reply.status(404).send({ error: 'Documentation not built. Run vitepress build docs/ to generate.' }); } reply.sendFile('index.html'); }); }
  let activeRuntime: ActiveRuntime | undefined;
  let mcpManager: McpManager | undefined;
  let runtimeStartupFailure: { code: string; error: unknown } | undefined;
  let mcpStartupFailure: { code: string; error: unknown } | undefined;
  const availabilityInputs: ServerAvailabilityInputs = {
    projectRoot,
    activeRuntime: () => activeRuntime,
    mcpManager: () => mcpManager,
    runtimeStartupFailure: () => runtimeStartupFailure,
    mcpStartupFailure: () => mcpStartupFailure,
  };
  registerHealth(fastify, projectRoot, saivageConfig, availabilityInputs);
  if (createRuntime) { try { activeRuntime = new ActiveRuntime(projectRoot); await activeRuntime.start(); wireRuntimeEvents(activeRuntime.runtime); fastify.log.info('ActiveRuntime started'); } catch (err) { runtimeStartupFailure = { code: 'active-runtime-start-failed', error: err }; fastify.log.warn(`ActiveRuntime initialization failed (continuing without runtime): ${err instanceof Error ? err.message : String(err)}`); } }
  registerCardRoutes(fastify, projectRoot); registerStage6RuntimeRoutes(fastify, projectRoot, activeRuntime); registerRuntimeConfigNotesRoutes(fastify, projectRoot, activeRuntime, () => buildServerAvailability(availabilityInputs)); registerChatsFilesDebugRoutes(fastify, projectRoot, activeRuntime); registerEventsRoute(fastify, projectRoot); registerProcessRoutes(fastify, projectRoot); registerRuntimeDispatchRoutes(fastify, projectRoot, activeRuntime, availabilityInputs); registerWebSocket(fastify, projectRoot, activeRuntime);
  try { mcpManager = new McpManager(projectRoot); await mcpManager.startAll(); fastify.log.info('MCP manager started'); } catch (err) { mcpStartupFailure = { code: 'mcp-manager-start-failed', error: err }; fastify.log.warn(`MCP manager initialization failed (continuing without MCP): ${err instanceof Error ? err.message : String(err)}`); }
  if (activeRuntime && mcpManager) { activeRuntime.agentAdapter.setMcpManager(mcpManager); mcpManager.setEventLogger(activeRuntime.eventLogger); }
  fastify.get('/api/mcp/status', async (_request, reply) => { const serverAvailability = buildServerAvailability(availabilityInputs); if (!mcpManager) return reply.send({ servers: [], serverAvailability }); return reply.send({ servers: mcpManager.getStatus(), serverAvailability }); });
  fastify.get('/api/mcp/tools', async (_request, reply) => { if (!mcpManager) return reply.send({ tools: [], servers: [], invocationStats: {}, serverDetails: [] }); const tools = mcpManager.getTools(); const servers = mcpManager.getToolServers(); const invocationStats = mcpManager.getInvocationStats(); const serverDetails = mcpManager.getStatus().map((status) => { const toolDefs = mcpManager.getServerTools(status.name) ?? []; const toolList = toolDefs.map((td) => { const statsKey = `${status.name}:${td.name}`; const stats = invocationStats[statsKey] ?? { total: 0, success: 0, error: 0 }; return { name: td.name, description: td.description, inputSchema: td.inputSchema, stats }; }); return { name: status.name, transport: status.transport, status: status.status, toolCount: toolDefs.length, tools: toolList }; }); return reply.send({ tools, servers, invocationStats, serverDetails }); });
  let telegramBot: TelegramBot | undefined; const botToken = saivageConfig.telegram?.botToken;
  const recipientRegistry = normalizeTelegramNotificationChatIds(saivageConfig.telegram?.notificationChatIds);
  if (recipientRegistry.invalidValues.length > 0) fastify.log.warn(`Telegram notification recipient config ignored ${recipientRegistry.invalidValues.length} invalid value(s)`);
  if (botToken) { try { telegramBot = new TelegramBot(projectRoot); await telegramBot.start(); fastify.log.info('Telegram bot started'); } catch (err) { fastify.log.warn(`Telegram bot initialization failed: ${err instanceof Error ? err.message : String(err)}`); } }
  const telegramReadiness = evaluateTelegramRecipientReadiness({ channels: saivageConfig.notifications?.channels, botToken, botAvailable: Boolean(telegramBot), recipients: recipientRegistry.recipients, invalidRecipientCount: recipientRegistry.invalidValues.length });
  if (telegramReadiness.state === 'ready' && telegramBot) setProjectNotificationDeliveryAdapters(projectRoot, [new TelegramNotificationDeliveryAdapter(telegramBot, recipientRegistry.recipients)]);
  else clearProjectNotificationDeliveryAdapters(projectRoot);
  const diagnosticSummary = buildTelegramStartupDiagnosticSummary(telegramReadiness);
  if (diagnosticSummary) {
    fastify.log.warn(diagnosticSummary);
    createNotificationDeliveryService(projectRoot, []).enqueueForOperator({
      id: `telegram-startup-${telegramReadiness.state}`,
      kind: 'config_changed',
      severity: 'warn',
      payload_summary: diagnosticSummary,
      source_actor: 'runtime',
      source_surface: 'rest',
    });
  }
  const notificationRouter = createNotificationRouter(projectRoot, telegramBot, { chatIds: recipientRegistry.recipients });
  async function stop(): Promise<void> { resetChatRouteState(projectRoot); resetWebSocketState(); clearProjectNotificationDeliveryAdapters(projectRoot); if (activeRuntime) resetRuntimeEventSubscriptions(activeRuntime.runtime); try { await fastify.close(); } finally { if (telegramBot) { try { await telegramBot.stop(); fastify.log.info('Telegram bot stopped'); } catch (err) { fastify.log.warn(`Telegram bot stop failed: ${err instanceof Error ? err.message : String(err)}`); } } if (mcpManager) { try { await mcpManager.stopAll(); fastify.log.info('MCP manager stopped'); } catch (err) { fastify.log.warn(`MCP manager stop failed: ${err instanceof Error ? err.message : String(err)}`); } } if (activeRuntime) { try { await activeRuntime.stop(); fastify.log.info('ActiveRuntime stopped'); } catch (err) { fastify.log.warn(`ActiveRuntime stop failed: ${err instanceof Error ? err.message : String(err)}`); } } } }
  return { fastify, config: serverConfig, saivageConfig, mcpManager, telegramBot, notificationRouter, activeRuntime, stop };
}
export async function startServer(projectRoot: string, createRuntime?: boolean): Promise<ServerInstance> { const server = await createServer(projectRoot, createRuntime); validateDevModeHost(server.config.host); await server.fastify.listen({ host: server.config.host, port: server.config.port }); return server; }
export async function stopServer(server: ServerInstance): Promise<void> { await server.stop(); }
