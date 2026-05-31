import { existsSync, statSync } from 'node:fs';
import type { LessonArtifact } from './types.js';

export interface ArtifactCheck {
  artifact: LessonArtifact;
  exists: boolean;
  nonEmpty: boolean;
  message: string;
}

export function checkLessonArtifacts(artifacts: LessonArtifact[]): ArtifactCheck[] {
  return artifacts.map((artifact) => {
    if (!existsSync(artifact.path)) {
      return {
        artifact,
        exists: false,
        nonEmpty: false,
        message: `${artifact.kind} is missing at ${artifact.path}`,
      };
    }
    const stats = statSync(artifact.path);
    const nonEmpty = stats.isFile() && stats.size > 0;
    return {
      artifact,
      exists: true,
      nonEmpty,
      message: nonEmpty ? `${artifact.kind} exists and is non-empty` : `${artifact.kind} exists but is empty`,
    };
  });
}

export function missingRequiredArtifacts(artifacts: LessonArtifact[]): ArtifactCheck[] {
  return checkLessonArtifacts(artifacts).filter((check) => check.artifact.required && !check.nonEmpty);
}
