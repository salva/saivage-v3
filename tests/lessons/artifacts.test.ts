import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkLessonArtifacts, missingRequiredArtifacts } from '../../src/lessons/artifacts.js';

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
});
