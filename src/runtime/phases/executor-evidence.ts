import { isAbsolute, relative, resolve } from 'node:path';
import { registerArtifact, registerAttachment } from '../../cards/artifact-api.js';
import type { CardStore } from '../../cards/store-api.js';
import type { ExecutorResult } from '../../contracts/index.js';
import type { CardRecord } from '../../schemas/index.js';

export interface ExecutorEvidenceRegistrationResult {
  artifactRegistrationErrors: string[];
  attachmentRegistrationErrors: string[];
  ignoredArtifactRegistrations: string[];
  ignoredAttachmentRegistrations: string[];
}

export interface ExecutorEvidenceRegistrarDeps {
  projectRoot: string;
  registerArtifact(input: { type: 'model' | 'data' | 'config' | 'log' | 'report' | 'other'; description: string; retain: boolean; sourceFile: string }): void;
  registerAttachment(input: { mime: string; title: string; description?: string; sourceFile: string }): void;
  onRegistrationError(input: { phase: 'artifact_registration' | 'attachment_registration'; error: unknown; errorMessage: string }): void;
}

export function createExecutorEvidenceRegistrar(input: {
  projectRoot: string;
  cards: CardStore;
  cardId: string;
  onRegistrationError(input: { phase: 'artifact_registration' | 'attachment_registration'; error: unknown; errorMessage: string }): void;
}): ExecutorEvidenceRegistrarDeps {
  return {
    projectRoot: input.projectRoot,
    registerArtifact: (artifact) => {
      registerArtifact(saivageWorkDir(input.projectRoot), input.cards, input.cardId, artifact, artifact.sourceFile);
    },
    registerAttachment: (attachment) => {
      registerAttachment(saivageWorkDir(input.projectRoot), input.cards, input.cardId, attachment, attachment.sourceFile);
    },
    onRegistrationError: input.onRegistrationError,
  };
}

function saivageWorkDir(projectRoot: string): string {
  return resolve(projectRoot, '.saivage-work');
}

function pathIsInside(parentPath: string, candidatePath: string): boolean {
  const rel = relative(resolve(parentPath), resolve(candidatePath));
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

export function resolveRegisterableProcessMetadataSource(projectRoot: string, filePath: string): { sourceFile: string } | { ignored: string } {
  if (!filePath.trim()) {
    return { ignored: 'Missing evidence source path; registered artifacts and attachments must point at Saivage process metadata under .saivage-work.' };
  }
  const sourceFile = isAbsolute(filePath) ? resolve(filePath) : resolve(projectRoot, filePath);
  if (!pathIsInside(saivageWorkDir(projectRoot), sourceFile)) {
    return { ignored: `Project files are not registered as artifacts or attachments: '${filePath}'. Record project changes in result/status_text; register only Saivage process metadata under .saivage-work.` };
  }
  return { sourceFile };
}

export function registerExecutorEvidence(deps: ExecutorEvidenceRegistrarDeps, execResult: ExecutorResult): ExecutorEvidenceRegistrationResult {
  const artifactRegistrationErrors: string[] = [];
  const attachmentRegistrationErrors: string[] = [];
  const ignoredArtifactRegistrations: string[] = [];
  const ignoredAttachmentRegistrations: string[] = [];

  for (const artDef of execResult.artifacts ?? []) {
    const sourcePath = artDef.sourceFile ?? artDef.path ?? '';
    const resolved = resolveRegisterableProcessMetadataSource(deps.projectRoot, sourcePath);
    if ('ignored' in resolved) {
      ignoredArtifactRegistrations.push(resolved.ignored);
      continue;
    }
    try {
      deps.registerArtifact({ type: artDef.type, description: artDef.description, retain: artDef.retain, sourceFile: resolved.sourceFile });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      artifactRegistrationErrors.push(errorMessage);
      deps.onRegistrationError({ phase: 'artifact_registration', error: err, errorMessage });
    }
  }

  for (const attDef of execResult.attachments ?? []) {
    const sourcePath = attDef.sourceFile ?? attDef.path ?? '';
    const resolved = resolveRegisterableProcessMetadataSource(deps.projectRoot, sourcePath);
    if ('ignored' in resolved) {
      ignoredAttachmentRegistrations.push(resolved.ignored);
      continue;
    }
    try {
      deps.registerAttachment({ mime: attDef.mime, title: attDef.title, description: attDef.description, sourceFile: resolved.sourceFile });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      attachmentRegistrationErrors.push(errorMessage);
      deps.onRegistrationError({ phase: 'attachment_registration', error: err, errorMessage });
    }
  }

  return { artifactRegistrationErrors, attachmentRegistrationErrors, ignoredArtifactRegistrations, ignoredAttachmentRegistrations };
}

export function buildIgnoredExecutorEvidencePatch(input: {
  existingResult: CardRecord['result'] | undefined;
  ignoredArtifactRegistrations: string[];
  ignoredAttachmentRegistrations: string[];
}): Partial<CardRecord> | null {
  if (input.ignoredArtifactRegistrations.length === 0 && input.ignoredAttachmentRegistrations.length === 0) return null;
  return {
    result: {
      ...(input.existingResult ?? {}),
      evidence_registration_ignored: {
        artifacts: input.ignoredArtifactRegistrations,
        attachments: input.ignoredAttachmentRegistrations,
      },
    },
  };
}

export function summarizeExecutorEvidenceRegistrationFailure(input: {
  execStatus: ExecutorResult['status'];
  artifactRegistrationErrors: string[];
  attachmentRegistrationErrors: string[];
}): { registrationFailed: boolean; registrationError: string | null } {
  const registrationFailed =
    input.execStatus === 'done' &&
    (input.artifactRegistrationErrors.length > 0 || input.attachmentRegistrationErrors.length > 0);
  return {
    registrationFailed,
    registrationError: registrationFailed
      ? `Completion blocked by evidence registration failure. Artifacts: ${input.artifactRegistrationErrors.join(' | ') || 'none'}. Attachments: ${input.attachmentRegistrationErrors.join(' | ') || 'none'}.`
      : null,
  };
}
