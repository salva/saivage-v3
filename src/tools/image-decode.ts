import sharp from 'sharp';
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_PIXELS,
  MAX_IMAGE_SOURCE_BYTES,
  ViewImageDataSchema,
  type ViewImageData,
} from '../contracts/index.js';
import { ImageInputError } from './image-input-error.js';
import { rejectAnimatedPng, RasterInputError, isRasterDecodeInputError } from '../utils/index.js';

// Only established decoder input failures are ordinary tool failures. Programming,
// native loading and unrelated failures propagate unchanged.
async function decodeInput<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isRasterDecodeInputError(error))
      throw new ImageInputError('Invalid or oversized image; generate a smaller valid source.');
    throw error;
  }
}

export async function normalizeImage(
  bytes: Buffer,
  maxDimension: number | 'original' = 1600,
  declaredMime?: string,
): Promise<{ bytes: Buffer; data: Omit<ViewImageData, 'source_path'> }> {
  if (bytes.length > MAX_IMAGE_SOURCE_BYTES)
    throw new ImageInputError('Image source exceeds 32 MiB; generate a smaller source.');
  try {
    rejectAnimatedPng(bytes);
  } catch (error) {
    if (!(error instanceof RasterInputError)) throw error;
    throw new ImageInputError(error.message);
  }
  const options = { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'warning' as const };
  const metadata = await decodeInput(() => sharp(bytes, options).metadata());
  const formats = declaredMime === undefined ? ['png', 'jpeg'] : ['png', 'jpeg', 'webp'];
  if (!formats.includes(metadata.format ?? ''))
    throw new ImageInputError('Unsupported decoded image format.');
  if (declaredMime !== undefined && declaredMime !== `image/${metadata.format}`)
    throw new ImageInputError('Image MIME does not match decoded format.');
  if ((metadata.pages ?? 1) !== 1) throw new ImageInputError('Animated images are not supported.');
  const { width, height } = metadata;
  if (
    !width ||
    !height ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width * height > MAX_IMAGE_PIXELS
  )
    throw new ImageInputError('Invalid image dimensions or source pixel limit exceeded.');
  const orientation = metadata.orientation ?? 1;
  const swap = orientation >= 5 && orientation <= 8;
  const upright = { width: swap ? height : width, height: swap ? width : height };
  let pipeline = sharp(bytes, options).autoOrient();
  if (maxDimension !== 'original')
    pipeline = pipeline.resize({
      width: maxDimension,
      height: maxDimension,
      fit: 'inside',
      withoutEnlargement: true,
      kernel: 'lanczos3',
      fastShrinkOnLoad: false,
    });
  const output = await decodeInput(() =>
    pipeline.toColourspace('srgb').png().toBuffer({ resolveWithObject: true }),
  );
  if (output.data.length > MAX_IMAGE_BYTES)
    throw new ImageInputError(
      'Selected PNG exceeds 16 MiB; use a smaller max_dimension or generate a smaller source.',
    );
  const sent = { width: output.info.width, height: output.info.height };
  const data = {
    source_dimensions: { width, height },
    oriented_dimensions: upright,
    sent_dimensions: sent,
    orientation_applied: orientation !== 1,
    resized: sent.width < upright.width || sent.height < upright.height,
    scale: { x: sent.width / upright.width, y: sent.height / upright.height },
    max_dimension: maxDimension,
  };
  return { bytes: output.data, data };
}

export async function normalizeWorkspaceImage(
  bytes: Buffer,
  sourcePath: string,
  maxDimension: number | 'original' = 1600,
): Promise<{ bytes: Buffer; data: ViewImageData }> {
  const selected = await normalizeImage(bytes, maxDimension);
  return {
    bytes: selected.bytes,
    data: ViewImageDataSchema.parse({ source_path: sourcePath, ...selected.data }),
  };
}
