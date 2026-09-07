import { resolve } from 'node:path';
import { z } from 'zod';
import type { EnvironmentSource } from './env-interpolation.js';
import type { SaivageConfig } from '../schemas/saivage-config.js';
import { createResolvedConfigAuthority, type ResolvedConfigAuthority } from './resolved-config-authority.js';
import { realpathSync } from 'node:fs';
import type { CompiledProjectWorkflows } from '../runtime/card-process/card-process-config.js';

type NodeEnvironment = 'development' | 'production' | 'test';
type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface Environment {
  readonly nodeEnv: NodeEnvironment;
  readonly projectRoot: string;
  readonly configAuthority: ResolvedConfigAuthority;
  readonly config: SaivageConfig;
  readonly workflows:CompiledProjectWorkflows;
  readonly server: {
    readonly host: string;
    readonly port: number;
    readonly logLevel: LogLevel;
  };
  readonly auth: {
    readonly apiToken?: string;
    readonly devModeAuthDisabled: boolean;
  };
}

class EnvironmentLoadError extends Error {
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

export interface StartInputs {
  readonly host?: string;
  readonly port?: string;
  readonly config?: string;
  readonly projectRoot?: string;
  readonly createRuntime: boolean;
}

const logLevelSchema = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);
const nodeEnvSchema = z.enum(['development', 'production', 'test']);

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function parsePort(raw: string, source: 'cli' | 'env'): number {
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

export function resolveStartupProjectRoot(inputs: StartInputs, env: EnvironmentSource): string {
  const selected = inputs.projectRoot ?? env['SAIVAGE_PROJECT_ROOT'] ?? process.cwd();
  return realpathSync(resolve(selected));
}

export async function loadEnvironment(inputs: StartInputs, env: EnvironmentSource): Promise<Environment> {
  const projectRoot = resolveStartupProjectRoot(inputs, env);
  const selectedConfig = inputs.config ?? env['SAIVAGE_CONFIG'] ?? `${projectRoot}/.saivage/saivage.yaml`;
  const configPath = resolve(selectedConfig);
  const configAuthority = createResolvedConfigAuthority({ path: configPath, interpolationEnvironment: env,projectRoot });
  let config: SaivageConfig;
  let workflows:CompiledProjectWorkflows;
  try {
    ({ config,workflows } = configAuthority.loadEffective());
  } catch (error) {
    const failure = error as Error & { fieldPath?: string };
    throw new EnvironmentLoadError(`Configuration validation failed: ${failure.message}`, {
      field: failure.fieldPath ?? 'config', expected: 'valid canonical configuration', received: 'invalid or missing selected config', source: 'file',
    });
  }

  const port = inputs.port !== undefined
    ? parsePort(inputs.port, 'cli')
    : env['SAIVAGE_PORT'] !== undefined
      ? parsePort(env['SAIVAGE_PORT'], 'env')
      : config.server.port ?? 8080;
  const logLevel = parseLogLevel(env['LOG_LEVEL']) ?? 'info';
  const nodeEnv = parseNodeEnv(env['NODE_ENV']);
  const apiToken = env['SAIVAGE_API_TOKEN'] && env['SAIVAGE_API_TOKEN'].trim() !== '' ? env['SAIVAGE_API_TOKEN'] : undefined;

  const candidate: Environment = {
    nodeEnv,
    projectRoot,
    configAuthority,
    config,
    workflows,
    server: {
      host: inputs.host ?? env['SAIVAGE_HOST'] ?? config.server.host ?? '0.0.0.0',
      port,
      logLevel,
    },
    auth: {
      apiToken,
      devModeAuthDisabled: apiToken === undefined,
    },
  };

  for (const [key, value] of Object.entries(candidate)) {
    if (key !== 'configAuthority') deepFreeze(value);
  }
  return Object.freeze(candidate);
}
