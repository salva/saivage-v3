import { resolve } from 'node:path';
import { z } from 'zod';
import { parseArgs } from 'node:util';
import type { EnvironmentSource } from './env-interpolation.js';
import type { SaivageConfig } from '../agents/config-api.js';
import { createResolvedConfigAuthority, type ConfigSelectionSource, type ResolvedConfigAuthority } from './resolved-config-authority.js';
import { realpathSync } from 'node:fs';

export type NodeEnvironment = 'development' | 'production' | 'test';
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface Environment {
  readonly nodeEnv: NodeEnvironment;
  readonly projectRoot: string;
  readonly configAuthority: ResolvedConfigAuthority;
  readonly config: SaivageConfig;
  readonly configWarnings: readonly string[];
  readonly server: {
    readonly host: string;
    readonly port: number;
    readonly corsOrigins: readonly string[];
    readonly logLevel: LogLevel;
  };
  readonly auth: {
    readonly apiToken?: string;
    readonly devModeAuthDisabled: boolean;
  };
  readonly storage: {
    readonly rootDir: string;
    readonly locking: { readonly mode: 'project-file' };
  };
  readonly providers: SaivageConfig['providers'];
  readonly mcp: {
    readonly servers: SaivageConfig['mcpServers'];
  };
  readonly observability: {
    readonly logLevel: LogLevel;
  };
}

export class EnvironmentLoadError extends Error {
  readonly field: string;
  readonly expected: string;
  readonly received: string;
  readonly source: 'cli' | 'env' | 'file' | 'default';

  constructor(message: string, details: { field: string; expected: string; received: string; source: 'cli' | 'env' | 'file' | 'default' }) {
    super(message);
    this.name = 'EnvironmentLoadError';
    this.field = details.field;
    this.expected = details.expected;
    this.received = details.received;
    this.source = details.source;
  }
}

interface CliEnvironmentOptions {
  host?: string;
  port?: string;
  config?: string;
  projectRoot?: string;
  createRuntime: boolean;
}

const logLevelSchema = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);
const nodeEnvSchema = z.enum(['development', 'production', 'test']);

const environmentSchema = z.object({
  nodeEnv: nodeEnvSchema,
  projectRoot: z.string().min(1),
  configAuthority: z.custom<ResolvedConfigAuthority>(),
  config: z.custom<SaivageConfig>(),
  configWarnings: z.array(z.string()),
  server: z.object({
    host: z.string().min(1),
    port: z.number().int().min(0).max(65535),
    corsOrigins: z.array(z.string()),
    logLevel: logLevelSchema,
  }),
  auth: z.object({
    apiToken: z.string().min(1).optional(),
    devModeAuthDisabled: z.boolean(),
  }),
  storage: z.object({
    rootDir: z.string().min(1),
    locking: z.object({ mode: z.literal('project-file') }),
  }),
  providers: z.record(z.string(), z.unknown()),
  mcp: z.object({ servers: z.record(z.string(), z.unknown()).optional() }),
  observability: z.object({ logLevel: logLevelSchema }),
});

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function parseCli(argv: readonly string[]): CliEnvironmentOptions {
  const args = argv.slice(2);
  const command = args[0];
  const rest = command === 'start' ? args.slice(1) : args;
  const parsed = parseArgs({
    args: rest,
    options: {
      host: { type: 'string' },
      port: { type: 'string' },
      config: { type: 'string' },
      'project-root': { type: 'string' },
      'create-runtime': { type: 'boolean' },
    },
    allowPositionals: false,
    strict: false,
  });
  const values = parsed.values as Omit<CliEnvironmentOptions, 'createRuntime'> & { 'project-root'?: string; 'create-runtime'?: boolean };
  return {
    host: values.host,
    port: values.port,
    config: values.config,
    projectRoot: values['project-root'],
    createRuntime: values['create-runtime'] === true,
  };
}

function parsePort(raw: string | undefined, source: 'cli' | 'env'): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) {
    throw new EnvironmentLoadError(`Invalid server port from ${source}: expected integer 0-65535`, { field: 'server.port', expected: 'integer 0-65535', received: 'non-integer', source });
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new EnvironmentLoadError(`Invalid server port from ${source}: expected integer 0-65535`, { field: 'server.port', expected: 'integer 0-65535', received: String(port), source });
  }
  return port;
}

