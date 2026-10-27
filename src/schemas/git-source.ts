import { z } from 'zod';

export const gitOidSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
export const gitRefNameSchema = z.string().min(1).refine((value) =>
  !value.startsWith('/') && !value.endsWith('/') && !value.endsWith('.') &&
  !/[\x00-\x20\x7f~^:?*\[\\]/u.test(value) && !value.includes('..') &&
  !value.includes('@{') && value !== '@' && value.split('/').every((part) =>
    part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock')),
  'Expected a literal Git ref name without revision syntax.');
const gitBranchSchema = gitRefNameSchema.refine((value) => value.startsWith('refs/heads/'));
export const gitNativeStepSchema = z.enum(['commission', 'enter', 'checkpoint', 'prepareCandidate', 'verifyCorrection',
  'deliver', 'preserveAndReturn', 'captureRebase', 'restoreRebaseAndReturn', 'inspect', 'switch']);
export const gitSelectionSchema = z.object({
  branch_ref: gitBranchSchema,
  observed_tip: gitOidSchema,
}).strict();
export const gitPreservedSourceSchema = z.object({
  ref: gitRefNameSchema.refine((value) => /^refs\/saivage\/.+\/preserved\/.+$/u.test(value)),
  oid: gitOidSchema,
  source_tip: gitOidSchema,
  kind: z.literal('unfinished-resolution'),
}).strict();
export const gitCorrectionTaskSchema = z.object({
  branch_ref: gitBranchSchema,
  base_oid: gitOidSchema,
  original_tip: gitOidSchema,
  onto: gitSelectionSchema,
  retained_original_ref: gitRefNameSchema.refine((value) => /^refs\/saivage\/.+\/retained\/.+$/u.test(value)),
}).strict();
const sourceFacts = {
  branch_ref: gitBranchSchema,
  parent: gitSelectionSchema,
  base_oid: gitOidSchema,
  observed_tip: gitOidSchema,
  candidate: z.object({
    base_oid: gitOidSchema,
    candidate_oid: gitOidSchema,
    preparation_invocation_id: z.string().uuid(),
  }).strict().nullable(),
  last_delivery: z.object({
    child_tip: gitOidSchema,
    parent_before: gitOidSchema,
    parent_after: gitOidSchema,
  }).strict().nullable(),
  correction: gitCorrectionTaskSchema.extend({
    preserved_source: gitPreservedSourceSchema.nullable(),
  }).strict().nullable(),
};

/** Completed native facts only. No approval, pending job, N token or resume phase. */
export const cardGitFactsSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('root'), policy_digest: z.string().regex(/^[a-f0-9]{64}$/u), ...sourceFacts }).strict(),
  z.object({ kind: z.literal('child'), ...sourceFacts }).strict(),
]).superRefine((facts, ctx) => {
  if (facts.correction && (facts.correction.branch_ref !== facts.branch_ref ||
    facts.correction.onto.branch_ref !== facts.parent.branch_ref ||
    facts.correction.onto.observed_tip !== facts.parent.observed_tip))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Correction must identify the selected private branch and parent.' });
  if (facts.candidate && (facts.candidate.base_oid !== facts.base_oid || facts.candidate.candidate_oid !== facts.observed_tip))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Candidate must identify the current prepared source.' });
});
export type CardGitFacts = z.infer<typeof cardGitFactsSchema>;

export const nativeGitEffectSchema = z.enum([
  'index-normalized', 'commit-completed', 'checkout-completed', 'branch-created',
  'original-retained', 'rebase-completed', 'rebase-aborted', 'squash-completed',
  'capture-work-allocated', 'source-snapshot-retained', 'source-restored',
]);
export const nativeGitOutcomeSchema = z.enum(['commissioned', 'delivered', 'returned', 'captured', 'entered',
  'candidate', 'correction-required', 'correction-verified', 'completed', 'refused', 'uncertain']);
/** Completed observations only; never authority to resume a native operation. */
export const nativeGitEvidenceFactsSchema = z.object({
  source: gitSelectionSchema.nullable(),
  parent: gitSelectionSchema.nullable(),
  base_oid: gitOidSchema.nullable(),
  original_tip: gitOidSchema.nullable(),
  retained_original_ref: gitRefNameSchema.nullable(),
  parent_before: gitOidSchema.nullable(),
  preserved_source: gitPreservedSourceSchema.nullable(),
  rebase_observation: z.object({ starting_tip: gitOidSchema, head_tip: gitOidSchema }).strict().nullable(),
}).strict();
export const nativeGitExecutionBindingSchema = z.discriminatedUnion('origin', [z.object({
  origin: z.literal('activation'),
  activation_id: z.string().uuid(),
  parent_card_id: z.string().regex(/^(?:project|card-[a-z]+(?:-[a-z]+){0,11})$/u).nullable(),
  node: z.object({ node_id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
    ordinal: z.number().int().safe().nonnegative() }).strict().nullable(),
}).strict(), z.object({ origin: z.literal('bootstrap') }).strict()]);
