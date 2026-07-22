import { z } from 'zod';
import type { AgentRole } from '../schemas/index.js';

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

const modelsSectionSchema = z.object({
    analyst: modelListSchema.pipe(z.array(z.string()).min(1)).optional(),
    planner: modelListSchema.pipe(z.array(z.string()).min(1)).optional(),
    executor: modelListSchema.pipe(z.array(z.string()).min(1)).optional(),
    reviewer: modelListSchema.pipe(z.array(z.string()).min(1)).optional(),
    temperature: z.object({ analyst: z.number().min(0).max(2).optional(), planner: z.number().min(0).max(2).optional(), executor: z.number().min(0).max(2).optional(), reviewer: z.number().min(0).max(2).optional(), default: z.number().min(0).max(2).optional() }).strict().optional(),
    max_tokens: z.object({ analyst: z.number().int().positive().optional(), planner: z.number().int().positive().optional(), executor: z.number().int().positive().optional(), reviewer: z.number().int().positive().optional(), default: z.number().int().positive().optional() }).strict().optional(),
    profiles: z.record(z.string(), routingProfileSchema).optional(),
    routing: z.object({ analyst: z.string().optional(), planner: z.string().optional(), executor: z.string().optional(), reviewer: z.string().optional() }).strict().optional(),
    equivalents: modelEquivalentsSchema.optional(),
    failover: z.record(z.string(), z.array(z.string())).optional(),
    default: modelListSchema.pipe(z.array(z.string()).min(1)).optional(),
  }).strict();

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
}).strict().superRefine(validateCompaction);

function validateCompaction(value: {
  input_budget_tokens: number;
  trigger_fraction: number;
  completion_reserve_fraction: number;
  merge_line_fraction: number;
  summary_line_fraction: number;
  escalate_merge_line_fraction: number;
  escalate_summary_line_fraction: number;
}, ctx: z.RefinementCtx): void {
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
  if (Math.floor(value.input_budget_tokens * value.completion_reserve_fraction) < 1) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['completion_reserve_fraction'], message: 'compaction reservedCompletionTokens must be positive' });
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

// MCP Server entry
const stdioMcpServerSchema = z.object({
  transport: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  disabled: z.boolean().default(false),
  autostart: z.boolean().default(true),
}).strict();

const streamableHttpMcpServerSchema = z.object({
  transport: z.literal('streamable-http'),
  url: z.string().refine(isHttpUrl, 'url must be an absolute HTTP(S) URL'),
  disabled: z.boolean().default(false),
  autostart: z.boolean().default(true),
}).strict();

const mcpServerEntrySchema = z.discriminatedUnion('transport', [stdioMcpServerSchema, streamableHttpMcpServerSchema]);

const processTerminalPortSchema = z.enum(['DONE', 'BLOCKED', 'FAILED']);
const processEntrySchema = z.object({
  node: z.string(),
  prompt: z.string().optional(),
}).strict();
const stoppedProcessEntrySchema = z.object({
  node: z.string(),
  prompt: z.string(),
}).strict();
const processEdgeTargetSchema = z.union([
  z.object({ node: z.string() }).strict(),
  z.object({ terminal: processTerminalPortSchema }).strict(),
]);
const processEdgeSchema = z.object({
  target: processEdgeTargetSchema,
  prompt: z.string().optional(),
}).strict();
const processRecordSchema = z.object({
  name: z.enum(['brief.md', 'status.md', 'review.md']),
  updated: z.boolean().default(false),
}).strict();
const processNodeSchema = z.object({
  role: z.enum(['planner', 'reviewer', 'executor']),
  prompt: z.string(),
  correction_prompt: z.string(),
  records: z.array(processRecordSchema).default([]),
  edges: z.record(z.string(), processEdgeSchema),
}).strict();
const cardProcessSchema = z.object({
  entries: z.object({
    BACKLOG: processEntrySchema,
    CHANGED: processEntrySchema,
    BLOCKED: processEntrySchema,
    STOPPED: stoppedProcessEntrySchema,
  }).strict(),
  nodes: z.record(z.string(), processNodeSchema),
}).strict();

