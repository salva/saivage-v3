import { z } from 'zod';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

const modelEquivalentsSchema = z.preprocess((value) => {
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([model, equivalents]) => {
      if (Array.isArray(equivalents)) return [[model, ...equivalents]];
      if (typeof equivalents === 'string') return [[model, equivalents]];
      return [];
    });
  }
  return value;
}, z.array(z.array(z.string())));

// Reserved keys that have non-role-list shapes inside the models section.
const MODELS_RESERVED_KEYS = new Set(['temperature', 'max_tokens', 'profiles', 'routing', 'equivalents', 'failover', 'default']);

// Models section: role names are open — any string key whose value is a model list is accepted.
// Reserved sub-keys carry richer shapes (per-role temperatures, routing, etc.).
const modelsSectionSchema = z
  .object({
    temperature: z.record(z.string(), z.number().min(0).max(2)).optional(),
    max_tokens: z.record(z.string(), z.number().int().positive()).optional(),
    profiles: z.record(z.string(), routingProfileSchema).optional(),
    routing: z.record(z.string(), z.string()).optional(),
    equivalents: modelEquivalentsSchema.optional(),
    failover: z.record(z.string(), z.array(z.string())).optional(),
    default: z.array(z.string()).min(1).optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    const defaultChain = (value as { default?: string[] }).default;
    const defaultKey = defaultChain ? JSON.stringify(defaultChain) : null;
    for (const [key, raw] of Object.entries(value)) {
      if (MODELS_RESERVED_KEYS.has(key)) continue;
      const parsed = modelListSchema.safeParse(raw);
      if (!parsed.success) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `models.${key} must be a model name or an array of model names` });
        continue;
      }
      const arr = parsed.data;
      if (arr.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `models.${key}: empty array; remove the key to inherit models.default.` });
        continue;
      }
      if (defaultKey !== null && JSON.stringify(arr) === defaultKey) {
        delete (value as Record<string, unknown>)[key];
        continue;
      }
      // Normalize: replace the raw entry with the parsed (always-array) form.
      (value as Record<string, unknown>)[key] = arr;
    }
  });

// Provider capabilities
export const providerCapabilitySchema = z.object({
  transportProtocol: z.enum(['openai-chat-completions', 'openai-codex-backend']).optional(),
  toolsMode: z.enum(['native', 'unsupported']).optional(),
  exclusiveToolChoiceSupport: z.enum(['native', 'parallel_off', 'unsupported']).optional(),
  streaming: z.boolean().optional(),
  contextWindowTokens: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  quirks: z.array(z.string()).optional(),
}).strict();

// Provider account
const providerAccountSchema = z.object({
  priority: z.number().int().optional(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  tokenEndpoint: z.string().optional(),
  authProfile: z.string().optional(),
  models: z.array(z.string()).optional(),
  capabilities: providerCapabilitySchema.optional(),
});

// Provider entry
const providerEntrySchema = z.object({
  priority: z.number().int().optional(),
  models: z.array(z.string()).optional(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  tokenEndpoint: z.string().optional(),
  authProfile: z.string().optional(),
  capabilities: providerCapabilitySchema.optional(),
  modelCapabilities: z.record(z.string(), providerCapabilitySchema).optional(),
  accounts: z.record(z.string(), providerAccountSchema).optional(),
});

// Server section
const serverSectionSchema = z.object({
  port: z.number().int().positive().default(8080),
  host: z.string().default('0.0.0.0'),
});

// Runtime section
const processTimeoutsPersistedSchema = z.object({
  planner_ms: z.number().int().positive().default(1200000),
  executor_ms: z.number().int().positive().default(1200000),
  reviewer_ms: z.number().int().positive().default(1200000),
}).strict();

export const runtimeSectionSchema = z.object({
  continuous_improvement: z.boolean().default(false),
  max_review_retries: z.number().int().nonnegative().default(3),
  process_timeouts: processTimeoutsPersistedSchema.default({}),
  candidate_availability_compact_bytes: z.number().int().positive().default(262144),
}).strict().transform((runtime) => ({
  continuousImprovement: runtime.continuous_improvement,
  maxReviewRetries: runtime.max_review_retries,
  processTimeouts: {
    plannerMs: runtime.process_timeouts.planner_ms,
    executorMs: runtime.process_timeouts.executor_ms,
    reviewerMs: runtime.process_timeouts.reviewer_ms,
  },
  candidateAvailabilityCompactBytes: runtime.candidate_availability_compact_bytes,
}));

// Security section
const securitySectionSchema = z.object({
  injectionScanner: z.boolean().default(true),
  injectionModel: z.string().optional(),
  maxScanLengthBytes: z.number().int().positive().default(102400),
});

// Telegram section
const telegramSectionSchema = z.object({
  botToken: z.string().optional(),
  allowedUserIds: z.array(z.number().int()).optional(),
  notificationChatIds: z.array(z.number().int().safe().refine((value) => value !== 0, { message: 'Chat id must be a non-zero safe integer' })).default([]),
});

// Notifications section
export const notificationChannelSchema = z.enum(['web', 'telegram']);

const notificationsSectionSchema = z.object({
  channels: z.array(notificationChannelSchema).default(['web']),
}).strict();

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
  telegram: telegramSectionSchema.optional(),
  notifications: notificationsSectionSchema.optional(),
  mcpServers: z.record(z.string(), mcpServerEntrySchema).optional(),
}).strict();

// ── Derived Types ─────────────────────────────────────────────

export type SaivageConfig = z.infer<typeof saivageConfigSchema>;
export type ModelList = z.infer<typeof modelListSchema>;
export type RoutingProfile = z.infer<typeof routingProfileSchema>;
export type ProviderEntry = z.infer<typeof providerEntrySchema>;
export type ProviderAccount = z.infer<typeof providerAccountSchema>;
export type ProviderCapabilities = z.infer<typeof providerCapabilitySchema>;
export type RuntimeSection = z.infer<typeof runtimeSectionSchema>;
export type ModelsSection = z.infer<typeof modelsSectionSchema>;
export type NotificationChannelConfig = z.infer<typeof notificationChannelSchema>;

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
  const fallback = models.default;
  if (Array.isArray(fallback)) {
    return fallback;
  }

  throw new Error(`No model list configured for role '${role}' and no default.`);
}

/**
 * Get the runtime section with all defaults applied.
 */
export function getRuntimeConfig(config: SaivageConfig): RuntimeSection {
  return config.runtime;
}
