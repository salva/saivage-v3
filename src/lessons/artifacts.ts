import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseSrtBlocks } from './srt.js';
import type { LessonArtifact, LessonArtifactKind } from './types.js';

export interface ArtifactCheck {
  artifact: LessonArtifact;
  exists: boolean;
  nonEmpty: boolean;
  message: string;
}

export type LessonArtifactValidationMode = 'dry-run' | 'strict-produced';

export interface LessonArtifactValidationIssue {
  artifact: LessonArtifactKind;
  path: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface LessonArtifactValidationResult {
  mode: LessonArtifactValidationMode;
  passed: boolean;
  checks: ArtifactCheck[];
  issues: LessonArtifactValidationIssue[];
}

const DRY_RUN_REQUIRED_ARTIFACTS: LessonArtifactKind[] = [
  'plan',
  'script',
  'subtitles',
  'transcript',
  'metadata',
  'implementation-log',
];

const STRICT_REQUIRED_ARTIFACTS: LessonArtifactKind[] = [...DRY_RUN_REQUIRED_ARTIFACTS, 'recording', 'narration'];

const ARTIFACT_FILENAMES: Record<LessonArtifactKind, string> = {
  plan: 'plan.md',
  script: 'script.md',
  recording: 'recording.mp4',
  subtitles: 'subtitles.srt',
  narration: 'narration.wav',
  transcript: 'transcript.json',
  metadata: 'metadata.json',
  'implementation-log': 'implementation-log.md',
};

const STRICT_PLAN_FIELDS = ['audience', 'learning_goal', 'prereq_lessons', 'ui_state_setup'];
const STRICT_METADATA_FIELDS = [
  'topic',
  'slug',
  'level',
  'duration_s',
  'diedrico_source_refs',
  'diedrico_commit_sha',
  'spec_refs',
  'lesson_hash',
];

export function expectedLessonArtifacts(lessonDir: string, mode: LessonArtifactValidationMode): LessonArtifact[] {
  const required = mode === 'strict-produced' ? STRICT_REQUIRED_ARTIFACTS : DRY_RUN_REQUIRED_ARTIFACTS;
  return required.map((kind) => ({ kind, path: join(lessonDir, ARTIFACT_FILENAMES[kind]), required: true }));
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

export async function validateLessonArtifacts(
  lessonDir: string,
  mode: LessonArtifactValidationMode,
): Promise<LessonArtifactValidationResult> {
  const artifacts = expectedLessonArtifacts(lessonDir, mode);
  const checks = checkLessonArtifacts(artifacts);
  const issues: LessonArtifactValidationIssue[] = [];

  for (const check of checks) {
    if (check.artifact.required && !check.nonEmpty) {
      issues.push({
        artifact: check.artifact.kind,
        path: check.artifact.path,
        severity: 'error',
        message: check.message,
      });
    }
  }

  if (checks.find((check) => check.artifact.kind === 'subtitles')?.nonEmpty) {
    await validateSubtitles(join(lessonDir, ARTIFACT_FILENAMES.subtitles), issues);
  }
  if (checks.find((check) => check.artifact.kind === 'transcript')?.nonEmpty) {
    await validateTranscript(join(lessonDir, ARTIFACT_FILENAMES.transcript), mode, issues);
  }
  if (checks.find((check) => check.artifact.kind === 'metadata')?.nonEmpty) {
    await validateMetadata(join(lessonDir, ARTIFACT_FILENAMES.metadata), mode, issues);
  }
  if (mode === 'strict-produced' && checks.find((check) => check.artifact.kind === 'plan')?.nonEmpty) {
    await validateStrictPlan(join(lessonDir, ARTIFACT_FILENAMES.plan), issues);
  }

  return { mode, passed: issues.every((issue) => issue.severity !== 'error'), checks, issues };
}

async function validateSubtitles(path: string, issues: LessonArtifactValidationIssue[]): Promise<void> {
  try {
    const cues = parseSrtBlocks(await readFile(path, 'utf-8'));
    if (cues.length === 0) {
      issues.push({ artifact: 'subtitles', path, severity: 'error', message: 'subtitles.srt contains no cues' });
    }
  } catch (error) {
    issues.push({
      artifact: 'subtitles',
      path,
      severity: 'error',
      message: `subtitles.srt is not parseable SRT: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

async function validateTranscript(
  path: string,
  mode: LessonArtifactValidationMode,
  issues: LessonArtifactValidationIssue[],
): Promise<void> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as unknown;
    if (mode === 'strict-produced') {
      const valid = Array.isArray(parsed)
        && parsed.length > 0
        && parsed.every((entry) => {
          if (!entry || typeof entry !== 'object') return false;
          const candidate = entry as Record<string, unknown>;
          return typeof candidate.word === 'string'
            && Number.isFinite(candidate.start_s)
            && Number.isFinite(candidate.end_s)
            && Number(candidate.end_s) > Number(candidate.start_s);
        });
      if (!valid) {
        issues.push({
          artifact: 'transcript',
          path,
          severity: 'error',
          message: 'strict transcript.json must be a non-empty word-level array of {word,start_s,end_s}',
        });
      }
    }
  } catch (error) {
    issues.push({
      artifact: 'transcript',
      path,
      severity: 'error',
      message: `transcript.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

async function validateMetadata(
  path: string,
  mode: LessonArtifactValidationMode,
  issues: LessonArtifactValidationIssue[],
): Promise<void> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      issues.push({ artifact: 'metadata', path, severity: 'error', message: 'metadata.json must be a JSON object' });
      return;
    }
    if (mode === 'strict-produced') {
      const metadata = parsed as Record<string, unknown>;
      for (const field of STRICT_METADATA_FIELDS) {
        if (!(field in metadata)) {
          issues.push({
            artifact: 'metadata',
            path,
            severity: 'error',
            message: `strict metadata.json is missing required field ${field}`,
          });
        }
      }
    }
  } catch (error) {
    issues.push({
      artifact: 'metadata',
      path,
      severity: 'error',
      message: `metadata.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

async function validateStrictPlan(path: string, issues: LessonArtifactValidationIssue[]): Promise<void> {
  const planText = await readFile(path, 'utf-8');
  for (const field of STRICT_PLAN_FIELDS) {
    if (!new RegExp(`\\b${field}\\b`, 'i').test(planText)) {
      issues.push({
        artifact: 'plan',
        path,
        severity: 'error',
        message: `strict plan.md is missing required field declaration ${field}`,
      });
    }
  }
}
