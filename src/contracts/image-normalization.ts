import { z } from 'zod';
import { MAX_IMAGE_PIXELS } from './image.js';

const imageDimensionsSchema = z
  .object({
    width: z.number().int().positive().max(MAX_IMAGE_PIXELS),
    height: z.number().int().positive().max(MAX_IMAGE_PIXELS),
  })
  .strict()
  .refine(({ width, height }) => width * height <= MAX_IMAGE_PIXELS, 'Image pixel limit exceeded.');
export const imageMaxDimensionSchema = z.union([
  z.number().int().min(1).max(16384),
  z.literal('original'),
]);
export const imageNormalizationFactsObjectSchema = z
  .object({
    source_dimensions: imageDimensionsSchema,
    oriented_dimensions: imageDimensionsSchema,
    sent_dimensions: imageDimensionsSchema,
    orientation_applied: z.boolean(),
    resized: z.boolean(),
    scale: z.object({ x: z.number().positive().max(1), y: z.number().positive().max(1) }).strict(),
    max_dimension: imageMaxDimensionSchema,
  })
  .strict();

export function refineImageNormalizationFacts(
  data: z.infer<typeof imageNormalizationFactsObjectSchema>,
  ctx: z.RefinementCtx,
): void {
  const source = data.source_dimensions;
  const upright = data.oriented_dimensions;
  const sent = data.sent_dimensions;
  const same = source.width === upright.width && source.height === upright.height;
  const swapped = source.width === upright.height && source.height === upright.width;
  if (
    (!same && !swapped) ||
    (!data.orientation_applied && !same) ||
    sent.width > upright.width ||
    sent.height > upright.height ||
    data.scale.x !== sent.width / upright.width ||
    data.scale.y !== sent.height / upright.height ||
    data.resized !== (sent.width < upright.width || sent.height < upright.height) ||
    (data.max_dimension === 'original' && data.resized) ||
    (typeof data.max_dimension === 'number' &&
      Math.max(sent.width, sent.height) > data.max_dimension) ||
    Math.abs(sent.width * upright.height - sent.height * upright.width) >
      Math.max(upright.width, upright.height)
  )
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Inconsistent image selection metadata.',
    });
}

export const ImageNormalizationFactsSchema = imageNormalizationFactsObjectSchema.superRefine(
  refineImageNormalizationFacts,
);
export type ImageNormalizationFacts = z.infer<typeof ImageNormalizationFactsSchema>;
