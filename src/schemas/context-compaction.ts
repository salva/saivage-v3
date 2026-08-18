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

const SHA256_ROUND_CONSTANTS: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function sha256(value: string): string {
  const message = new TextEncoder().encode(value);
  const bitLength = message.length * 8;
  const paddedLength = (((message.length + 8) >> 6) + 1) << 6;
  const block = new Uint8Array(paddedLength);
  block.set(message);
  block[message.length] = 0x80;
  const view = new DataView(block.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index++) w[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index++) {
      const prior15 = w[index - 15]!;
      const s0 = ((prior15 >>> 7) | (prior15 << 25)) ^ ((prior15 >>> 18) | (prior15 << 14)) ^ (prior15 >>> 3);
      const prior2 = w[index - 2]!;
      const s1 = ((prior2 >>> 17) | (prior2 << 15)) ^ ((prior2 >>> 19) | (prior2 << 13)) ^ (prior2 >>> 10);
      w[index] = (w[index - 16]! + s0 + w[index - 7]! + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let index = 0; index < 64; index++) {
      const upperSigma1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + upperSigma1 + choose + SHA256_ROUND_CONSTANTS[index]! + w[index]!) >>> 0;
      const upperSigma0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (upperSigma0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((word) => word.toString(16).padStart(8, '0')).join('');
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
