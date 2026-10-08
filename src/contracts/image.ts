import { z } from 'zod';

export const MAX_IMAGE_SOURCE_BYTES = 32 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 40_000_000;
export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
export const MAX_IMAGE_REQUEST_BYTES = 32 * 1024 * 1024;
export const ImageIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
export const ImageDescriptorSchema = z
  .object({
    id: ImageIdSchema,
    mime_type: z.literal('image/png'),
    width: z.number().int().positive().max(MAX_IMAGE_PIXELS),
    height: z.number().int().positive().max(MAX_IMAGE_PIXELS),
    byte_length: z.number().int().positive().max(MAX_IMAGE_BYTES),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict()
  .refine(({ width, height }) => width * height <= MAX_IMAGE_PIXELS, 'Image pixel limit exceeded.');
export type ImageDescriptor = z.infer<typeof ImageDescriptorSchema>;
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
