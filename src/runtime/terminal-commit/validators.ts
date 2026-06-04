import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { CardLifecycleState, CardRecord, ReviewAssessment } from '../../schemas/index.js';
import { cardLifecycleStateSchema } from '../../schemas/lifecycle.js';

export interface GeneratedFileValidation {
  valid: string[];
  missing: string[];
  unsafe: string[];
}

export interface EvidenceCompleteness {
  semantically_complete: boolean;
  reasons: string[];
}

export function pathIsInside(parentPath: string, candidatePath: string): boolean {
  const rel = relative(resolve(parentPath), resolve(candidatePath));
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

export function validateGeneratedFiles(projectRoot: string, paths: string[]): GeneratedFileValidation {
  const valid: string[] = [];
  const missing: string[] = [];
  const unsafe: string[] = [];

  for (const filePath of paths) {
    if (!filePath.trim()) {
      unsafe.push(filePath);
      continue;
    }
    const resolved = isAbsolute(filePath) ? resolve(filePath) : resolve(projectRoot, filePath);
    if (!pathIsInside(projectRoot, resolved)) {
      unsafe.push(filePath);
      continue;
    }
    if (!existsSync(resolved)) {
      missing.push(filePath);
      continue;
    }
    valid.push(filePath);
  }

  return { valid, missing, unsafe };
}

export function generatedFileValidationErrors(validation: GeneratedFileValidation): string[] {
  return [
    ...validation.unsafe.map((filePath) => filePath.trim()
      ? `Generated file claim points outside project root: '${filePath}'.`
      : 'Generated file claim is empty.'),
    ...validation.missing.map((filePath) => `Generated file claim does not exist: '${filePath}'.`),
  ];
}

export function validateTerminalOverlay(_previousCard: CardRecord, nextLifecycle: CardLifecycleState): string[] {
  const diagnostics: string[] = [];
  const parsed = cardLifecycleStateSchema.safeParse(nextLifecycle);
  if (!parsed.success) diagnostics.push(`Invalid lifecycle state: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);

  if (nextLifecycle.status === 'done') {
    if (nextLifecycle.error !== null) diagnostics.push("Done lifecycle must clear error.");
    if (nextLifecycle.completed_at === null) diagnostics.push("Done lifecycle requires completed_at.");
    switch (nextLifecycle.result.kind) {
      case 'executor_success':
      case 'planner_done':
      case 'reviewer_pass':
        break;
    }
  }
  if (nextLifecycle.status === 'failed' && (!nextLifecycle.error || nextLifecycle.completed_at === null)) {
    diagnostics.push('Failed lifecycle requires non-empty error and completed_at.');
  }
  if (nextLifecycle.status === 'blocked' && (!nextLifecycle.error || nextLifecycle.completed_at !== null)) {
    diagnostics.push('Blocked lifecycle requires non-empty error and completed_at:null.');
  }
  if (nextLifecycle.status === 'needs_verification') {
    if (nextLifecycle.error !== null) diagnostics.push('Needs-verification lifecycle must clear error.');
    if (nextLifecycle.completed_at !== null) diagnostics.push('Needs-verification lifecycle must keep completed_at:null.');
  }

  return diagnostics;
}

export function validateEvidenceCompleteness(input: {
  card: CardRecord;
  readCard(id: string): CardRecord | null | undefined;
  evidenceCardIds?: string[];
  assessment?: Pick<ReviewAssessment, 'evidence_card_ids'>;
}): EvidenceCompleteness {
  const evidenceIds = input.evidenceCardIds ?? input.assessment?.evidence_card_ids ?? evidenceIdsFromResult(input.card.lifecycle.result);
  const reasons: string[] = [];
  if (evidenceIds.length === 0) reasons.push('Reviewer assessment must cite at least one evidence_card_id.');

  for (const evidenceId of evidenceIds) {
    const evidenceCard = input.readCard(evidenceId);
    if (!evidenceCard) {
      reasons.push(`Reviewer cited missing evidence card '${evidenceId}'.`);
      continue;
    }
    if (evidenceId !== input.card.id && evidenceCard.status !== 'done') {
      reasons.push(`Reviewer cited non-complete evidence card '${evidenceId}' with status '${evidenceCard.status}'.`);
    }
    if ((evidenceCard.artifacts?.length ?? 0) === 0 && (evidenceCard.attachments?.length ?? 0) === 0 && !evidenceCard.lifecycle.result) {
      reasons.push(`Reviewer cited card '${evidenceId}' without durable result, artifact, or attachment evidence.`);
    }
  }

  return { semantically_complete: reasons.length === 0, reasons };
}

function evidenceIdsFromResult(result: CardLifecycleState['result']): string[] {
  if (result?.kind === 'executor_success') return result.generated_files;
  return [];
}
