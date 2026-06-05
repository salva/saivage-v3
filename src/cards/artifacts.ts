import { copyFileSync, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
import { artifactRefSchema, attachmentRefSchema } from '../schemas/index.js';
import type { ArtifactRef, AttachmentRef } from '../schemas/index.js';
import type { CardStore, NewArtifactRef, NewAttachmentRef } from './card-store.js';

// ── Helpers ───────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString();
}

function targetDir(saivageWorkDir: string, cardId: string, subdir: string): string {
  const dir = join(saivageWorkDir, 'cards', cardId, subdir);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export interface ArtifactRegistrationInput {
  type: ArtifactRef['type'];
  description: string;
  retain: boolean;
  sourceFile: string;
}

export interface AttachmentRegistrationInput {
  mime: string;
  title: string;
  description?: string;
  sourceFile: string;
}

function assertSourceFile(sourceFile: string): void {
  if (!existsSync(sourceFile)) {
    throw new Error(`Source file not found: ${sourceFile}`);
  }
  if (!statSync(sourceFile).isFile()) {
    throw new Error(`Source path is not a file: ${sourceFile}`);
  }
}

function prepareArtifact(saivageWorkDir: string, cardId: string, artifact: ArtifactRegistrationInput): NewArtifactRef {
  assertSourceFile(artifact.sourceFile);
  const subdir = artifact.retain ? 'artifacts/retained' : 'artifacts/working';
  const destDir = targetDir(saivageWorkDir, cardId, subdir);
  const destPath = join(destDir, basename(artifact.sourceFile));
  copyFileSync(artifact.sourceFile, destPath);
  return {
    path: destPath,
    type: artifact.type,
    description: artifact.description,
    retain: artifact.retain,
    created_at: now(),
  };
}

function prepareAttachment(saivageWorkDir: string, cardId: string, attachment: AttachmentRegistrationInput): NewAttachmentRef {
  assertSourceFile(attachment.sourceFile);
  const destDir = targetDir(saivageWorkDir, cardId, 'attachments');
  const destPath = join(destDir, basename(attachment.sourceFile));
  copyFileSync(attachment.sourceFile, destPath);
  return {
    path: destPath,
    mime: attachment.mime,
    title: attachment.title,
    description: attachment.description,
    created_at: now(),
  };
}

export function registerEvidenceRefs(
  saivageWorkDir: string,
  store: CardStore,
  cardId: string,
  input: { artifacts?: ArtifactRegistrationInput[]; attachments?: AttachmentRegistrationInput[] },
): { artifacts: ArtifactRef[]; attachments: AttachmentRef[] } {
  if (!store.read(cardId)) throw new Error(`Card '${cardId}' not found.`);
  const artifacts = (input.artifacts ?? []).map((artifact) => prepareArtifact(saivageWorkDir, cardId, artifact));
  const attachments = (input.attachments ?? []).map((attachment) => prepareAttachment(saivageWorkDir, cardId, attachment));
  const appended = store.appendEvidenceRefs(cardId, { artifacts, attachments });
  return {
    artifacts: appended.artifacts.map((artifact) => artifactRefSchema.parse(artifact)),
    attachments: appended.attachments.map((attachment) => attachmentRefSchema.parse(attachment)),
  };
}

export function registerEvidenceRefsBestEffort(
  saivageWorkDir: string,
  store: CardStore,
  cardId: string,
  input: { artifacts?: ArtifactRegistrationInput[]; attachments?: AttachmentRegistrationInput[] },
): { artifacts: ArtifactRef[]; attachments: AttachmentRef[]; artifactRegistrationErrors: string[]; attachmentRegistrationErrors: string[] } {
  const artifactRegistrationErrors: string[] = [];
  const attachmentRegistrationErrors: string[] = [];
  const artifacts: NewArtifactRef[] = [];
  const attachments: NewAttachmentRef[] = [];
  if (!store.read(cardId)) {
    const errorMessage = `Card '${cardId}' not found.`;
    return {
      artifacts: [],
      attachments: [],
      artifactRegistrationErrors: (input.artifacts ?? []).map(() => errorMessage),
      attachmentRegistrationErrors: (input.attachments ?? []).map(() => errorMessage),
    };
  }

  for (const artifact of input.artifacts ?? []) {
    try {
      artifacts.push(prepareArtifact(saivageWorkDir, cardId, artifact));
    } catch (err) {
      artifactRegistrationErrors.push(err instanceof Error ? err.message : String(err));
    }
  }
  for (const attachment of input.attachments ?? []) {
    try {
      attachments.push(prepareAttachment(saivageWorkDir, cardId, attachment));
    } catch (err) {
      attachmentRegistrationErrors.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (artifacts.length === 0 && attachments.length === 0) {
    return { artifacts: [], attachments: [], artifactRegistrationErrors, attachmentRegistrationErrors };
  }

  try {
    const appended = store.appendEvidenceRefs(cardId, { artifacts, attachments });
    return {
      artifacts: appended.artifacts.map((artifact) => artifactRefSchema.parse(artifact)),
      attachments: appended.attachments.map((attachment) => attachmentRefSchema.parse(attachment)),
      artifactRegistrationErrors,
      attachmentRegistrationErrors,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    if (artifacts.length > 0) artifactRegistrationErrors.push(errorMessage);
    if (attachments.length > 0) attachmentRegistrationErrors.push(errorMessage);
    return { artifacts: [], attachments: [], artifactRegistrationErrors, attachmentRegistrationErrors };
  }
}

// ── Public API ────────────────────────────────────────────────

/**
 * Register an artifact on a card.
 *
 * Copies the source file into .saivage-work/cards/{cardId}/artifacts/
 * (retained/ or working/ based on retain flag) and adds an ArtifactRef
 * to the card via CardStore.appendEvidenceRefs().
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
  return registerEvidenceRefs(saivageWorkDir, store, cardId, { artifacts: [{ ...artifact, sourceFile }] }).artifacts[0];
}

/**
 * Register an attachment on a card.
 *
 * Copies the source file into .saivage-work/cards/{cardId}/attachments/
 * and adds an AttachmentRef to the card via CardStore.appendEvidenceRefs().
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
  return registerEvidenceRefs(saivageWorkDir, store, cardId, { attachments: [{ ...attachment, sourceFile }] }).attachments[0];
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
export function getAttachments(store: CardStore, cardId: string): AttachmentRef[] {
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
  const updatedAttachments = card.attachments.filter((a) => a.id !== attachmentId);
  store.update(cardId, { attachments: updatedAttachments });

  return true;
}
