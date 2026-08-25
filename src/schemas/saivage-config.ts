import { z } from 'zod';
import { agentNameSchema } from './agent-name.js';
import { recordNameSchema } from './record-name.js';
import { cardTypeNameSchema } from './card-type-name.js';

// ── Zod Schemas ───────────────────────────────────────────────

// Routing profile
const routingProfileSchema = z.object({
  preferred: z.array(z.string()).default([]),
  allowed: z.array(z.string()).default([]),
}).strict();

const modelEquivalentsSchema = z.array(z.array(z.string()));

const namedIdentifierSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
export const systemTemplateNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
const outcomeIdentifierSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
export const recordWritePatternSchema = z.string().regex(/^[a-z*][a-z0-9*-]{0,63}\.md$/u, 'Expected a lowercase Markdown record-name pattern containing only literal stem characters and * wildcards.');
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
  records: z.record(recordNameSchema, z.object({ mode: z.enum(['clean', 'continue']), gate: z.enum(['exists', 'updated']) }).strict()).default({}),
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
  bootstrap: z.boolean(),
}).strict();
const cardTypeWorkflowSchema = z.object({
  permitted_child_types: z.array(cardTypeNameSchema),
  records: z.record(recordNameSchema, recordDefinitionSchema),
  workflow: cardProcessSchema,
}).strict();
export const cardTypesSchema = z.record(cardTypeNameSchema, cardTypeWorkflowSchema).superRefine((cardTypes, ctx) => {
  if (!Object.prototype.hasOwnProperty.call(cardTypes, 'project')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['project'], message: "card_types must contain the reserved 'project' entry" });
  }
  for (const [cardType, source] of Object.entries(cardTypes)) {
    const seen = new Set<string>();
    source.permitted_child_types.forEach((childType, index) => {
      const path = [cardType, 'permitted_child_types', index];
      if (childType === 'project') ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: "permitted_child_types cannot contain the reserved 'project' type" });
      if (seen.has(childType)) ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `duplicate permitted child type '${childType}'` });
      seen.add(childType);
      if (!Object.prototype.hasOwnProperty.call(cardTypes, childType)) ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `permitted child type '${childType}' has no card_types entry` });
    });
  }
});

const agentDefinitionSchema = z.object({
  prompt: namedIdentifierSchema,
  tools: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u)),
  model_route: namedIdentifierSchema,
  skills: z.boolean(),
  session: z.enum(['global', 'card']),
  can_create_children: z.boolean(),
  record_writes: z.array(recordWritePatternSchema),
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
const outboundEffectiveProviderAccountSchema = providerAccountSchema.omit({ baseUrl: true });
const outboundEffectiveProviderEntrySchema = providerEntrySchema
  .omit({ baseUrl: true, accounts: true })
  .extend({ accounts: z.record(z.string(), outboundEffectiveProviderAccountSchema).optional() });
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
  card_types: cardTypesSchema.optional(),
  mcpServers: z.record(z.string(), mcpServerEntrySchema).optional(),
}).strict();

const effectiveSaivageConfigShape = {
  agents: z.record(agentNameSchema, agentDefinitionSchema),
  analyst_agent: agentNameSchema,
  models: effectiveModelsSectionSchema,
  providers: z.record(z.string(), providerEntrySchema),
  server: effectiveServerSectionSchema,
  compaction: effectiveCompactionSectionSchema,
  card_types: cardTypesSchema,
  mcpServers: z.record(z.string(), effectiveMcpServerEntrySchema).optional(),
};

export const effectiveSaivageConfigSchema = z.object(effectiveSaivageConfigShape).strict();

export const outboundEffectiveSaivageConfigSchema = z.object({
  ...effectiveSaivageConfigShape,
  providers: z.record(z.string(), outboundEffectiveProviderEntrySchema),
}).strict();

// ── Derived Types ─────────────────────────────────────────────

export type SaivageConfig = z.infer<typeof effectiveSaivageConfigSchema>;
export type SaivageConfigSource = z.infer<typeof saivageConfigSchema>;
export type SystemTemplateName = z.infer<typeof systemTemplateNameSchema>;
export type OutboundEffectiveSaivageConfig = z.infer<typeof outboundEffectiveSaivageConfigSchema>;
export type McpServerConfig = z.infer<typeof effectiveMcpServerEntrySchema>;
export type StdioMcpServerConfig = z.infer<typeof effectiveStdioMcpServerSchema>;
export type StreamableHttpMcpServerConfig = z.infer<typeof effectiveStreamableHttpMcpServerSchema>;
export type ProviderEntry = z.infer<typeof providerEntrySchema>;
export type ProviderAccount = z.infer<typeof providerAccountSchema>;
export type ProviderCapabilities = z.infer<typeof providerCapabilitySchema>;
export type CardTypesSource = z.infer<typeof cardTypesSchema>;
export type CardTypeSource = NonNullable<CardTypesSource[keyof CardTypesSource]>;
export type CardProcessSource = CardTypeSource['workflow'];
