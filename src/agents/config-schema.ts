import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';

// ── Environment Variable Interpolation ────────────────────────

const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Resolve `${ENV_VAR}` references in a string against process.env.
 * Unknown variables are replaced with an empty string and recorded
 * as warnings.
 */
export interface EnvInterpolationResult {
  value: string;
  warnings: string[];
}

function interpolateString(raw: string): EnvInterpolationResult {
  const warnings: string[] = [];
  const value = raw.replace(ENV_PATTERN, (_match, name: string) => {
    const envVal = process.env[name];
    if (envVal === undefined) {
      warnings.push(`Environment variable '${name}' is not set.`);
      return '';
    }
    return envVal;
  });
  return { value, warnings };
}

/**
 * Deep-interpolate ${ENV_VAR} references in any JSON-compatible value.
 */
function interpolateValue(v: unknown): { value: unknown; warnings: string[] } {
  if (typeof v === 'string') {
    return interpolateString(v);
  }
  if (Array.isArray(v)) {
    const results = v.map((item) => interpolateValue(item));
    return {
      value: results.map((r) => r.value),
      warnings: results.flatMap((r) => r.warnings),
    };
  }
  if (v !== null && typeof v === 'object') {
    const result: Record<string, unknown> = {};
    const warnings: string[] = [];
    for (const [key, val] of Object.entries(v as Record<string, unknown>)) {
      const { value: iv, warnings: iw } = interpolateValue(val);
      result[key] = iv;
      warnings.push(...iw);
    }
    return { value: result, warnings };
  }
  return { value: v, warnings: [] };
}

// ── Zod Schemas ───────────────────────────────────────────────

// Model list: a single string or array of strings, normalized to array
const modelListSchema = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => (typeof v === 'string' ? [v] : v));

// Routing profile
const routingProfileSchema = z.object({
  preferred: z.array(z.string()).default([]),
  allowed: z.array(z.string()).default([]),
});

// Models section
const modelsSectionSchema = z.object({
  // Per-role model lists
  planner: modelListSchema.optional(),
  executor: modelListSchema.optional(),
  reviewer: modelListSchema.optional(),
  analyst: modelListSchema.optional(),
  manager: modelListSchema.optional(),
  coder: modelListSchema.optional(),
  researcher: modelListSchema.optional(),
  data_agent: modelListSchema.optional(),
  inspector: modelListSchema.optional(),
  chat: modelListSchema.optional(),
  default: modelListSchema.optional(),
  // Per-role temperature (0..2)
  temperature: z
    .object({
      planner: z.number().min(0).max(2).optional(),
      executor: z.number().min(0).max(2).optional(),
      reviewer: z.number().min(0).max(2).optional(),
      analyst: z.number().min(0).max(2).optional(),
      manager: z.number().min(0).max(2).optional(),
      coder: z.number().min(0).max(2).optional(),
      researcher: z.number().min(0).max(2).optional(),
      data_agent: z.number().min(0).max(2).optional(),
      inspector: z.number().min(0).max(2).optional(),
      chat: z.number().min(0).max(2).optional(),
      default: z.number().min(0).max(2).optional(),
    })
    .optional(),
  // Per-role max_tokens
  max_tokens: z
    .object({
      planner: z.number().int().positive().optional(),
      executor: z.number().int().positive().optional(),
      reviewer: z.number().int().positive().optional(),
      analyst: z.number().int().positive().optional(),
      manager: z.number().int().positive().optional(),
      coder: z.number().int().positive().optional(),
      researcher: z.number().int().positive().optional(),
      data_agent: z.number().int().positive().optional(),
      inspector: z.number().int().positive().optional(),
      chat: z.number().int().positive().optional(),
      default: z.number().int().positive().optional(),
    })
    .optional(),
  // Routing profiles
  profiles: z.record(z.string(), routingProfileSchema).optional(),
  routing: z.record(z.string(), z.string()).optional(),
  // Model equivalents
  equivalents: z.array(z.array(z.string())).optional(),
  // Failover chains
  failover: z.record(z.string(), z.array(z.string())).optional(),
});

