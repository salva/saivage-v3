import sharp from 'sharp';
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_PIXELS,
  MAX_IMAGE_SOURCE_BYTES,
  ViewImageDataSchema,
  type ViewImageData,
} from '../contracts/index.js';
import { WorkspaceToolInputError } from './project-file-tools.js';

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function rejectAnimation(bytes: Buffer): void {
  if (!bytes.subarray(0, 8).equals(pngSignature)) return;
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (offset + length + 12 > bytes.length)
      throw new WorkspaceToolInputError('Invalid PNG chunk.');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (type === 'acTL') throw new WorkspaceToolInputError('Animated images are not supported.');
    offset += length + 12;
    if (type === 'IEND') break;
  }
}

// Only established decoder input failures are ordinary tool failures. Programming,
// native loading and unrelated failures propagate unchanged.
async function decodeInput<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof Error &&
      /^(Input buffer contains unsupported image format|Input buffer has corrupt header|Input image exceeds pixel limit|VipsJpeg: (?:Premature end|Invalid|Corrupt|Bogus|Not a JPEG|JPEG datastream)|pngload_buffer: (?:end of stream|libspng read error|invalid|bad)|vipspng: (?:Invalid|invalid|Read Error|read error|libpng read error))/u.test(
        error.message,
      )
    )
      throw new WorkspaceToolInputError(
        'Invalid or oversized PNG/JPEG image; generate a smaller valid source.',
      );
    throw error;
  }
}

export async function normalizeWorkspaceImage(
  bytes: Buffer,
  sourcePath: string,
  maxDimension: number | 'original' = 1600,
): Promise<{ bytes: Buffer; data: ViewImageData }> {
  if (bytes.length > MAX_IMAGE_SOURCE_BYTES)
    throw new WorkspaceToolInputError('Image source exceeds 32 MiB; generate a smaller source.');
  rejectAnimation(bytes);
  const options = { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'warning' as const };
  const metadata = await decodeInput(() => sharp(bytes, options).metadata());
  if (metadata.format !== 'png' && metadata.format !== 'jpeg')
    throw new WorkspaceToolInputError('Only decoded PNG/JPEG images are supported.');
  if ((metadata.pages ?? 1) !== 1)
    throw new WorkspaceToolInputError('Animated images are not supported.');
  const { width, height } = metadata;
  if (
    !width ||
    !height ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width * height > MAX_IMAGE_PIXELS
  )
    throw new WorkspaceToolInputError('Invalid image dimensions or source pixel limit exceeded.');
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
    throw new WorkspaceToolInputError(
      'Selected PNG exceeds 16 MiB; use a smaller max_dimension or generate a smaller source.',
    );
  const sent = { width: output.info.width, height: output.info.height };
  const data = ViewImageDataSchema.parse({
    source_path: sourcePath,
    source_dimensions: { width, height },
    oriented_dimensions: upright,
    sent_dimensions: sent,
    orientation_applied: orientation !== 1,
    resized: sent.width < upright.width || sent.height < upright.height,
    scale: { x: sent.width / upright.width, y: sent.height / upright.height },
    max_dimension: maxDimension,
  });
  return { bytes: output.data, data };
}
