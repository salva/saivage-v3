import { z } from 'zod';

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

const WebfetchWriteSchema = z.union([
  z.object({
    path: z.string(),
    record_url: z.string().optional(),
    bytes: z.number().int().nonnegative(),
    written: z.literal(true),
  }).strict(),
  z.object({
    card_id: z.string(),
    path: z.string(),
    record_url: z.string(),
    bytes: z.number().int().nonnegative(),
    written: z.literal(true),
    propagation: z.union([
      z.object({ ok: z.literal(true) }).strict(),
      z.object({ ok: z.literal(false), partial: z.literal(true), error: z.string() }).strict(),
    ]),
  }).strict(),
]);

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
  write: WebfetchWriteSchema,
  bytes: z.number().int().nonnegative(),
}).strict();

export const WebfetchResultSchema = z.union([
  z.object({ success: z.literal(false), error: z.string() }).strict(),
  z.object({
    success: z.literal(true),
    data: z.union([
      WebfetchMetadataOnlyDataSchema,
      WebfetchBinaryDataSchema,
      WebfetchInlineDataSchema,
      WebfetchStashDataSchema,
      WebfetchSavedDataSchema,
    ]),
  }).strict(),
]);

export type WebfetchResult = z.infer<typeof WebfetchResultSchema>;
