import { z } from 'zod';

import { sha256Hex } from './sha256.js';
import { canonicalJson } from './canonical-json.js';
import { agentMessageSchema } from './validators.js';

const sha256HexPattern = /^[0-9a-f]{64}$/;
const positiveSafeInteger = z.number().int().safe().positive();
const nonNegativeSafeInteger = z.number().int().safe().nonnegative();
const sha256HexString = z.string().regex(sha256HexPattern);
const canonicalUuidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

const coveredSourceGroupSchema = z.object({ message_ids: z.array(z.string().min(1)).min(1), content_sha256: sha256HexString }).strict();
const protectedPromptSchema = z.object({
  source: z.object({ segmentVersion: positiveSafeInteger, rowIndex: nonNegativeSafeInteger }).strict(),
  message: agentMessageSchema,
}).strict();

export const requiredModelFactSlotsSchema = z.object({
  latestRecovery: z.object({ sourceMessageId: z.string().min(1), activationInputId: canonicalUuidSchema }).strict().nullable(),
  latestContentPolicyRefusal: z.object({ markerId: canonicalUuidSchema, activationInputId: canonicalUuidSchema }).strict().nullable(),
}).strict().superRefine((facts, ctx) => {
  if (facts.latestRecovery && facts.latestRecovery.sourceMessageId !== `${facts.latestRecovery.activationInputId}:model-recovered`)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['latestRecovery', 'sourceMessageId'], message: 'Recovery sourceMessageId must equal the activation-derived recovery identity.' });
});

export const compactedHistorySchema = z.object({
  summaryText: z.string().min(1),
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('current_rows'), groups: z.array(coveredSourceGroupSchema) }).strict(),
    z.object({ kind: z.literal('prior_genesis_plus_current_rows'), priorGenesisId: canonicalUuidSchema, priorHistoryHash: sha256HexString, groups: z.array(coveredSourceGroupSchema) }).strict(),
  ]),
  protectedPrompts: z.array(protectedPromptSchema),
  dispositionCommitment: z.object({ sha256: sha256HexString, count: positiveSafeInteger, summarized: nonNegativeSafeInteger, evidenceOnly: nonNegativeSafeInteger, superseded: nonNegativeSafeInteger, protected: nonNegativeSafeInteger }).strict(),
  coverageCommitment: z.object({ sourceSessionId: z.string().min(1), sourceVersion: positiveSafeInteger, coveredThroughMessageId: z.string().min(1), coveredSourceGroupsSha256: sha256HexString, accumulatedSummarySha256: sha256HexString, protectedPromptsSha256: sha256HexString }).strict(),
  requiredModelFacts: requiredModelFactSlotsSchema,
}).strict().superRefine((history, ctx) => {
  if (history.source.groups.length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['source', 'groups'], message: 'Compacted history must name at least one covered source group.' });
  const dispositions = history.dispositionCommitment;
  if (dispositions.count !== dispositions.summarized + dispositions.evidenceOnly + dispositions.superseded + dispositions.protected)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dispositionCommitment'], message: 'Disposition count must equal the sum of its kinds.' });
  if (coveredSourceGroupsSha256(history.source.groups) !== history.coverageCommitment.coveredSourceGroupsSha256)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['coverageCommitment', 'coveredSourceGroupsSha256'], message: 'Coverage commitment does not commit to the named covered source groups.' });
  if (accumulatedSummarySha256(history.summaryText) !== history.coverageCommitment.accumulatedSummarySha256)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['coverageCommitment', 'accumulatedSummarySha256'], message: 'Coverage commitment does not commit to the exact accumulated summary bytes.' });
  if (protectedPromptsSha256(history.protectedPrompts) !== history.coverageCommitment.protectedPromptsSha256)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['coverageCommitment', 'protectedPromptsSha256'], message: 'Coverage commitment does not commit to the exact protected prompts.' });
});

export type CoveredSourceGroup = z.infer<typeof coveredSourceGroupSchema>;
export type RequiredModelFactSlots = z.infer<typeof requiredModelFactSlotsSchema>;
export type CompactedHistory = z.infer<typeof compactedHistorySchema>;
export type ProtectedPrompt = z.infer<typeof protectedPromptSchema>;
type DispositionCommitment = CompactedHistory['dispositionCommitment'];

export type CoveredDisposition = 'summarized' | 'evidence_only' | 'superseded' | 'protected';

export function protectedPromptsSha256(prompts: readonly ProtectedPrompt[]): string {
  return sha256Hex(canonicalJson(prompts));
}

export function coveredSourceGroupsSha256(groups: readonly CoveredSourceGroup[]): string {
  return sha256Hex(canonicalJson(groups.map((group) => ({ content_sha256: group.content_sha256, message_ids: group.message_ids }))));
}

export function accumulatedSummarySha256(summaryText: string): string {
  return sha256Hex(summaryText);
}

export function foldDispositionCommitment(prior: DispositionCommitment | null, dispositions: readonly { id: string; disposition: CoveredDisposition }[]): DispositionCommitment {
  const summarized = dispositions.filter((entry) => entry.disposition === 'summarized').length;
  const evidenceOnly = dispositions.filter((entry) => entry.disposition === 'evidence_only').length;
  const superseded = dispositions.filter((entry) => entry.disposition === 'superseded').length;
  const protectedCount = dispositions.filter((entry) => entry.disposition === 'protected').length;
  return {
    sha256: sha256Hex(canonicalJson({ prior: prior?.sha256 ?? null, dispositions })),
    count: (prior?.count ?? 0) + dispositions.length,
    summarized: (prior?.summarized ?? 0) + summarized,
    evidenceOnly: (prior?.evidenceOnly ?? 0) + evidenceOnly,
    superseded: (prior?.superseded ?? 0) + superseded,
    protected: (prior?.protected ?? 0) + protectedCount,
  };
}