function parseNodeEnv(raw: string | undefined): NodeEnvironment {
  if (raw === undefined || raw === '') return 'production';
  const parsed = nodeEnvSchema.safeParse(raw);
  if (!parsed.success) {
    throw new EnvironmentLoadError('Invalid NODE_ENV: expected development, production, or test', { field: 'nodeEnv', expected: 'development | production | test', received: 'invalid value', source: 'env' });
  }
  return parsed.data;
}

function parseLogLevel(raw: string | undefined): LogLevel | undefined {
  if (raw === undefined || raw === '') return undefined;
  const parsed = logLevelSchema.safeParse(raw);
  if (!parsed.success) {
    throw new EnvironmentLoadError('Invalid LOG_LEVEL: expected a pino log level', { field: 'server.logLevel', expected: 'fatal | error | warn | info | debug | trace | silent', received: 'invalid value', source: 'env' });
  }
  return parsed.data;
}

export async function loadEnvironment(argv: readonly string[], env: EnvironmentSource): Promise<Environment> {
  const cli = parseCli(argv);
  const projectRoot = realpathSync(resolve(cli.projectRoot ?? env['SAIVAGE_PROJECT_ROOT'] ?? process.cwd()));
  const source: ConfigSelectionSource = cli.config !== undefined
    ? { kind: 'cli', argument: '--config' }
    : env['SAIVAGE_CONFIG'] !== undefined
      ? { kind: 'environment', variable: 'SAIVAGE_CONFIG' }
      : { kind: 'default' };
  const configPath = resolve(cli.config ?? env['SAIVAGE_CONFIG'] ?? `${projectRoot}/.saivage/saivage.yaml`);
  const configAuthority = createResolvedConfigAuthority({ path: configPath, source, interpolationEnvironment: env });
  if (cli.createRuntime) await configAuthority.initializeCanonicalDefaultIfMissing();
  let config: SaivageConfig;
  let warnings: readonly string[];
  try {
    ({ config, warnings } = configAuthority.loadEffective());
  } catch (error) {
    const failure = error as Error & { fieldPath?: string };
    throw new EnvironmentLoadError(`Configuration validation failed: ${failure.message}`, {
      field: failure.fieldPath ?? 'config', expected: 'valid canonical configuration', received: 'invalid or missing selected config', source: 'file',
    });
  }

  const envPort = parsePort(env['SAIVAGE_PORT'], 'env');
  const cliPort = parsePort(cli.port, 'cli');
  const logLevel = parseLogLevel(env['LOG_LEVEL']) ?? 'info';
  const nodeEnv = parseNodeEnv(env['NODE_ENV']);
  const apiToken = env['SAIVAGE_API_TOKEN'] && env['SAIVAGE_API_TOKEN'].trim() !== '' ? env['SAIVAGE_API_TOKEN'] : undefined;

  const candidate = {
    nodeEnv,
    projectRoot,
    configAuthority,
    config,
    configWarnings: warnings,
    server: {
      host: cli.host ?? env['SAIVAGE_HOST'] ?? config.server.host ?? '0.0.0.0',
      port: cliPort ?? envPort ?? config.server.port ?? 8080,
      corsOrigins: [],
      logLevel,
    },
    auth: {
      apiToken,
      devModeAuthDisabled: apiToken === undefined,
    },
    storage: {
      rootDir: `${projectRoot}/.saivage`,
      locking: { mode: 'project-file' as const },
    },
    providers: config.providers,
    mcp: {
      servers: config.mcpServers,
    },
    observability: {
      logLevel,
    },
  };

  const parsed = environmentSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new EnvironmentLoadError(`Environment validation failed: ${issue?.path.join('.') ?? '<root>'}: ${issue?.message ?? 'invalid value'}`, { field: issue?.path.join('.') ?? 'environment', expected: issue?.message ?? 'schema match', received: 'invalid value', source: 'default' });
  }

  const result = parsed.data as Environment;
  for (const [key, value] of Object.entries(result)) {
    if (key !== 'configAuthority') deepFreeze(value);
  }
  return Object.freeze(result);
}
