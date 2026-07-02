import type { FastifyInstance } from 'fastify';
import type { SaivageConfig } from '../agents/config-api.js';
import type { Environment } from '../config/index.js';
import { McpManager } from '../mcp/manager-api.js';
import { TelegramBot } from '../telegram/index.js';
import type { RuntimeApplication } from '../application/runtime-composition.js';
import { createResourceScope, type ResourceScope } from '../lifecycle/index.js';
import { registerServerRoutes } from './composition/route-composition.js';
import { createServerServices } from './composition/server-services.js';

export interface ServerConfig { host: string; port: number; projectRoot: string; }
export interface CreateServerOptions { environment: Environment; scope?: ResourceScope; }
export interface ServerInstance { fastify: FastifyInstance; config: ServerConfig; saivageConfig: SaivageConfig; scope: ResourceScope; mcpManager: McpManager; telegramBot?: TelegramBot; runtimeApplication: RuntimeApplication; stop: () => Promise<void>; requestRestart: () => Promise<void>; }
export function isLocalhost(host: string): boolean { return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1'; }
export function validateDevModeHost(host: string | undefined, apiToken?: string): void { if (apiToken) return; console.warn('⚠  SAIVAGE_API_TOKEN is not set. Server is running in DEVELOPMENT MODE with auth disabled.\n' + '   Set SAIVAGE_API_TOKEN to a secure random string for production use.'); const resolvedHost = host ?? '0.0.0.0'; if (!isLocalhost(resolvedHost)) console.warn(`⚠  Binding to ${resolvedHost} without SAIVAGE_API_TOKEN. All API endpoints are unauthenticated.`); }
export function getServerConfig(environment: Environment): ServerConfig { return { host: environment.server.host, port: environment.server.port, projectRoot: environment.projectRoot }; }

export async function createServer(options: CreateServerOptions): Promise<ServerInstance> {
  const environment = options.environment;
  const scope = options.scope ?? createResourceScope('server');
  const serverConfig = getServerConfig(environment);
  const services = await createServerServices({ environment, scope });

  registerServerRoutes({
    fastify: services.fastify,
    projectRoot: services.projectRoot,
    cardStore: services.cardStore,
    runtimeApplication: services.runtimeApplication,
    mcpManager: services.mcpManager,
    saivageConfig: services.config,
    configWarnings: environment.configWarnings,
    requestServerRestart: services.requestRestart,
    liveSyncSocket: services.liveSyncSocket,
  });

  return { fastify: services.fastify, config: serverConfig, saivageConfig: services.config, scope: services.scope, mcpManager: services.mcpManager, telegramBot: services.telegramBot, runtimeApplication: services.runtimeApplication, stop: services.stop, requestRestart: services.requestRestart };
}

export async function startServer(options: CreateServerOptions): Promise<ServerInstance> { const server = await createServer(options); validateDevModeHost(server.config.host, options.environment.auth.apiToken); await server.fastify.listen({ host: server.config.host, port: server.config.port }); return server; }
export async function stopServer(server: ServerInstance): Promise<void> { await server.stop(); }
