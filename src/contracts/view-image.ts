import { z } from 'zod';
import { MAX_IMAGE_PIXELS, type ImageDescriptor } from './image.js';

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
export const viewImageInputSchema = z
  .object({ path: z.string().min(1), max_dimension: imageMaxDimensionSchema.optional() })
  .strict();
export const ViewImageDataSchema = z
  .object({
    source_path: z.string().min(1),
    source_dimensions: imageDimensionsSchema,
    oriented_dimensions: imageDimensionsSchema,
    sent_dimensions: imageDimensionsSchema,
    orientation_applied: z.boolean(),
    resized: z.boolean(),
    scale: z.object({ x: z.number().positive().max(1), y: z.number().positive().max(1) }).strict(),
    max_dimension: imageMaxDimensionSchema,
  })
  .strict()
  .superRefine((data, ctx) => {
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
  });
export type ViewImageData = z.infer<typeof ViewImageDataSchema>;

export function assertViewImageResult(data: unknown, image: ImageDescriptor): void {
  const parsed = ViewImageDataSchema.parse(data);
  if (
    parsed.sent_dimensions.width !== image.width ||
    parsed.sent_dimensions.height !== image.height
  )
    throw new Error('Image result requires consistent strict view_image metadata.');
}
