import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { parseArgs } from 'node:util';
import * as YAML from 'yaml';
import { interpolateValue, type EnvironmentSource } from './env-interpolation.js';
import { saivageConfigSchema, type SaivageConfig } from '../agents/config-api.js';
import { validateModelRoles } from './validate-model-roles.js';

export type NodeEnvironment = 'development' | 'production' | 'test';
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface Environment {
  readonly nodeEnv: NodeEnvironment;
  readonly projectRoot: string;
  readonly configPath: string;
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
}

const logLevelSchema = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);
const nodeEnvSchema = z.enum(['development', 'production', 'test']);

const environmentSchema = z.object({
  nodeEnv: nodeEnvSchema,
  projectRoot: z.string().min(1),
  configPath: z.string().min(1),
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
  const values = parsed.values as CliEnvironmentOptions & { 'project-root'?: string };
  return {
    host: values.host,
    port: values.port,
    config: values.config,
    projectRoot: values['project-root'],
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

function legacyJsonPathDiagnostic(defaultYamlPath: string, legacyJsonPath: string): EnvironmentLoadError {
  return new EnvironmentLoadError(
    `The config path ${legacyJsonPath} is obsolete. The canonical project config file is .saivage/saivage.yaml. Use ${defaultYamlPath} (or another YAML config path) instead. Saivage will not read or parse the old JSON path.`,
    { field: 'configPath', expected: '.saivage/saivage.yaml or another YAML config path', received: '.saivage/saivage.json', source: 'file' },
  );
}

function legacyJsonRenameDiagnostic(defaultYamlPath: string, legacyJsonPath: string): EnvironmentLoadError {
  return new EnvironmentLoadError(
    `Configuration file ${defaultYamlPath} was not found, but the obsolete ${legacyJsonPath} exists. The canonical project config file is now .saivage/saivage.yaml. Rename ${legacyJsonPath} to ${defaultYamlPath} (the file content is valid YAML 1.2 — JSON is a strict subset — so no other change is needed) and restart.`,
    { field: 'configPath', expected: '.saivage/saivage.yaml (rename the existing .saivage/saivage.json)', received: '.saivage/saivage.json present, .saivage/saivage.yaml missing', source: 'file' },
  );
}

function legacyJsonBothExistDiagnostic(defaultYamlPath: string, legacyJsonPath: string): EnvironmentLoadError {
  return new EnvironmentLoadError(
    `Both ${defaultYamlPath} and ${legacyJsonPath} exist. The canonical project config file is .saivage/saivage.yaml; .saivage/saivage.json is obsolete and may still contain provider credentials. Delete ${legacyJsonPath} (or move it outside .saivage/ if you need a backup) and restart.`,
    { field: 'configPath', expected: '.saivage/saivage.yaml (sole canonical config file)', received: 'both .saivage/saivage.yaml and .saivage/saivage.json present', source: 'file' },
  );
}

function readConfigFile(configPath: string, projectRoot: string, env: EnvironmentSource): { config: SaivageConfig; warnings: string[] } {
  const defaultYamlPath = resolve(projectRoot, '.saivage/saivage.yaml');
  const legacyJsonPath = resolve(projectRoot, '.saivage/saivage.json');
  const usesLegacyJsonPath = configPath === legacyJsonPath;
  const defaultYamlExists = existsSync(defaultYamlPath);
  const legacyJsonExists = existsSync(legacyJsonPath);

  if (usesLegacyJsonPath) throw legacyJsonPathDiagnostic(defaultYamlPath, legacyJsonPath);
  if (legacyJsonExists && defaultYamlExists) throw legacyJsonBothExistDiagnostic(defaultYamlPath, legacyJsonPath);
  if (legacyJsonExists && !defaultYamlExists) throw legacyJsonRenameDiagnostic(defaultYamlPath, legacyJsonPath);

  if (!existsSync(configPath)) {
    throw new EnvironmentLoadError(`Configuration not found at ${configPath}`, { field: 'configPath', expected: 'existing saivage.yaml file', received: 'missing file', source: 'file' });
  }

  let rawObj: unknown;
  try {
    rawObj = YAML.parse(readFileSync(configPath, 'utf-8'));
  } catch (err) {
    throw new EnvironmentLoadError(`Failed to parse saivage.yaml: ${err instanceof Error ? err.message : String(err)}`, { field: 'config', expected: 'valid YAML', received: 'invalid YAML', source: 'file' });
  }

  const { value: interpolated, warnings } = interpolateValue(rawObj, env, { skipRootKeys: new Set(['prompts']) });
  const parsed = saivageConfigSchema.safeParse(interpolated);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ');
    throw new EnvironmentLoadError(`Configuration validation failed: ${issues}`, { field: parsed.error.issues[0]?.path.join('.') || 'config', expected: parsed.error.issues[0]?.message ?? 'schema match', received: 'invalid config value', source: 'file' });
  }
  return { config: parsed.data, warnings };
}

export function loadEnvironment(argv: readonly string[], env: EnvironmentSource): Environment {
  const cli = parseCli(argv);
  const projectRoot = resolve(cli.projectRoot ?? env['SAIVAGE_PROJECT_ROOT'] ?? process.cwd());
  const configPath = resolve(cli.config ?? env['SAIVAGE_CONFIG'] ?? `${projectRoot}/.saivage/saivage.yaml`);
  const { config, warnings } = readConfigFile(configPath, projectRoot, env);

  const envPort = parsePort(env['SAIVAGE_PORT'], 'env');
  const cliPort = parsePort(cli.port, 'cli');
  const logLevel = parseLogLevel(env['LOG_LEVEL']) ?? 'info';
  const nodeEnv = parseNodeEnv(env['NODE_ENV']);
  const apiToken = env['SAIVAGE_API_TOKEN'] && env['SAIVAGE_API_TOKEN'].trim() !== '' ? env['SAIVAGE_API_TOKEN'] : undefined;

  const candidate = {
    nodeEnv,
    projectRoot,
    configPath,
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

  const roleCheck = validateModelRoles(parsed.data.config);
  if (!roleCheck.ok) {
    const missing = roleCheck.missingRoles.join(', ');
    const lines = [`Configuration validation failed: missing model role(s): ${missing}.`];
    for (const r of roleCheck.missingRoles) {
      // This diagnostic must point at the canonical YAML config; legacy JSON is named only by transition-gate errors above.
      lines.push(`  models.${r} = (unset) — set "models.${r}" to a model name or a non-empty array of model names, or route it via "models.routing['${r}']" to a "models.profiles[<name>]" entry (preferred + allowed), in .saivage/saivage.yaml`);
    }
    lines.push('  or set "models.default" as a shared fallback (used by every role that does not resolve directly or via routing)');
    const present = Object.entries(roleCheck.configuredRoles).map(([r, ms]) => `${r} = ${JSON.stringify(ms)}`);
    if (present.length > 0) lines.push(`Roles defined in this config: ${present.join(', ')}`);
    throw new EnvironmentLoadError(lines.join('\n'), {
      field: `models.${roleCheck.missingRoles[0]}`,
      expected: 'a model name or non-empty array (models.<role>), a models.routing[role] -> models.profiles[<name>] path, or models.default',
      received: 'unset',
      source: 'file',
    });
  }

  return deepFreeze(parsed.data as Environment);
}
