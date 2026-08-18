import { createHash } from 'node:crypto';
import { z } from 'zod';

const sha256HexPattern = /^[0-9a-f]{64}$/;
const positiveSafeInteger = z.number().int().safe().positive();
const nonNegativeSafeInteger = z.number().int().safe().nonnegative();
const sha256HexString = z.string().regex(sha256HexPattern);
const canonicalUuidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

export const coveredSourceGroupSchema = z.object({ message_ids: z.array(z.string().min(1)).min(1), content_sha256: sha256HexString }).strict();

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
  dispositionCommitment: z.object({ sha256: sha256HexString, count: positiveSafeInteger, summarized: nonNegativeSafeInteger, evidenceOnly: nonNegativeSafeInteger, superseded: nonNegativeSafeInteger }).strict(),
  coverageCommitment: z.object({ sourceSessionId: z.string().min(1), sourceVersion: positiveSafeInteger, coveredThroughMessageId: z.string().min(1), coveredSourceGroupsSha256: sha256HexString, accumulatedSummarySha256: sha256HexString }).strict(),
  requiredModelFacts: requiredModelFactSlotsSchema,
}).strict().superRefine((history, ctx) => {
  if (history.source.groups.length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['source', 'groups'], message: 'Compacted history must name at least one covered source group.' });
  const dispositions = history.dispositionCommitment;
  if (dispositions.count !== dispositions.summarized + dispositions.evidenceOnly + dispositions.superseded)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dispositionCommitment'], message: 'Disposition count must equal the sum of its kinds.' });
  if (coveredSourceGroupsSha256(history.source.groups) !== history.coverageCommitment.coveredSourceGroupsSha256)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['coverageCommitment', 'coveredSourceGroupsSha256'], message: 'Coverage commitment does not commit to the named covered source groups.' });
  if (accumulatedSummarySha256(history.summaryText) !== history.coverageCommitment.accumulatedSummarySha256)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['coverageCommitment', 'accumulatedSummarySha256'], message: 'Coverage commitment does not commit to the exact accumulated summary bytes.' });
});

export type CoveredSourceGroup = z.infer<typeof coveredSourceGroupSchema>;
export type RequiredModelFactSlots = z.infer<typeof requiredModelFactSlotsSchema>;
export type RequiredModelFactRecoverySlot = NonNullable<RequiredModelFactSlots['latestRecovery']>;
export type RequiredModelFactRefusalSlot = NonNullable<RequiredModelFactSlots['latestContentPolicyRefusal']>;
export type CompactedHistory = z.infer<typeof compactedHistorySchema>;
export type DispositionCommitment = CompactedHistory['dispositionCommitment'];

export type CoveredDisposition = 'summarized' | 'evidence_only' | 'superseded';

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortJson(item)]));
  }
  return value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function coveredSourceGroupsSha256(groups: readonly CoveredSourceGroup[]): string {
  return sha256(canonicalJson(groups.map((group) => ({ content_sha256: group.content_sha256, message_ids: group.message_ids }))));
}

export function accumulatedSummarySha256(summaryText: string): string {
  return sha256(summaryText);
}

export function foldDispositionCommitment(prior: DispositionCommitment | null, dispositions: readonly { id: string; disposition: CoveredDisposition }[]): DispositionCommitment {
  const summarized = dispositions.filter((entry) => entry.disposition === 'summarized').length;
  const evidenceOnly = dispositions.filter((entry) => entry.disposition === 'evidence_only').length;
  const superseded = dispositions.filter((entry) => entry.disposition === 'superseded').length;
  return {
    sha256: sha256(canonicalJson({ prior: prior?.sha256 ?? null, dispositions })),
    count: (prior?.count ?? 0) + dispositions.length,
    summarized: (prior?.summarized ?? 0) + summarized,
    evidenceOnly: (prior?.evidenceOnly ?? 0) + evidenceOnly,
    superseded: (prior?.superseded ?? 0) + superseded,
  };
}

export function parseCanonicalCompactedHistory(content: string): CompactedHistory {
  const parsed = compactedHistorySchema.parse(JSON.parse(content));
  if (content !== canonicalJson(parsed)) throw new Error('Compacted history must be canonical JSON.');
  return parsed;
}
