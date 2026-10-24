import { z } from 'zod';

export const operationOutputSourceSchema = z.enum(['command-stdout', 'returned-text']);
export type OperationOutputSource = z.infer<typeof operationOutputSourceSchema>;

/** Describes the exact accepted bytes, independently of mutable work artifacts. */
export const actionOutputDescriptorSchema = z
  .object({
    source: operationOutputSourceSchema,
    size_bytes: z
      .number()
      .int()
      .safe()
      .positive()
      .max(1024 * 1024),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();
export type ActionOutputDescriptor = z.infer<typeof actionOutputDescriptorSchema>;
