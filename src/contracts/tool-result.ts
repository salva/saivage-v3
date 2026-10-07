import { z } from 'zod';
import {
  ImageDescriptorSchema,
  ViewImageDataSchema,
  type ImageDescriptor,
  type ViewImageData,
} from './image.js';

const actionOutcomeToken: unique symbol = Symbol('ToolActionOutcome');

export const ToolResultSchema = z
  .discriminatedUnion('success', [
    z
      .object({
        success: z.literal(true),
        data: z.unknown().optional(),
        image: ImageDescriptorSchema.optional(),
      })
      .strict(),
    z
      .object({ success: z.literal(false), error: z.string().min(1), data: z.unknown().optional() })
      .strict(),
  ])
  .superRefine((result, ctx) => {
    if (!result.success || !result.image) return;
    const data = ViewImageDataSchema.safeParse(result.data);
    if (
      !data.success ||
      data.data.sent_dimensions.width !== result.image.width ||
      data.data.sent_dimensions.height !== result.image.height
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Image result requires consistent strict view_image metadata.',
      });
  });

export type ToolResult = z.infer<typeof ToolResultSchema>;

type OutcomeToken = { readonly [actionOutcomeToken]: true };

export type ToolActionOutcome<Data = unknown> = (
  | Readonly<{ kind: 'succeeded'; data?: Data; error?: never; image?: ImageDescriptor }>
  | Readonly<{ kind: 'failed'; error: string; data?: unknown }>
) &
  OutcomeToken;

type SuccessData<Data> = Data extends ToolResult ? never : Data;

function brand<T extends object>(value: T): T & OutcomeToken {
  Object.defineProperty(value, actionOutcomeToken, { value: true, enumerable: false });
  return Object.freeze(value) as T & OutcomeToken;
}

export function toolSucceeded(): ToolActionOutcome<never>;
export function toolSucceeded<Data>(data: SuccessData<Data>): ToolActionOutcome<Data>;
export function toolSucceeded<Data>(data?: SuccessData<Data>): ToolActionOutcome<Data> {
  return brand(
    data === undefined ? { kind: 'succeeded' as const } : { kind: 'succeeded' as const, data },
  );
}

export function toolFailed(error: string, data?: unknown): ToolActionOutcome<never> {
  if (error.length === 0) throw new Error('Tool action failure requires a non-empty error.');
  return brand(
    data === undefined
      ? { kind: 'failed' as const, error }
      : { kind: 'failed' as const, error, data },
  );
}

export function assertToolActionOutcome(value: ToolActionOutcome): void {
  if (value[actionOutcomeToken] !== true)
    throw new Error('Tool action outcome was not created by the authority constructors.');
}

export function toolImageSucceeded(
  data: ViewImageData,
  image: ImageDescriptor,
): ToolActionOutcome<ViewImageData> {
  ToolResultSchema.parse({ success: true, data, image });
  return brand({ kind: 'succeeded' as const, data, image });
}
