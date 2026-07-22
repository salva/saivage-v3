import { z } from 'zod';
import { agentNameSchema } from './agent-name.js';
import { recordNameSchema } from './record-name.js';
import { cardTypeValues } from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ── Zod Schemas ───────────────────────────────────────────────

// Routing profile
const routingProfileSchema = z.object({
  preferred: z.array(z.string()).default([]),
  allowed: z.array(z.string()).default([]),
}).strict();

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

const namedIdentifierSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
const outcomeIdentifierSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const modelRouteSchema = z.object({
  candidates: z.array(z.string().min(1)).min(1).optional(),
  profile: namedIdentifierSchema.optional(),
  temperature: z.number().min(0).max(2),
  max_tokens: z.number().int().positive(),
}).strict().superRefine((route, ctx) => {
  if ((route.candidates === undefined) === (route.profile === undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'exactly one of candidates or profile is required' });
});
const modelsSectionSchema = z.object({
  routes: z.record(namedIdentifierSchema, modelRouteSchema),
  profiles: z.record(namedIdentifierSchema, routingProfileSchema).default({}),
  equivalents: modelEquivalentsSchema.default([]),
  failover: z.record(z.string(), z.array(z.string().min(1))).default({}),
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
}).strict();

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
}).strict();

// Server section
const serverSectionSchema = z.object({
  port: z.number().int().positive().default(8080),
  host: z.string().default('0.0.0.0'),
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
const promotionSchema = z.union([z.literal('current'), z.object({ latest_node: namedIdentifierSchema }).strict()]);
const processEdgeTargetSchema = z.union([
  z.object({ node: namedIdentifierSchema }).strict(),
  z.object({ terminal: processTerminalPortSchema, promote: promotionSchema, export_records: z.array(recordNameSchema) }).strict(),
]);
const processEdgeSchema = z.object({
  target: processEdgeTargetSchema,
  prompt: z.string().optional(),
}).strict();
const processNodeSchema = z.object({
  agent: agentNameSchema,
  prompt: namedIdentifierSchema,
  correction_prompt: namedIdentifierSchema,
  records: z.record(recordNameSchema, z.enum(['present', 'updated'])).default({}),
  descendant_context: z.object({ records: z.array(recordNameSchema), require_unchanged_until_accept: z.boolean() }).strict().optional(),
  edges: z.record(outcomeIdentifierSchema, processEdgeSchema),
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

const recordDefinitionSchema = z.object({
  format: z.literal('markdown'),
  schema: z.string().regex(/^[a-z][a-z0-9-]{0,63}\.v[1-9][0-9]*$/u),
  writers: z.array(agentNameSchema).min(1),
  bootstrap: z.boolean(),
}).strict();
const cardTypeWorkflowSchema = z.object({
  permitted_child_types: z.array(z.enum(cardTypeValues)),
  records: z.record(recordNameSchema, recordDefinitionSchema),
  workflow: cardProcessSchema,
}).strict();
export const cardTypesSchema = z.record(z.enum(cardTypeValues), cardTypeWorkflowSchema);

const agentDefinitionSchema = z.object({
  prompt: namedIdentifierSchema,
  tools: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u)),
  model_route: namedIdentifierSchema,
  skills: z.boolean(),
  session: z.enum(['global', 'card']),
  can_create_children: z.boolean(),
}).strict();

const effectiveRoutingProfileSchema = z.object({
  preferred: z.array(z.string()),
  allowed: z.array(z.string()),
}).strict();
const effectiveModelsSectionSchema = z.object({
  routes: z.record(namedIdentifierSchema, modelRouteSchema),
  profiles: z.record(namedIdentifierSchema, effectiveRoutingProfileSchema),
  equivalents: z.array(z.array(z.string())),
  failover: z.record(z.string(), z.array(z.string())),
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
// ── Full Config Schema ────────────────────────────────────────

export const saivageConfigSchema = z.object({
  agents: z.record(agentNameSchema, agentDefinitionSchema),
  analyst_agent: agentNameSchema,
  models: modelsSectionSchema,
  providers: z.record(z.string(), providerEntrySchema).default({}),
  server: serverSectionSchema.default({}),
  compaction: compactionSectionSchema,
  card_types: cardTypesSchema,
  mcpServers: z.record(z.string(), mcpServerEntrySchema).optional(),
}).strict().superRefine(validateAnalystReserve);

export const effectiveSaivageConfigSchema = z.object({
  agents: z.record(agentNameSchema, agentDefinitionSchema),
  analyst_agent: agentNameSchema,
  models: effectiveModelsSectionSchema,
  providers: z.record(z.string(), effectiveProviderEntrySchema),
  server: effectiveServerSectionSchema,
  compaction: effectiveCompactionSectionSchema,
  card_types: cardTypesSchema,
  mcpServers: z.record(z.string(), effectiveMcpServerEntrySchema).optional(),
}).strict().superRefine(validateAnalystReserve);

function validateAnalystReserve(value: {
  agents: Record<string, { model_route: string }>;
  analyst_agent: string;
  models: { routes: Record<string, { max_tokens: number }> };
  compaction: { input_budget_tokens: number; completion_reserve_fraction: number };
}, ctx: z.RefinementCtx): void {
  const analyst = value.agents[value.analyst_agent];
  const route = analyst ? value.models.routes[analyst.model_route] : undefined;
  if (!route) return;
  const requested = route.max_tokens;
  const budget = value.compaction.input_budget_tokens;
  const fraction = value.compaction.completion_reserve_fraction;
  const reserved = Math.floor(budget * fraction);
  if (requested > reserved) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['models', 'routes', analyst.model_route, 'max_tokens'],
      message: `Effective Analyst max tokens ${requested} exceed reserved completion tokens ${reserved} (floor(input_budget_tokens ${budget} * completion_reserve_fraction ${fraction})).`,
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
export type CardTypesSource = z.infer<typeof cardTypesSchema>;
export type CardTypeSource = NonNullable<CardTypesSource[keyof CardTypesSource]>;
export type CardProcessSource = CardTypeSource['workflow'];

// ── Model Params ──────────────────────────────────────────────

export function getModelParamsForAgent(config: SaivageConfig, agentName: string): { temperature: number; maxTokens: number } {
  const agent = config.agents[agentName];
  if (!agent) throw new Error(`Unknown agent '${agentName}'.`);
  const route = config.models.routes[agent.model_route];
  if (!route) throw new Error(`Unknown model route '${agent.model_route}'.`);
  return { temperature: route.temperature, maxTokens: route.max_tokens };
}
