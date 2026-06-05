import { isAbsolute, relative, resolve } from 'node:path';
import { registerEvidenceRefs, registerEvidenceRefsBestEffort } from '../../cards/artifact-api.js';
import type { CardStore } from '../../cards/store-api.js';
import type { ExecutorResult } from '../../contracts/index.js';
import type { CardLifecycleState, CardRecord } from '../../schemas/index.js';
import { generatedFileValidationErrors, validateGeneratedFiles } from '../terminal-commit/validators.js';

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
  registerEvidenceBatch?(input: {
    artifacts: Array<{ type: 'model' | 'data' | 'config' | 'log' | 'report' | 'other'; description: string; retain: boolean; sourceFile: string }>;
    attachments: Array<{ mime: string; title: string; description?: string; sourceFile: string }>;
  }): { artifactRegistrationErrors: string[]; attachmentRegistrationErrors: string[] } | void;
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
      registerEvidenceRefs(saivageWorkDir(input.projectRoot), input.cards, input.cardId, { artifacts: [artifact] });
    },
    registerAttachment: (attachment) => {
      registerEvidenceRefs(saivageWorkDir(input.projectRoot), input.cards, input.cardId, { attachments: [attachment] });
    },
    registerEvidenceBatch: (evidence) => {
      return registerEvidenceRefsBestEffort(saivageWorkDir(input.projectRoot), input.cards, input.cardId, evidence);
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
  const artifactBatch: Array<{ type: 'model' | 'data' | 'config' | 'log' | 'report' | 'other'; description: string; retain: boolean; sourceFile: string }> = [];
  const attachmentBatch: Array<{ mime: string; title: string; description?: string; sourceFile: string }> = [];

  for (const artDef of execResult.artifacts ?? []) {
    const sourcePath = artDef.sourceFile ?? artDef.path ?? '';
    const resolved = resolveRegisterableProcessMetadataSource(deps.projectRoot, sourcePath);
    if ('ignored' in resolved) {
      ignoredArtifactRegistrations.push(resolved.ignored);
      continue;
    }
    artifactBatch.push({ type: artDef.type, description: artDef.description, retain: artDef.retain, sourceFile: resolved.sourceFile });
  }

  for (const attDef of execResult.attachments ?? []) {
    const sourcePath = attDef.sourceFile ?? attDef.path ?? '';
    const resolved = resolveRegisterableProcessMetadataSource(deps.projectRoot, sourcePath);
    if ('ignored' in resolved) {
      ignoredAttachmentRegistrations.push(resolved.ignored);
      continue;
    }
    attachmentBatch.push({ mime: attDef.mime, title: attDef.title, description: attDef.description, sourceFile: resolved.sourceFile });
  }

  if (deps.registerEvidenceBatch && (artifactBatch.length > 0 || attachmentBatch.length > 0)) {
    try {
      const batchResult = deps.registerEvidenceBatch({ artifacts: artifactBatch, attachments: attachmentBatch });
      for (const errorMessage of batchResult?.artifactRegistrationErrors ?? []) {
        artifactRegistrationErrors.push(errorMessage);
        deps.onRegistrationError({ phase: 'artifact_registration', error: new Error(errorMessage), errorMessage });
      }
      for (const errorMessage of batchResult?.attachmentRegistrationErrors ?? []) {
        attachmentRegistrationErrors.push(errorMessage);
        deps.onRegistrationError({ phase: 'attachment_registration', error: new Error(errorMessage), errorMessage });
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (artifactBatch.length > 0) {
        artifactRegistrationErrors.push(errorMessage);
        deps.onRegistrationError({ phase: 'artifact_registration', error: err, errorMessage });
      }
      if (attachmentBatch.length > 0) {
        attachmentRegistrationErrors.push(errorMessage);
        deps.onRegistrationError({ phase: 'attachment_registration', error: err, errorMessage });
      }
    }
  } else {
    for (const artifact of artifactBatch) {
      try {
        deps.registerArtifact(artifact);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        artifactRegistrationErrors.push(errorMessage);
        deps.onRegistrationError({ phase: 'artifact_registration', error: err, errorMessage });
      }
    }
    for (const attachment of attachmentBatch) {
      try {
        deps.registerAttachment(attachment);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        attachmentRegistrationErrors.push(errorMessage);
        deps.onRegistrationError({ phase: 'attachment_registration', error: err, errorMessage });
      }
    }
  }

  return { artifactRegistrationErrors, attachmentRegistrationErrors, ignoredArtifactRegistrations, ignoredAttachmentRegistrations };
}

export function buildIgnoredExecutorEvidencePatch(input: {
  existingLifecycle: CardLifecycleState;
  ignoredArtifactRegistrations: string[];
  ignoredAttachmentRegistrations: string[];
}): Partial<CardRecord> | null {
  if (input.ignoredArtifactRegistrations.length === 0 && input.ignoredAttachmentRegistrations.length === 0) return null;
  if (input.existingLifecycle.status !== 'active' && input.existingLifecycle.status !== 'running' && input.existingLifecycle.status !== 'changed') return null;
  return {
    lifecycle: { ...input.existingLifecycle, result: { ...(input.existingLifecycle.result ?? {}), evidence_registration_ignored: { artifacts: input.ignoredArtifactRegistrations, attachments: input.ignoredAttachmentRegistrations } } as CardLifecycleState['result'] },
  };
}

function resultGeneratedFiles(execResult: ExecutorResult): string[] {
  const result = execResult.result;
  if (!result || typeof result !== 'object') return [];
  const generatedFiles = (result as Record<string, unknown>).generated_files;
  if (!Array.isArray(generatedFiles)) return [];
  return generatedFiles.filter((file): file is string => typeof file === 'string');
}

export function validateExecutorGeneratedFiles(projectRoot: string, execResult: ExecutorResult): string[] {
  return generatedFileValidationErrors(validateGeneratedFiles(projectRoot, resultGeneratedFiles(execResult)));
}

export function summarizeExecutorEvidenceRegistrationFailure(input: {
  execStatus: ExecutorResult['status'];
  artifactRegistrationErrors: string[];
  attachmentRegistrationErrors: string[];
  generatedFileValidationErrors?: string[];
}): { registrationFailed: boolean; registrationError: string | null } {
  const registrationFailed =
    input.execStatus === 'done' &&
    (input.artifactRegistrationErrors.length > 0 ||
      input.attachmentRegistrationErrors.length > 0 ||
      (input.generatedFileValidationErrors?.length ?? 0) > 0);
  return {
    registrationFailed,
    registrationError: registrationFailed
      ? `Completion blocked by evidence registration failure. Artifacts: ${input.artifactRegistrationErrors.join(' | ') || 'none'}. Attachments: ${input.attachmentRegistrationErrors.join(' | ') || 'none'}. Generated files: ${input.generatedFileValidationErrors?.join(' | ') || 'none'}.`
      : null,
  };
}
