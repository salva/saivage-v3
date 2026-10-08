import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import sharp from 'sharp';
import {
  ImageDescriptorSchema,
  throwIfPublicationOutcomeUnknown,
  MAX_IMAGE_PIXELS,
  type ImageDescriptor,
  type MaterializedImage,
} from '../contracts/index.js';
import type { ConversationSessionId } from '../schemas/index.js';
import { conversationImageFile } from './layout.js';
import { publishFreshFile } from './replace-file.js';
import { rejectAnimatedPng } from '../utils/index.js';

export function publishConversationImage(
  projectRoot: string,
  sessionId: ConversationSessionId,
  bytes: Buffer,
  dimensions: { width: number; height: number },
): ImageDescriptor {
  const descriptor = ImageDescriptorSchema.parse({
    id: randomUUID(),
    mime_type: 'image/png',
    ...dimensions,
    byte_length: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  const path = conversationImageFile(projectRoot, sessionId, descriptor.id);
  mkdirSync(dirname(path), { recursive: true });
  publishFreshFile(path, bytes);
  return descriptor;
}

export async function readConversationImageBytes(
  projectRoot: string,
  sessionId: ConversationSessionId,
  selected: ImageDescriptor,
): Promise<Buffer> {
  const descriptor = ImageDescriptorSchema.parse(selected);
  let bytes: Buffer;
  try {
    bytes = readFileSync(conversationImageFile(projectRoot, sessionId, descriptor.id));
  } catch (error) {
    throwIfPublicationOutcomeUnknown(error);
    // The Analyst can publish this message. Retain only a bounded filesystem code,
    // never the read error's physical path, message or cause.
    const code = (error as NodeJS.ErrnoException).code;
    const diagnostic = typeof code === 'string' && /^[A-Z_]{1,64}$/u.test(code) ? ` (${code})` : '';
    throw Object.assign(new Error(`Selected conversation image read failed${diagnostic}.`), {
      code: diagnostic ? code : undefined,
    });
  }
  if (
    bytes.length !== descriptor.byte_length ||
    createHash('sha256').update(bytes).digest('hex') !== descriptor.sha256
  )
    throw new Error('Selected conversation image length/hash mismatch.');
  rejectAnimatedPng(bytes);
  const metadata = await sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS }).metadata();
  const { info } = await sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'warning' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (
    metadata.format !== 'png' ||
    (metadata.pages ?? 1) !== 1 ||
    info.width !== descriptor.width ||
    info.height !== descriptor.height
  )
    throw new Error('Selected conversation image format/dimensions mismatch.');
  return bytes;
}

export async function materializeConversationImage(
  projectRoot: string,
  sessionId: ConversationSessionId,
  selected: ImageDescriptor,
): Promise<MaterializedImage> {
  const descriptor = ImageDescriptorSchema.parse(selected);
  const bytes = await readConversationImageBytes(projectRoot, sessionId, descriptor);
  return Object.freeze({
    descriptor,
    dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
  });
}
