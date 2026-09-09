import { z } from 'zod';
import { RecordMutationSuccessSchema } from './record-mutation.js';
import { buildScopedPathUrl, parseScopedPathUrl } from './scoped-path-url.js';

export const WebfetchInvocationSchema = z.object({
  url: z.string(),
  read_mode: z.enum(['auto', 'text']).optional(),
  metadata_only: z.boolean().optional(),
  max_bytes: z.number().int().optional(),
  max_inline_bytes: z.number().int().optional(),
  save_as: z.string().optional(),
}).strict();

export type WebfetchInvocation = z.infer<typeof WebfetchInvocationSchema>;

const WebfetchHeadersSchema = z.record(z.string(), z.string());

const WebfetchMetadataSchema = z.object({
  redacted_url: z.string(),
  status: z.number().int(),
  headers: WebfetchHeadersSchema,
}).strict();

export type WebfetchMetadata = z.infer<typeof WebfetchMetadataSchema>;

export const WorkspaceWriteDataSchema = z.object({ destination_kind: z.enum(['project_relative', 'project_url', 'tmp_url', 'system_url']), target: z.string().min(1), bytes: z.number().int().safe().nonnegative(), written: z.literal(true) }).strict();
const WebfetchSavedWriteSchema = z.union([z.object({ kind: z.literal('workspace_file'), data: WorkspaceWriteDataSchema }).strict(), z.object({ kind: z.literal('record'), data: RecordMutationSuccessSchema.shape.data }).strict()]);

const WebfetchMetadataOnlyDataSchema = WebfetchMetadataSchema.extend({ metadata_only: z.literal(true) }).strict();
const WebfetchBinaryDataSchema = WebfetchMetadataSchema.extend({
  bytes: z.number().int().nonnegative(),
  content: z.null(),
  binary: z.literal(true),
}).strict();
const SafeByteCountSchema = z.number().int().safe().nonnegative();
const WEBFETCH_STASH_FILENAME_RE = /^webfetch-[1-9][0-9]*-[0-9a-f]{16}\.txt$/;

function isCanonicalWebfetchContentUrl(value: string): boolean {
  try {
    const parsed = parseScopedPathUrl(value, 'work');
    return parsed.query === null
      && !parsed.hadFragment
      && parsed.segments.length === 3
      && parsed.segments[0] === 'tmp'
      && parsed.segments[1] === 'stash'
      && WEBFETCH_STASH_FILENAME_RE.test(parsed.segments[2]!)
      && value === buildScopedPathUrl('work', parsed.segments);
  } catch {
    return false;
  }
}

export const WebfetchTextDataSchema = WebfetchMetadataSchema.extend({
  kind: z.literal('text'),
  head: z.string(),
  head_utf8_bytes: SafeByteCountSchema,
  redacted_text_utf8_bytes: SafeByteCountSchema,
  fetched_text_utf8_bytes: SafeByteCountSchema.max(1_000_000),
  head_complete: z.boolean(),
  fetch_truncated: z.boolean(),
  content_url: z.string().optional(),
}).strict().superRefine((value, ctx) => {
  const actualHeadBytes = Buffer.byteLength(value.head, 'utf8');
  if (value.head_utf8_bytes !== actualHeadBytes) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['head_utf8_bytes'], message: 'head_utf8_bytes must equal the UTF-8 byte length of head.' });
  if (value.head_utf8_bytes > value.redacted_text_utf8_bytes) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['head_utf8_bytes'], message: 'head cannot exceed complete redacted text.' });
  const complete = value.head_utf8_bytes === value.redacted_text_utf8_bytes;
  if (value.head_complete !== complete) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['head_complete'], message: 'head_complete must exactly reflect the redacted byte counts.' });
  if (value.head_complete && value.content_url !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['content_url'], message: 'content_url is forbidden for a complete head.' });
  if (!value.head_complete && value.content_url === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['content_url'], message: 'content_url is required for an incomplete head.' });
  if (value.content_url !== undefined && !isCanonicalWebfetchContentUrl(value.content_url)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['content_url'], message: 'content_url must be the canonical current webfetch stash URL.' });
});
const WebfetchSavedDataSchema = WebfetchMetadataSchema.extend({
  saved_as: z.string(),
  write: WebfetchSavedWriteSchema,
  bytes: z.number().int().nonnegative(),
}).strict();

export const WebfetchDataSchema = z.union([
      WebfetchMetadataOnlyDataSchema,
      WebfetchBinaryDataSchema,
      WebfetchTextDataSchema,
      WebfetchSavedDataSchema,
    ]);
