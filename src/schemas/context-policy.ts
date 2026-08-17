import { z } from 'zod';

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
export const contextAudienceSchema = z.enum(['primary_and_summarizer', 'summarizer_only', 'evidence_only']);
export type ContextAudienceValue = z.infer<typeof contextAudienceSchema>;

export const contextReplacementTemplateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('retain') }).strict(),
  z.object({ kind: z.literal('latest_snapshot'), key: z.string().min(1) }).strict(),
]);

export const toolResultPolicyTemplateSchema = z.object({ storage: z.literal('durable'), replacement: contextReplacementTemplateSchema, settledAudience: contextAudienceSchema, evidenceMode: z.enum(['none', 'observational_query', 'canonical_locator']) }).strict();
export type CanonicalToolResultPolicyTemplate = z.infer<typeof toolResultPolicyTemplateSchema>;

export const settledToolEvidenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('observational_query'), observedSha256: sha256Schema }).strict(),
  z.object({ kind: z.literal('canonical_locator'), locator: z.string().min(1), sha256: sha256Schema }).strict(),
]);
export type SettledToolEvidence = z.infer<typeof settledToolEvidenceSchema>;

const contentEvidenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('canonical_locator'), locator: z.string().min(1), sha256: sha256Schema }).strict(),
  z.object({ kind: z.literal('observational_query'), tool: z.string().min(1), arguments: z.unknown(), observed_sha256: sha256Schema }).strict(),
]);

export const canonicalContextPolicySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('content'), storage: z.literal('durable'), replacement: z.discriminatedUnion('kind', [z.object({ kind: z.literal('retain') }).strict(), z.object({ kind: z.literal('latest_snapshot'), key: z.string().min(1), contentSha256: sha256Schema }).strict()]), audience: contextAudienceSchema, evidence: contentEvidenceSchema }).strict(),
  z.object({ kind: z.literal('tool_call'), template: toolResultPolicyTemplateSchema, template_bytes: z.string().min(1), template_sha256: sha256Schema }).strict(),
  z.object({ kind: z.literal('tool_result'), settlement_origin: z.enum(['executed', 'rejected_before_execution', 'unsupported_tool', 'execution_failed']), result_content_sha256: sha256Schema, call_policy_sha256: sha256Schema, evidence: settledToolEvidenceSchema }).strict(),
  z.object({ kind: z.literal('structural'), behavior: z.enum(['activation_boundary', 'provider_failure', 'model_recovery_notice', 'content_policy_refusal', 'responses_private']) }).strict(),
]);
export type CanonicalContextPolicy = z.infer<typeof canonicalContextPolicySchema>;
