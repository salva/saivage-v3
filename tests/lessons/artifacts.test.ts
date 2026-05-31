import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkLessonArtifacts,
  expectedLessonArtifacts,
  missingRequiredArtifacts,
  validateLessonArtifacts,
} from '../../src/lessons/artifacts.js';

describe('lesson artifact checks', () => {
  it('identifies missing required artifacts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lesson-artifacts-'));
    try {
      const present = join(dir, 'plan.md');
      const missing = join(dir, 'recording.mp4');
      writeFileSync(present, 'plan', 'utf-8');
      const artifacts = [
        { kind: 'plan' as const, path: present, required: true },
        { kind: 'recording' as const, path: missing, required: true },
      ];
      expect(checkLessonArtifacts(artifacts).map((check) => check.nonEmpty)).toEqual([true, false]);
      expect(missingRequiredArtifacts(artifacts).map((check) => check.artifact.kind)).toEqual(['recording']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires only text and metadata artifacts in dry-run mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lesson-dry-run-artifacts-'));
    try {
      expect(expectedLessonArtifacts(dir, 'dry-run').map((artifact) => artifact.kind)).toEqual([
        'plan',
        'script',
        'subtitles',
        'transcript',
        'metadata',
        'implementation-log',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes dry-run validation when partial lesson text artifacts are present and parseable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lesson-dry-run-valid-'));
    try {
      writePartialTextArtifacts(dir);
      const result = await validateLessonArtifacts(dir, 'dry-run');
      expect(result.passed).toBe(true);
      expect(result.issues).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails strict produced-lesson validation clearly for missing media and bootstrap-shaped metadata', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lesson-strict-invalid-'));
    try {
      writePartialTextArtifacts(dir);
      const result = await validateLessonArtifacts(dir, 'strict-produced');
      expect(result.passed).toBe(false);
      expect(result.issues.map((issue) => issue.artifact)).toEqual(
        expect.arrayContaining(['recording', 'narration', 'plan', 'transcript', 'metadata']),
      );
      expect(result.issues.map((issue) => issue.message).join('\n')).toContain('recording is missing');
      expect(result.issues.map((issue) => issue.message).join('\n')).toContain('narration is missing');
      expect(result.issues.map((issue) => issue.message).join('\n')).toContain('word-level array');
      expect(result.issues.map((issue) => issue.message).join('\n')).toContain('duration_s');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function writePartialTextArtifacts(dir: string): void {
  writeFileSync(
    join(dir, 'plan.md'),
    '# Lesson plan\n\n- Audience: beginner\n- Learning goal: orient to the workspace\n- Prerequisite UI state: app loaded\n',
    'utf-8',
  );
  writeFileSync(join(dir, 'script.md'), '# Script\n\n## scene-1\n\nNarration text.\n', 'utf-8');
  writeFileSync(join(dir, 'subtitles.srt'), '1\n00:00:00,000 --> 00:00:03,000\nNarration text.\n', 'utf-8');
  writeFileSync(
    join(dir, 'transcript.json'),
    `${JSON.stringify({ lessonId: '001', cues: [{ id: 'scene-1', startSeconds: 0, endSeconds: 3 }] }, null, 2)}\n`,
    'utf-8',
  );
  writeFileSync(join(dir, 'metadata.json'), `${JSON.stringify({ slug: 'partial', status: 'blocked' }, null, 2)}\n`, 'utf-8');
  writeFileSync(join(dir, 'implementation-log.md'), 'Partial lesson blocked by external media tools.\n', 'utf-8');
}
