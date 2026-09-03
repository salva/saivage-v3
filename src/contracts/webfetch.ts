import { z } from 'zod';
import { RecordMutationSuccessSchema } from './record-mutation.js';

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

export const WebfetchMetadataSchema = z.object({
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
const WebfetchInlineDataSchema = WebfetchMetadataSchema.extend({
  text: z.string(),
  bytes: z.number().int().nonnegative(),
  truncated: z.literal(false),
}).strict();
const WebfetchStashDataSchema = WebfetchMetadataSchema.extend({
  stash_url: z.string(),
  bytes: z.number().int().nonnegative(),
  truncated: z.literal(true),
}).strict();
const WebfetchSavedDataSchema = WebfetchMetadataSchema.extend({
  saved_as: z.string(),
  write: WebfetchSavedWriteSchema,
  bytes: z.number().int().nonnegative(),
}).strict();

export const WebfetchDataSchema = z.union([
      WebfetchMetadataOnlyDataSchema,
      WebfetchBinaryDataSchema,
      WebfetchInlineDataSchema,
      WebfetchStashDataSchema,
      WebfetchSavedDataSchema,
    ]);

export type WebfetchData = z.infer<typeof WebfetchDataSchema>;
