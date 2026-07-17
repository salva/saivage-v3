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
  transportProtocol: z.enum(['openai-chat-completions', 'openai-codex-backend', 'openai-responses']).optional(),
  toolsMode: z.enum(['native', 'unsupported']).optional(),
  exclusiveToolChoiceSupport: z.enum(['native', 'parallel_off', 'unsupported']).optional(),
  streaming: z.boolean().optional(),
  responsesReasoning: z.object({ effort: z.enum(['minimal', 'low', 'medium', 'high']).optional() }).strict().optional(),
  contextWindowTokens: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  quirks: z.array(z.string()).optional(),
}).strict();

// Provider account
const providerAccountSchema = z.object({
  priority: z.number().int().optional(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
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
  process_timeouts: processTimeoutsPersistedSchema.default({}),
}).strict().transform((runtime) => ({
  continuousImprovement: runtime.continuous_improvement,
  processTimeouts: {
    plannerMs: runtime.process_timeouts.planner_ms,
    executorMs: runtime.process_timeouts.executor_ms,
    reviewerMs: runtime.process_timeouts.reviewer_ms,
  },
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

export const candidateSchema = z.object({
  provider: z.string().min(1),
  account: z.union([z.string().min(1), z.literal(null)]),
  model: z.string().min(1),
}).strict();

const compactionSectionSchema = z.object({
  enabled: z.literal(true),
  input_budget_tokens: z.number().int().positive(),
  trigger_fraction: z.number().positive().max(1).default(0.80),
  completion_reserve_fraction: z.number().positive().max(1).default(0.20),
  merge_line_fraction: z.number().nonnegative().max(1).default(0.30),
  summary_line_fraction: z.number().nonnegative().max(1).default(0.50),
  escalate_merge_line_fraction: z.number().nonnegative().max(1).default(0.40),
  escalate_summary_line_fraction: z.number().nonnegative().max(1).default(0.60),
  snap: z.enum(['keep_straddler_verbatim', 'compact_straddler']).default('keep_straddler_verbatim'),
  summarizer_candidate: candidateSchema,
}).strict().superRefine((value, ctx) => {
  if (value.merge_line_fraction > value.summary_line_fraction) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['merge_line_fraction'], message: 'merge_line_fraction must be <= summary_line_fraction' });
  if (value.summary_line_fraction > value.trigger_fraction) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['summary_line_fraction'], message: 'summary_line_fraction must be <= trigger_fraction' });
  if (value.escalate_merge_line_fraction > value.escalate_summary_line_fraction) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['escalate_merge_line_fraction'], message: 'escalate_merge_line_fraction must be <= escalate_summary_line_fraction' });
  if (value.escalate_summary_line_fraction > value.trigger_fraction) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['escalate_summary_line_fraction'], message: 'escalate_summary_line_fraction must be <= trigger_fraction' });
  if (value.trigger_fraction + value.completion_reserve_fraction > 1) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['completion_reserve_fraction'], message: 'trigger_fraction + completion_reserve_fraction must be <= 1' });
  const normalTailWidth = value.trigger_fraction - value.summary_line_fraction;
  const normalMiddleWidth = value.summary_line_fraction - value.merge_line_fraction;
  const escalatedTailWidth = value.trigger_fraction - value.escalate_summary_line_fraction;
  const escalatedMiddleWidth = value.escalate_summary_line_fraction - value.escalate_merge_line_fraction;
  if (escalatedTailWidth > normalTailWidth) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['escalate_summary_line_fraction'], message: `Escalated compaction tail width must be <= normal tail width (trigger - summary): escalated=${JSON.stringify(escalatedTailWidth)}, normal=${JSON.stringify(normalTailWidth)}.` });
  if (escalatedMiddleWidth > normalMiddleWidth) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['escalate_merge_line_fraction'], message: `Escalated compaction middle width must be <= normal middle width (summary - merge): escalated=${JSON.stringify(escalatedMiddleWidth)}, normal=${JSON.stringify(normalMiddleWidth)}.` });
  if (Math.floor(value.input_budget_tokens * value.completion_reserve_fraction) < 1) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['completion_reserve_fraction'], message: 'compaction requestedCompletionTokens must be positive' });
});

// MCP Server entry
const mcpServerEntrySchema = z.object({
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().optional(),
  transport: z.enum(['stdio', 'streamable-http']),
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
  compaction: compactionSectionSchema,
  mcpServers: z.record(z.string(), mcpServerEntrySchema).optional(),
}).strict();

// ── Derived Types ─────────────────────────────────────────────

export type SaivageConfig = z.infer<typeof saivageConfigSchema>;
export type ProviderEntry = z.infer<typeof providerEntrySchema>;
export type ProviderAccount = z.infer<typeof providerAccountSchema>;
export type ProviderCapabilities = z.infer<typeof providerCapabilitySchema>;

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
