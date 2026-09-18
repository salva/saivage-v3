import { z } from 'zod';

export const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

const contextReplacementSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('retain') }).strict(),
  z.object({ kind: z.literal('latest_snapshot'), key: z.string().min(1), contentSha256: sha256HexSchema }).strict(),
]);
const contextAudienceSchema = z.enum(['primary_and_summarizer', 'summarizer_only', 'evidence_only']);
const contextEvidenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('canonical_locator'), locator: z.string().min(1), sha256: sha256HexSchema }).strict(),
  z.object({ kind: z.literal('observational_query'), tool: z.string().min(1), arguments: z.unknown(), observed_sha256: sha256HexSchema }).strict(),
]);

const toolResultPolicyTemplateSchema = z.object({
  storage: z.literal('durable'),
  replacement: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('retain') }).strict(),
    z.object({ kind: z.literal('latest_snapshot'), key: z.string().min(1) }).strict(),
  ]),
  settledAudience: contextAudienceSchema,
  evidenceMode: z.enum(['none', 'observational_query', 'canonical_locator']),
}).strict();

const settledToolEvidenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('observational_query'), observedSha256: sha256HexSchema }).strict(),
  z.object({ kind: z.literal('canonical_locator'), locator: z.string().min(1), sha256: sha256HexSchema }).strict(),
]);

const toolSettlementOriginSchema = z.enum(['executed', 'rejected_before_execution', 'unsupported_tool', 'execution_failed']);

export const rowContextPolicySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('content'),
    storage: z.literal('durable'),
    replacement: contextReplacementSchema,
    audience: contextAudienceSchema,
    evidence: contextEvidenceSchema,
    compactable: z.boolean(),
    compaction_key: z.string().min(1).optional(),
  }).strict(),
  z.object({
    kind: z.literal('tool_call'),
    template: toolResultPolicyTemplateSchema,
    template_bytes: z.string().min(1),
    template_sha256: sha256HexSchema,
  }).strict(),
  z.object({
    kind: z.literal('tool_result'),
    settlement_origin: toolSettlementOriginSchema,
    result_content_sha256: sha256HexSchema,
    call_policy_sha256: sha256HexSchema,
    evidence: settledToolEvidenceSchema,
  }).strict(),
  z.object({
    kind: z.literal('structural'),
    behavior: z.enum(['activation_boundary', 'provider_failure', 'model_recovery_notice', 'content_policy_refusal', 'responses_private']),
  }).strict(),
]).superRefine((policy, ctx) => {
  if (policy.kind === 'content' && policy.compaction_key !== undefined && policy.compactable)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['compaction_key'], message: 'compaction_key is allowed only when compactable is false.' });
});

export type ContextReplacement = z.infer<typeof contextReplacementSchema>;
export type ContextAudience = z.infer<typeof contextAudienceSchema>;
export type ContextEvidence = z.infer<typeof contextEvidenceSchema>;
export type ToolResultPolicyTemplate = z.infer<typeof toolResultPolicyTemplateSchema>;
export type SettledToolEvidence = z.infer<typeof settledToolEvidenceSchema>;
export type ToolSettlementOrigin = z.infer<typeof toolSettlementOriginSchema>;
export type RowContextPolicy = z.infer<typeof rowContextPolicySchema>;
export type StructuralRowBehavior = Extract<RowContextPolicy, { kind: 'structural' }>['behavior'];

export const MODEL_RECOVERY_NOTICE_TEXT = 'The previous runtime activation was interrupted. External or domain effects may or may not have happened. Inspect current card, record, and tool facts before repeating work.';

export const DURABLE_PRIMARY_CONTENT_POLICY: Extract<RowContextPolicy, { kind: 'content' }> = Object.freeze({
  kind: 'content',
  storage: 'durable',
  replacement: Object.freeze({ kind: 'retain' }),
  audience: 'primary_and_summarizer',
  evidence: Object.freeze({ kind: 'none' }),
  compactable: true,
});

export function durablePrimaryContentPolicy(declaration: Readonly<{ compactable: boolean; compaction_key?: string }>): Extract<RowContextPolicy, { kind: 'content' }> {
  return Object.freeze({
    ...DURABLE_PRIMARY_CONTENT_POLICY,
    compactable: declaration.compactable,
    ...(declaration.compaction_key === undefined ? {} : { compaction_key: declaration.compaction_key }),
  });
}

export const STRUCTURAL_ROW_POLICY: Record<StructuralRowBehavior, Extract<RowContextPolicy, { kind: 'structural' }>> = Object.freeze({
  activation_boundary: Object.freeze({ kind: 'structural', behavior: 'activation_boundary' }),
  provider_failure: Object.freeze({ kind: 'structural', behavior: 'provider_failure' }),
  model_recovery_notice: Object.freeze({ kind: 'structural', behavior: 'model_recovery_notice' }),
  content_policy_refusal: Object.freeze({ kind: 'structural', behavior: 'content_policy_refusal' }),
  responses_private: Object.freeze({ kind: 'structural', behavior: 'responses_private' }),
});