// Provider account
const providerAccountSchema = z.object({
  priority: z.number().int().optional(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  tokenEndpoint: z.string().optional(),
  authProfile: z.string().optional(),
  models: z.array(z.string()).optional(),
});

// Provider entry
const providerEntrySchema = z.object({
  priority: z.number().int().optional(),
  models: z.array(z.string()).optional(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  tokenEndpoint: z.string().optional(),
  authProfile: z.string().optional(),
  accounts: z.record(z.string(), providerAccountSchema).optional(),
});

// Server section
const serverSectionSchema = z.object({
  port: z.number().int().positive().default(8080),
  host: z.string().default('0.0.0.0'),
});

// Self-check configuration for the self-check mechanism
const selfCheckSchema = z.object({
  executor: z.number().int().nonnegative().default(15),
  planner: z.number().int().nonnegative().default(30),
  analyst: z.number().int().nonnegative().default(0),
});

// Runtime section
const runtimeSectionSchema = z.object({
  recoverAgentInvocations: z.boolean().default(true),
  healthCheckIntervalMs: z.number().int().positive().default(30000),
  idleShutdownMs: z.number().int().positive().default(300000),
  maxGoalDepth: z.number().int().positive().default(5),
  recoveryDelayMs: z.number().int().positive().default(60000),
  continuousImprovement: z.boolean().default(false),
  // Compaction defaults
  compactionThreshold: z.number().min(0).max(1).default(0.8),
  maxCompactions: z.number().int().nonnegative().default(3),
  compactionTimeoutMs: z.number().int().positive().default(1200000),
  compactionKeepFraction: z.number().min(0).max(1).default(0.2),
  // Recovery defaults
  maxRecoveryRetries: z.number().int().nonnegative().default(3),
  // Self-check configuration
  selfCheck: selfCheckSchema.default({}),
});

// Security section
const securitySectionSchema = z.object({
  injectionScanner: z.boolean().default(true),
  injectionModel: z.string().optional(),
  maxScanLengthBytes: z.number().int().positive().default(102400),
});

// Supervisor section
const supervisorSectionSchema = z.object({
  enabled: z.boolean().default(true),
  model: z.string().optional(),
  intervalMs: z.number().int().positive().default(1200000),
  consecutiveStuckVerdicts: z.number().int().positive().default(3),
  logLines: z.number().int().positive().default(400),
});

// Telegram section
const telegramSectionSchema = z.object({
  botToken: z.string().optional(),
  allowedUserIds: z.array(z.number().int()).optional(),
});

// Notifications section
const notificationsSectionSchema = z.object({
  channels: z.array(z.string()).default(['web']),
  filters: z
    .object({
      min_severity: z.string().default('info'),
      categories: z.array(z.string()).optional(),
    })
    .optional(),
});

// MCP Server entry
const mcpServerEntrySchema = z.object({
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().optional(),
  transport: z.enum(['stdio', 'sse']),
  disabled: z.boolean().default(false),
  autostart: z.boolean().default(true),
});

// ── Full Config Schema ────────────────────────────────────────

export const saivageConfigSchema = z.object({
  models: modelsSectionSchema.default({}),
  providers: z.record(z.string(), providerEntrySchema).default({}),
  server: serverSectionSchema.default({}),
  runtime: runtimeSectionSchema.default({}),
  security: securitySectionSchema.default({}),
  supervisor: supervisorSectionSchema.default({}),
  telegram: telegramSectionSchema.optional(),
  notifications: notificationsSectionSchema.optional(),
  mcpServers: z.record(z.string(), mcpServerEntrySchema).optional(),
  failover: z.record(z.string(), z.array(z.string())).optional(),
});

// ── Derived Types ─────────────────────────────────────────────

export type SaivageConfig = z.infer<typeof saivageConfigSchema>;
export type ModelList = z.infer<typeof modelListSchema>;
export type RoutingProfile = z.infer<typeof routingProfileSchema>;
export type ProviderEntry = z.infer<typeof providerEntrySchema>;
export type ProviderAccount = z.infer<typeof providerAccountSchema>;
export type RuntimeSection = z.infer<typeof runtimeSectionSchema>;
export type ModelsSection = z.infer<typeof modelsSectionSchema>;
export type SelfCheckConfig = z.infer<typeof selfCheckSchema>;

// ── Token Endpoint Resolution ─────────────────────────────────

/**
 * Resolve the effective OAuth token endpoint URI.
 *
 * Resolution order:
 * 1. If tokenEndpoint is explicitly set, use it.
 * 2. Otherwise, infer from baseUrl as `{origin}/oauth/token`.
 * 3. If neither is usable, return undefined.
 */
export function resolveTokenEndpoint(
  tokenEndpoint: string | undefined,
  baseUrl: string | undefined,
): string | undefined {
  if (tokenEndpoint) return tokenEndpoint;
  if (!baseUrl) return undefined;
  try {
    const url = new URL(baseUrl);
    return `${url.origin}/oauth/token`;
  } catch {
    return undefined;
  }
}

// ── Model Params ──────────────────────────────────────────────

export interface ModelParams {
  temperature: number;
  maxTokens: number;
}

/**
 * Get temperature and max_tokens for a role using the fallback chain:
 * role-specific → models.default → hardcoded defaults (0.7, 4096)
 */
export function getModelParamsForRole(
  config: SaivageConfig,
  role: string,
): ModelParams {
  const models = config.models;
  const tempMap = models.temperature ?? {};
  const tokensMap = models.max_tokens ?? {};

  const temperature =
    (tempMap as Record<string, number | undefined>)[role] ??
    (tempMap as Record<string, number | undefined>)['default'] ??
    0.7;

  const maxTokens =
    (tokensMap as Record<string, number | undefined>)[role] ??
    (tokensMap as Record<string, number | undefined>)['default'] ??
    4096;

  return { temperature, maxTokens };
}

// ── Loading ───────────────────────────────────────────────────

export interface ConfigLoadResult {
  config: SaivageConfig;
  warnings: string[];
}

/**
 * Load saivage.json from a project root directory.
 * Performs env interpolation first, then Zod validation.
 * Returns the validated config and any interpolation warnings.
 */
export function loadConfig(projectRoot: string): ConfigLoadResult {
  const configPath = `${projectRoot}/.saivage/saivage.json`;
  if (!existsSync(configPath)) {
    throw new Error(`Configuration not found at ${configPath}`);
  }

  const raw = readFileSync(configPath, 'utf-8');
  let rawObj: unknown;
  try {
    rawObj = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse saivage.json: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Interpolate env vars
  const { value: interpolated, warnings } = interpolateValue(rawObj);

  // Validate with Zod
  const parsed = saivageConfigSchema.safeParse(interpolated);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuration validation failed:\n${issues}`);
  }

  return { config: parsed.data, warnings };
}

/**
 * Normalize a role string to one of the known agent roles.
 * Returns the role's model list, using the 'default' list as fallback.
 */
export function getModelListForRole(
  config: SaivageConfig,
  role: string,
): string[] {
  // First try direct model list
  const models = config.models;
  const direct = (models as Record<string, unknown>)[role];
  if (Array.isArray(direct)) {
    return direct as string[];
  }

  // Check routing profiles
  if (models.routing && models.profiles) {
    const profileName = models.routing[role];
    if (profileName) {
      const profile = models.profiles[profileName];
      if (profile) {
        return [...profile.preferred, ...profile.allowed];
      }
    }
  }

  // Fallback to default
  if (models.default) {
    return models.default;
  }

  throw new Error(`No model list configured for role '${role}' and no default.`);
}

/**
 * Get the runtime section with all defaults applied.
 */
export function getRuntimeConfig(config: SaivageConfig): RuntimeSection {
  return config.runtime;
}

/**
 * Get the self-check round threshold for a role.
 * Returns 0 (never) for unknown roles.
 */
export function getSelfCheckThreshold(
  config: SaivageConfig,
  role: string,
): number {
  const sc = config.runtime.selfCheck;
  if (!sc) return 0;
  return (sc as Record<string, number | undefined>)[role] ?? 0;
}
