import type { FastifyInstance } from 'fastify';
import { loadConfig, type SaivageConfig } from '../agents/config-api.js';
import type { Environment } from '../config/index.js';
import { McpManager } from '../mcp/manager-api.js';
import { TelegramBot } from '../telegram/index.js';
import type { RuntimeApplication } from '../application/runtime-composition.js';
import { configureAuthPolicy } from './auth-policy.js';
import { createResourceScope, type ResourceScope } from '../lifecycle/index.js';
import { createFastifyApp } from './composition/fastify-app.js';
import { startRuntimeApplication } from './composition/runtime-lifecycle.js';
import { attachMcpManagerToRuntime, startMcpManager } from './composition/mcp-lifecycle.js';
import { startTelegramNotifications } from './composition/telegram-lifecycle.js';
import { registerServerRoutes } from './composition/route-composition.js';
import { stopServerResources } from './composition/server-shutdown.js';
import type { ServerAvailabilityInputs } from './availability.js';

export interface ServerConfig { host: string; port: number; projectRoot: string; }
export interface CreateServerOptions { environment: Environment; createRuntime?: boolean; scope?: ResourceScope; }
export interface ServerInstance { fastify: FastifyInstance; config: ServerConfig; saivageConfig: SaivageConfig; scope: ResourceScope; mcpManager?: McpManager; telegramBot?: TelegramBot; runtimeApplication?: RuntimeApplication; stop: () => Promise<void>; requestRestart: () => Promise<void>; }
export function isLocalhost(host: string): boolean { return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1'; }
export function validateDevModeHost(host: string | undefined, apiToken?: string): void { if (apiToken) return; console.warn('⚠  SAIVAGE_API_TOKEN is not set. Server is running in DEVELOPMENT MODE with auth disabled.\n' + '   Set SAIVAGE_API_TOKEN to a secure random string for production use.'); const resolvedHost = host ?? '0.0.0.0'; if (!isLocalhost(resolvedHost)) console.warn(`⚠  Binding to ${resolvedHost} without SAIVAGE_API_TOKEN. All API endpoints are unauthenticated.`); }
export function getServerConfig(environment: Environment): ServerConfig { return { host: environment.server.host, port: environment.server.port, projectRoot: environment.projectRoot }; }

function createEnvironmentFromProjectConfig(projectRoot: string): Environment {
  const { config, warnings } = loadConfig(projectRoot);
  return {
    nodeEnv: 'production',
    projectRoot,
    configPath: `${projectRoot}/.saivage/saivage.json`,
    config,
    configWarnings: Object.freeze([...warnings]),
    server: Object.freeze({ host: config.server.host, port: config.server.port, corsOrigins: Object.freeze([]), logLevel: 'info' as const }),
    auth: Object.freeze({ devModeAuthDisabled: true }),
    storage: Object.freeze({ rootDir: `${projectRoot}/.saivage`, locking: Object.freeze({ mode: 'project-file' as const }) }),
    providers: config.providers,
    mcp: Object.freeze({ servers: config.mcpServers }),
    observability: Object.freeze({ logLevel: 'info' as const }),
  } as Environment;
}

export async function createServer(optionsOrProjectRoot: CreateServerOptions | string, createRuntimeArg?: boolean): Promise<ServerInstance> {
  const environment = typeof optionsOrProjectRoot === 'string'
    ? createEnvironmentFromProjectConfig(optionsOrProjectRoot)
    : optionsOrProjectRoot.environment;
  const projectRoot = environment.projectRoot;
  const createRuntime = typeof optionsOrProjectRoot === 'string' ? createRuntimeArg : optionsOrProjectRoot.createRuntime;
  const scope = typeof optionsOrProjectRoot === 'string' ? createResourceScope('server') : (optionsOrProjectRoot.scope ?? createResourceScope('server'));
  const serverConfig = getServerConfig(environment);
  const saivageConfig: SaivageConfig = environment.config;
  configureAuthPolicy({ apiToken: environment.auth.apiToken });

  const fastify = await createFastifyApp(environment);
  async function stop(): Promise<void> { await scope.dispose(); }
  const requestRestart = async (): Promise<void> => {
    setImmediate(async () => {
      try { await stop(); } finally { process.exit(75); }
    });
  };

  const availabilityInputs: ServerAvailabilityInputs = {
    projectRoot,
    runtimeApplication: () => runtimeApplication,
    mcpManager: () => mcpManager,
    runtimeStartupFailure: () => runtimeStartupFailure,
    mcpStartupFailure: () => mcpStartupFailure,
  };

  const runtimeStartup = await startRuntimeApplication({ createRuntime, projectRoot, saivageConfig, fastify });
  const runtimeApplication = runtimeStartup.runtimeApplication;
  const runtimeStartupFailure = runtimeStartup.startupFailure;

  const mcpStartup = await startMcpManager({ projectRoot, scope, fastify });
  const mcpManager = mcpStartup.mcpManager;
  const mcpStartupFailure = mcpStartup.startupFailure;
  attachMcpManagerToRuntime(runtimeApplication, mcpManager);

  const telegramBot = await startTelegramNotifications({ projectRoot, saivageConfig, fastify, runtimeApplication });

  registerServerRoutes({
    fastify,
    projectRoot,
    runtimeApplicationProvider: () => runtimeApplication,
    mcpManagerProvider: () => mcpManager,
    availabilityInputs,
    saivageConfig,
    configWarnings: environment.configWarnings,
    requestServerRestart: requestRestart,
  });

  scope.add({ dispose: () => stopServerResources({ projectRoot, fastify, runtimeApplication, mcpManager, telegramBot }) }, { name: 'server-stop' });

  return { fastify, config: serverConfig, saivageConfig, scope, mcpManager, telegramBot, runtimeApplication, stop, requestRestart };
}

export async function startServer(optionsOrProjectRoot: CreateServerOptions | string, createRuntime?: boolean): Promise<ServerInstance> { const server = await createServer(optionsOrProjectRoot as CreateServerOptions | string, createRuntime); const apiToken = typeof optionsOrProjectRoot === 'string' ? undefined : optionsOrProjectRoot.environment.auth.apiToken; validateDevModeHost(server.config.host, apiToken); await server.fastify.listen({ host: server.config.host, port: server.config.port }); return server; }
export async function stopServer(server: ServerInstance): Promise<void> { await server.stop(); }
