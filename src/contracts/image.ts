import { z } from 'zod';

export const MAX_IMAGE_SOURCE_BYTES = 32 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 40_000_000;
export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
export const MAX_IMAGE_REQUEST_BYTES = 32 * 1024 * 1024;
const imageDimensionsSchema = z
  .object({
    width: z.number().int().positive().max(MAX_IMAGE_PIXELS),
    height: z.number().int().positive().max(MAX_IMAGE_PIXELS),
  })
  .strict()
  .refine(({ width, height }) => width * height <= MAX_IMAGE_PIXELS, 'Image pixel limit exceeded.');
const imageMaxDimensionSchema = z.union([
  z.number().int().min(1).max(16384),
  z.literal('original'),
]);
export const viewImageInputSchema = z
  .object({
    path: z.string().min(1),
    max_dimension: imageMaxDimensionSchema.optional(),
  })
  .strict();
export const ImageDescriptorSchema = z
  .object({
    id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u),
    mime_type: z.literal('image/png'),
    width: z.number().int().positive().max(MAX_IMAGE_PIXELS),
    height: z.number().int().positive().max(MAX_IMAGE_PIXELS),
    byte_length: z.number().int().positive().max(MAX_IMAGE_BYTES),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict()
  .refine(({ width, height }) => width * height <= MAX_IMAGE_PIXELS, 'Image pixel limit exceeded.');
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
export type ImageDescriptor = z.infer<typeof ImageDescriptorSchema>;
export type ViewImageData = z.infer<typeof ViewImageDataSchema>;
export type MaterializedImage = Readonly<{ descriptor: ImageDescriptor; dataUrl: string }>;

export function rasterReservation(image: Pick<ImageDescriptor, 'width' | 'height'>): number {
  return 2 * Math.ceil(image.width / 32) * Math.ceil(image.height / 32);
}
function encodedPartBytes(image: Pick<ImageDescriptor, 'byte_length'>): number {
  return (
    JSON.stringify({ type: 'input_image', image_url: '' }).length +
    'data:image/png;base64,'.length +
    4 * Math.ceil(image.byte_length / 3)
  );
}
export function imageAccountingBytes(image: ImageDescriptor): number {
  return encodedPartBytes(image) + 4 * rasterReservation(image);
}
export function imageEstimatedTokens(image: ImageDescriptor): number {
  return Math.ceil(encodedPartBytes(image) / 4) + rasterReservation(image);
}
