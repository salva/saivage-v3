import { copyFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
import { artifactRefSchema, attachmentRefSchema } from '../schemas/validators.js';
import type { ArtifactRef, AttachmentRef } from '../schemas/types.js';
import type { CardStore } from './card-store.js';

// ── Helpers ───────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString();
}

/**
 * Compute the next sequence number for artifacts or attachments
 * within a card's existing refs. ID format: '{prefix}-{cardId}-{seq}'
 * where seq is 1-based.
 */
function nextSeq(
  cardId: string,
  prefix: 'art' | 'att',
  existingIds: string[],
): number {
  const pattern = new RegExp(`^${prefix}-${escapeRegex(cardId)}-(\\d+)$`);
  const maxSeq = existingIds
    .map((id) => {
      const m = id.match(pattern);
      return m ? parseInt(m[1], 10) : 0;
    })
    .reduce((max, n) => Math.max(max, n), 0);
  return maxSeq + 1;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function targetDir(
  saivageWorkDir: string,
  cardId: string,
  subdir: string,
): string {
  const dir = join(saivageWorkDir, 'cards', cardId, subdir);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Public API ────────────────────────────────────────────────

/**
 * Register an artifact on a card.
 *
 * Copies the source file into .saivage-work/cards/{cardId}/artifacts/
 * (retained/ or working/ based on retain flag) and adds an ArtifactRef
 * to the card via CardStore.update().
 *
 * @param saivageWorkDir - Path to .saivage-work/ directory
 * @param store - CardStore instance (to read/update the card)
 * @param cardId - Card to attach artifact to
 * @param artifact - Artifact metadata (type, description, retain)
 * @param sourceFile - Absolute or relative path to the source file on disk
 * @returns The created and validated ArtifactRef
 */
export function registerArtifact(
  saivageWorkDir: string,
  store: CardStore,
  cardId: string,
  artifact: {
    type: ArtifactRef['type'];
    description: string;
    retain: boolean;
  },
  sourceFile: string,
): ArtifactRef {
  // 1. Read the card
  const card = store.read(cardId);
  if (!card) {
    throw new Error(`Card '${cardId}' not found.`);
  }

  // 2. Verify source file exists
  if (!existsSync(sourceFile)) {
    throw new Error(`Source file not found: ${sourceFile}`);
  }

  // 3. Generate ID
  const existingIds = card.artifacts.map((a) => a.id);
  const seq = nextSeq(cardId, 'art', existingIds);
  const id = `art-${cardId}-${seq}`;

  // 4. Determine target directory and file name
  const subdir = artifact.retain ? 'artifacts/retained' : 'artifacts/working';
  const destDir = targetDir(saivageWorkDir, cardId, subdir);
  const fileName = basename(sourceFile);
  const destPath = join(destDir, fileName);

  // 5. Copy the file
  copyFileSync(sourceFile, destPath);

  // 6. Build the ArtifactRef
  const ref: ArtifactRef = {
    id,
    card_id: cardId,
    path: destPath,
    type: artifact.type,
    description: artifact.description,
    retain: artifact.retain,
    created_at: now(),
  };

  // 7. Validate
  const parsed = artifactRefSchema.safeParse(ref);
  if (!parsed.success) {
    throw new Error(`ArtifactRef validation failed: ${parsed.error.message}`);
  }

  // 8. Update the card
  const updatedArtifacts = [...card.artifacts, parsed.data];
  store.update(cardId, { artifacts: updatedArtifacts });

  return parsed.data;
}

/**
 * Register an attachment on a card.
 *
 * Copies the source file into .saivage-work/cards/{cardId}/attachments/
 * and adds an AttachmentRef to the card via CardStore.update().
 *
 * @param saivageWorkDir - Path to .saivage-work/ directory
 * @param store - CardStore instance
 * @param cardId - Card to attach to
 * @param attachment - Attachment metadata (mime, title, optional description)
 * @param sourceFile - Absolute or relative path to the source file on disk
 * @returns The created and validated AttachmentRef
 */
export function registerAttachment(
  saivageWorkDir: string,
  store: CardStore,
  cardId: string,
  attachment: {
    mime: string;
    title: string;
    description?: string;
  },
  sourceFile: string,
): AttachmentRef {
  // 1. Read the card
  const card = store.read(cardId);
  if (!card) {
    throw new Error(`Card '${cardId}' not found.`);
  }

  // 2. Verify source file exists
  if (!existsSync(sourceFile)) {
    throw new Error(`Source file not found: ${sourceFile}`);
  }

  // 3. Generate ID
  const existingIds = card.attachments.map((a) => a.id);
  const seq = nextSeq(cardId, 'att', existingIds);
  const id = `att-${cardId}-${seq}`;

  // 4. Determine target directory and file name
  const destDir = targetDir(saivageWorkDir, cardId, 'attachments');
  const fileName = basename(sourceFile);
  const destPath = join(destDir, fileName);

  // 5. Copy the file
  copyFileSync(sourceFile, destPath);

  // 6. Build the AttachmentRef
  const ref: AttachmentRef = {
    id,
    card_id: cardId,
    path: destPath,
    mime: attachment.mime,
    title: attachment.title,
    description: attachment.description,
    created_at: now(),
  };

  // 7. Validate
  const parsed = attachmentRefSchema.safeParse(ref);
  if (!parsed.success) {
    throw new Error(`AttachmentRef validation failed: ${parsed.error.message}`);
  }

  // 8. Update the card
  const updatedAttachments = [...card.attachments, parsed.data];
  store.update(cardId, { attachments: updatedAttachments });

  return parsed.data;
}

/**
 * Get all artifact refs for a card.
 *
 * @param store - CardStore instance
 * @param cardId - Card ID
 * @returns Array of ArtifactRef (empty array if card not found or no artifacts)
 */
export function getArtifacts(store: CardStore, cardId: string): ArtifactRef[] {
  const card = store.read(cardId);
  if (!card) {
    throw new Error(`Card '${cardId}' not found.`);
  }
  return card.artifacts;
}

/**
 * Get artifacts filtered by retain flag.
 *
 * @param store - CardStore instance
 * @param cardId - Card ID
 * @param retain - true for retained, false for working
 * @returns Array of ArtifactRef matching the retain filter
 */
export function getArtifactsByRetention(
  store: CardStore,
  cardId: string,
  retain: boolean,
): ArtifactRef[] {
  return getArtifacts(store, cardId).filter((a) => a.retain === retain);
}

/**
 * Get all attachment refs for a card.
 *
 * @param store - CardStore instance
 * @param cardId - Card ID
 * @returns Array of AttachmentRef (empty array if card not found or no attachments)
 */
export function getAttachments(
  store: CardStore,
  cardId: string,
): AttachmentRef[] {
  const card = store.read(cardId);
  if (!card) {
    throw new Error(`Card '${cardId}' not found.`);
  }
  return card.attachments;
}

/**
 * Remove an artifact from a card.
 *
 * Removes the ArtifactRef from the card and optionally deletes the
 * underlying file from disk.
 *
 * @param saivageWorkDir - Path to .saivage-work/ directory
 * @param store - CardStore instance
 * @param cardId - Card ID
 * @param artifactId - ID of the artifact to remove
 * @param removeFile - If true, also delete the file from disk (default: false)
 * @returns true if removed, false if artifact not found
 */
export function removeArtifact(
  saivageWorkDir: string,
  store: CardStore,
  cardId: string,
  artifactId: string,
  removeFile: boolean = false,
): boolean {
  const card = store.read(cardId);
  if (!card) {
    throw new Error(`Card '${cardId}' not found.`);
  }

  const idx = card.artifacts.findIndex((a) => a.id === artifactId);
  if (idx === -1) {
    return false;
  }

  const artifact = card.artifacts[idx];

  // Optionally remove the file
  if (removeFile) {
    if (existsSync(artifact.path)) {
      unlinkSync(artifact.path);
    }
  }

  // Remove from card's artifacts array
  const updatedArtifacts = card.artifacts.filter((a) => a.id !== artifactId);
  store.update(cardId, { artifacts: updatedArtifacts });

  return true;
}

/**
 * Remove an attachment from a card.
 *
 * Removes the AttachmentRef from the card and optionally deletes the
 * underlying file from disk.
 *
 * @param saivageWorkDir - Path to .saivage-work/ directory
 * @param store - CardStore instance
 * @param cardId - Card ID
 * @param attachmentId - ID of the attachment to remove
 * @param removeFile - If true, also delete the file from disk (default: false)
 * @returns true if removed, false if attachment not found
 */
export function removeAttachment(
  saivageWorkDir: string,
  store: CardStore,
  cardId: string,
  attachmentId: string,
  removeFile: boolean = false,
): boolean {
  const card = store.read(cardId);
  if (!card) {
    throw new Error(`Card '${cardId}' not found.`);
  }

  const idx = card.attachments.findIndex((a) => a.id === attachmentId);
  if (idx === -1) {
    return false;
  }

  const attachment = card.attachments[idx];

  // Optionally remove the file
  if (removeFile) {
    if (existsSync(attachment.path)) {
      unlinkSync(attachment.path);
    }
  }

  // Remove from card's attachments array
  const updatedAttachments = card.attachments.filter(
    (a) => a.id !== attachmentId,
  );
  store.update(cardId, { attachments: updatedAttachments });

  return true;
}
