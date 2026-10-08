import { z } from 'zod';

const annotations = z
  .object({
    audience: z.array(z.enum(['user', 'assistant'])).optional(),
    priority: z.number().min(0).max(1).optional(),
    lastModified: z.string().optional(),
  })
  .passthrough();
const common = { annotations: annotations.optional(), _meta: z.record(z.unknown()).optional() };
const resource = z.union([
  z
    .object({
      uri: z.string(),
      mimeType: z.string().optional(),
      text: z.string(),
      _meta: z.record(z.unknown()).optional(),
    })
    .passthrough(),
  z
    .object({
      uri: z.string(),
      mimeType: z.string().optional(),
      blob: z.string(),
      _meta: z.record(z.unknown()).optional(),
    })
    .passthrough(),
]);
// This validates live protocol input only, never retained producer-specific data.
export const NativeMcpResultSchema = z
  .object({
    content: z.array(
      z.discriminatedUnion('type', [
        z.object({ type: z.literal('text'), text: z.string(), ...common }).passthrough(),
        z
          .object({ type: z.literal('image'), data: z.string(), mimeType: z.string(), ...common })
          .passthrough(),
        z
          .object({ type: z.literal('audio'), data: z.string(), mimeType: z.string(), ...common })
          .passthrough(),
        z.object({ type: z.literal('resource'), resource, ...common }).passthrough(),
        z
          .object({
            type: z.literal('resource_link'),
            uri: z.string(),
            name: z.string(),
            title: z.string().optional(),
            description: z.string().optional(),
            mimeType: z.string().optional(),
            size: z.number().int().nonnegative().optional(),
            ...common,
          })
          .passthrough(),
      ]),
    ),
    structuredContent: z.record(z.unknown()).optional(),
    isError: z.boolean().optional(),
    _meta: z.record(z.unknown()).optional(),
  })
  .passthrough();