export const cardProcessesSchema = z.object({
  planning: cardProcessSchema,
  terminal: cardProcessSchema,
}).strict();

const effectiveModelListSchema = z.array(z.string()).min(1);
const effectiveRoutingProfileSchema = z.object({
  preferred: z.array(z.string()),
  allowed: z.array(z.string()),
}).strict();
const effectiveModelsSectionSchema = z.object({
  analyst: effectiveModelListSchema.optional(),
  planner: effectiveModelListSchema.optional(),
  executor: effectiveModelListSchema.optional(),
  reviewer: effectiveModelListSchema.optional(),
  temperature: z.object({ analyst: z.number().min(0).max(2).optional(), planner: z.number().min(0).max(2).optional(), executor: z.number().min(0).max(2).optional(), reviewer: z.number().min(0).max(2).optional(), default: z.number().min(0).max(2).optional() }).strict().optional(),
  max_tokens: z.object({ analyst: z.number().int().positive().optional(), planner: z.number().int().positive().optional(), executor: z.number().int().positive().optional(), reviewer: z.number().int().positive().optional(), default: z.number().int().positive().optional() }).strict().optional(),
  profiles: z.record(z.string(), effectiveRoutingProfileSchema).optional(),
  routing: z.object({ analyst: z.string().optional(), planner: z.string().optional(), executor: z.string().optional(), reviewer: z.string().optional() }).strict().optional(),
  equivalents: z.array(z.array(z.string())).optional(),
  failover: z.record(z.string(), z.array(z.string())).optional(),
  default: effectiveModelListSchema.optional(),
}).strict();
const effectiveProviderAccountSchema = z.object({
  priority: z.number().int().optional(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  authProfile: z.string().optional(),
  models: z.array(z.string()).optional(),
  capabilities: providerCapabilitySchema.optional(),
}).strict();
const effectiveProviderEntrySchema = z.object({
  priority: z.number().int().optional(),
  models: z.array(z.string()).optional(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  authProfile: z.string().optional(),
  capabilities: providerCapabilitySchema.optional(),
  modelCapabilities: z.record(z.string(), providerCapabilitySchema).optional(),
  accounts: z.record(z.string(), effectiveProviderAccountSchema).optional(),
}).strict();
const effectiveServerSectionSchema = z.object({
  port: z.number().int().positive(),
  host: z.string(),
}).strict();
const effectiveRuntimeSectionSchema = z.object({
  continuousImprovement: z.boolean(),
  processTimeouts: z.object({
    plannerMs: z.number().int().positive(),
    executorMs: z.number().int().positive(),
    reviewerMs: z.number().int().positive(),
  }).strict(),
}).strict();
const effectiveCompactionSectionSchema = z.object({
  enabled: z.literal(true),
  input_budget_tokens: z.number().int().positive(),
  trigger_fraction: z.number().positive().max(1),
  completion_reserve_fraction: z.number().positive().max(1),
  merge_line_fraction: z.number().nonnegative().max(1),
  summary_line_fraction: z.number().nonnegative().max(1),
  escalate_merge_line_fraction: z.number().nonnegative().max(1),
  escalate_summary_line_fraction: z.number().nonnegative().max(1),
  snap: z.enum(['keep_straddler_verbatim', 'compact_straddler']),
  summarizer_candidate: candidateSchema,
}).strict().superRefine(validateCompaction);
const effectiveStdioMcpServerSchema = z.object({
  transport: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  disabled: z.boolean(),
  autostart: z.boolean(),
}).strict();
const effectiveStreamableHttpMcpServerSchema = z.object({
  transport: z.literal('streamable-http'),
  url: z.string().refine(isHttpUrl, 'url must be an absolute HTTP(S) URL'),
  disabled: z.boolean(),
  autostart: z.boolean(),
}).strict();
const effectiveMcpServerEntrySchema = z.discriminatedUnion('transport', [effectiveStdioMcpServerSchema, effectiveStreamableHttpMcpServerSchema]);
const effectiveProcessRecordSchema = z.object({
  name: z.enum(['brief.md', 'status.md', 'review.md']),
  updated: z.boolean(),
}).strict();
const effectiveProcessNodeSchema = z.object({
  role: z.enum(['planner', 'reviewer', 'executor']),
  prompt: z.string(),
  correction_prompt: z.string(),
  records: z.array(effectiveProcessRecordSchema),
  edges: z.record(z.string(), processEdgeSchema),
}).strict();
const effectiveCardProcessSchema = z.object({
  entries: z.object({
    BACKLOG: processEntrySchema,
    CHANGED: processEntrySchema,
    BLOCKED: processEntrySchema,
    STOPPED: stoppedProcessEntrySchema,
  }).strict(),
  nodes: z.record(z.string(), effectiveProcessNodeSchema),
}).strict();
const effectiveCardProcessesSchema = z.object({
  planning: effectiveCardProcessSchema,
  terminal: effectiveCardProcessSchema,
}).strict();

// ── Full Config Schema ────────────────────────────────────────

export const saivageConfigSchema = z.object({
  models: modelsSectionSchema.default({}),
  providers: z.record(z.string(), providerEntrySchema).default({}),
  server: serverSectionSchema.default({}),
  runtime: runtimeSectionSchema.default({}),
  compaction: compactionSectionSchema,
  card_processes: cardProcessesSchema,
  mcpServers: z.record(z.string(), mcpServerEntrySchema).optional(),
}).strict().superRefine(validateAnalystReserve);

export const effectiveSaivageConfigSchema = z.object({
  models: effectiveModelsSectionSchema,
  providers: z.record(z.string(), effectiveProviderEntrySchema),
  server: effectiveServerSectionSchema,
  runtime: effectiveRuntimeSectionSchema,
  compaction: effectiveCompactionSectionSchema,
  card_processes: effectiveCardProcessesSchema,
  mcpServers: z.record(z.string(), effectiveMcpServerEntrySchema).optional(),
}).strict().superRefine(validateAnalystReserve);

function validateAnalystReserve(value: {
  models: { max_tokens?: Partial<Record<AgentRole | 'default', number>> };
  compaction: { input_budget_tokens: number; completion_reserve_fraction: number };
}, ctx: z.RefinementCtx): void {
  const maxTokens = value.models.max_tokens ?? {};
  const analystTokens = maxTokens['analyst'];
  const defaultTokens = maxTokens['default'];
  const requested = analystTokens ?? defaultTokens ?? 4096;
  const source = analystTokens !== undefined ? 'analyst' : defaultTokens !== undefined ? 'default' : 'hard default';
  const budget = value.compaction.input_budget_tokens;
  const fraction = value.compaction.completion_reserve_fraction;
  const reserved = Math.floor(budget * fraction);
  if (requested > reserved) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['models', 'max_tokens', source === 'analyst' ? 'analyst' : source === 'default' ? 'default' : 'analyst'],
      message: `Effective Analyst max tokens ${requested} (source: ${source}) exceed reserved completion tokens ${reserved} (floor(input_budget_tokens ${budget} * completion_reserve_fraction ${fraction})). Raise compaction.input_budget_tokens or compaction.completion_reserve_fraction, or lower the configured Analyst max.`,
    });
  }
}

// ── Derived Types ─────────────────────────────────────────────

export type SaivageConfig = z.infer<typeof effectiveSaivageConfigSchema>;
export type McpServerConfig = z.infer<typeof effectiveMcpServerEntrySchema>;
export type StdioMcpServerConfig = z.infer<typeof effectiveStdioMcpServerSchema>;
export type StreamableHttpMcpServerConfig = z.infer<typeof effectiveStreamableHttpMcpServerSchema>;
export type ProviderEntry = z.infer<typeof effectiveProviderEntrySchema>;
export type ProviderAccount = z.infer<typeof effectiveProviderAccountSchema>;
export type ProviderCapabilities = z.infer<typeof providerCapabilitySchema>;
export type CardProcessesSource = z.infer<typeof cardProcessesSchema>;
export type CardProcessSource = CardProcessesSource['planning'];

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
  role: AgentRole,
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
