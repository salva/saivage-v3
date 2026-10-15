import { z } from 'zod';
import type { ImageDescriptor } from './image.js';
import {
  imageMaxDimensionSchema,
  imageNormalizationFactsObjectSchema,
  refineImageNormalizationFacts,
} from './image-normalization.js';

export const viewImageInputSchema = z
  .object({ path: z.string().min(1), max_dimension: imageMaxDimensionSchema.optional() })
  .strict();
export const ViewImageDataSchema = z
  .object({ source_path: z.string().min(1), ...imageNormalizationFactsObjectSchema.shape })
  .strict()
  .superRefine(refineImageNormalizationFacts);
export type ViewImageData = z.infer<typeof ViewImageDataSchema>;

export function assertViewImageResult(data: unknown, image: ImageDescriptor): void {
  const parsed = ViewImageDataSchema.parse(data);
  if (
    parsed.sent_dimensions.width !== image.width ||
    parsed.sent_dimensions.height !== image.height
  )
    throw new Error('Image result requires consistent strict view_image metadata.');
}
