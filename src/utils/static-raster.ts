import sharp from 'sharp';
import { MAX_IMAGE_PIXELS, MAX_IMAGE_SOURCE_BYTES } from '../contracts/index.js';

export class RasterInputError extends Error {}

export function isRasterDecodeInputError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /^(Input buffer contains unsupported image format|Input buffer has corrupt header|Input image exceeds pixel limit|VipsJpeg: (?:Premature end|Invalid|Corrupt|Bogus|Not a JPEG|JPEG datastream)|pngload_buffer: (?:end of stream|libspng read error|invalid|bad)|vipspng: (?:Invalid|invalid|Read Error|read error|libpng read error)|webpload_buffer: (?:unable to parse|invalid|bad|WebP decoder))/u.test(
      error.message,
    )
  );
}

export function rejectAnimatedPng(bytes: Buffer): void {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return;
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (offset + length + 12 > bytes.length) throw new RasterInputError('Invalid PNG chunk.');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (type === 'acTL') throw new RasterInputError('Animated images are not supported.');
    offset += length + 12;
    if (type === 'IEND') break;
  }
}

export async function inspectStaticRaster(bytes: Buffer) {
  if (bytes.length === 0) throw new RasterInputError('Empty image input.');
  if (bytes.length > MAX_IMAGE_SOURCE_BYTES)
    throw new RasterInputError('Image source exceeds byte limit.');
  rejectAnimatedPng(bytes);
  const options = { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'warning' as const };
  const metadata = await sharp(bytes, options).metadata();
  const mime: 'image/png' | 'image/jpeg' | 'image/webp' | null =
    metadata.format === 'png'
      ? 'image/png'
      : metadata.format === 'jpeg'
        ? 'image/jpeg'
        : metadata.format === 'webp'
          ? 'image/webp'
          : null;
  if (!mime || (metadata.pages ?? 1) !== 1)
    throw new RasterInputError('Unsupported static raster image.');
  const { info } = await sharp(bytes, options)
    .autoOrient()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { mime, width: info.width, height: info.height };
}
