import { describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIgnoredExecutorEvidencePatch, registerExecutorEvidence, resolveRegisterableProcessMetadataSource, summarizeExecutorEvidenceRegistrationFailure, validateExecutorGeneratedFiles } from '../../src/runtime/phases/executor-evidence.js';
import type { ExecutorResult } from '../../src/contracts/index.js';

describe('executor evidence registration', () => {
  it('ignores project-file evidence paths', () => {
    expect(resolveRegisterableProcessMetadataSource('/project', 'src/app.ts')).toEqual({
      ignored: "Project files are not registered as artifacts or attachments: 'src/app.ts'. Record project changes in result/status_text; register only Saivage process metadata under .saivage-work.",
    });
  });

  it('records registration errors and ignored entries separately', () => {
    const errors: Array<{ phase: string; errorMessage: string }> = [];
    const result = registerExecutorEvidence(
      {
        projectRoot: '/project',
        registerArtifact: () => {
          throw new Error('artifact failed');
        },
        registerAttachment: () => undefined,
        onRegistrationError: (input) => errors.push({ phase: input.phase, errorMessage: input.errorMessage }),
      },
      {
        status: 'done',
        status_text: 'Done',
        artifacts: [{ type: 'log', description: 'log', retain: false, sourceFile: '.saivage-work/run/log.txt' }],
        attachments: [{ mime: 'text/plain', title: 'source', sourceFile: 'README.md' }],
      } as ExecutorResult,
    );

    expect(result.artifactRegistrationErrors).toEqual(['artifact failed']);
    expect(result.attachmentRegistrationErrors).toEqual([]);
    expect(result.ignoredAttachmentRegistrations).toHaveLength(1);
    expect(errors).toEqual([{ phase: 'artifact_registration', errorMessage: 'artifact failed' }]);
  });

  it('fails registration when an executor reports a process directory instead of a log file', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-process-dir-evidence-'));
    try {
      mkdirSync(join(projectRoot, '.saivage-work', 'processes', 'proc-abc123'), { recursive: true });
      const errors: Array<{ phase: string; errorMessage: string }> = [];

      const result = registerExecutorEvidence(
        {
          projectRoot,
          registerArtifact: () => undefined,
          registerAttachment: () => undefined,
          onRegistrationError: (input) => errors.push({ phase: input.phase, errorMessage: input.errorMessage }),
        },
        {
          status: 'done',
          status_text: 'Done',
          artifacts: [{ type: 'log', description: 'process output', retain: false, sourceFile: '.saivage-work/processes/proc-abc123' }],
          attachments: [],
        } as unknown as ExecutorResult,
      );

      expect(result.artifactRegistrationErrors).toEqual([
        'Evidence source path must be a file, not a directory: .saivage-work/processes/proc-abc123',
      ]);
      expect(errors).toEqual([{ phase: 'artifact_registration', errorMessage: result.artifactRegistrationErrors[0] }]);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('batches registerable artifacts and attachments when batch registrar is available', () => {
    const batches: unknown[] = [];
    const result = registerExecutorEvidence(
      {
        projectRoot: '/project',
        registerArtifact: () => {
          throw new Error('single artifact path should not be used');
        },
        registerAttachment: () => {
          throw new Error('single attachment path should not be used');
        },
        registerEvidenceBatch: (input) => {
          batches.push(input);
        },
        onRegistrationError: () => undefined,
      },
      {
        status: 'done',
        status_text: 'Done',
        artifacts: [
          { type: 'log', description: 'one', retain: false, sourceFile: '.saivage-work/run/one.log' },
          { type: 'data', description: 'two', retain: true, sourceFile: '.saivage-work/run/two.json' },
        ],
        attachments: [{ mime: 'text/plain', title: 'note', sourceFile: '.saivage-work/run/note.txt' }],
      } as ExecutorResult,
    );

    expect(result.artifactRegistrationErrors).toEqual([]);
    expect(result.attachmentRegistrationErrors).toEqual([]);
    expect(batches).toEqual([
      {
        artifacts: [
          { type: 'log', description: 'one', retain: false, sourceFile: '/project/.saivage-work/run/one.log' },
          { type: 'data', description: 'two', retain: true, sourceFile: '/project/.saivage-work/run/two.json' },
        ],
        attachments: [{ mime: 'text/plain', title: 'note', description: undefined, sourceFile: '/project/.saivage-work/run/note.txt' }],
      },
    ]);
  });

  it('builds card result patches for ignored evidence registrations only when needed', () => {
    expect(buildIgnoredExecutorEvidencePatch({
      existingLifecycle: { status: 'running', result: null, error: null, completed_at: null },
      ignoredArtifactRegistrations: ['artifact ignored'],
      ignoredAttachmentRegistrations: ['attachment ignored'],
    })).toEqual({
      lifecycle: {
        status: 'running',
        error: null,
        completed_at: null,
        result: {
        evidence_registration_ignored: {
          artifacts: ['artifact ignored'],
          attachments: ['attachment ignored'],
        },
      },
      },
    });
    expect(buildIgnoredExecutorEvidencePatch({ existingLifecycle: { status: 'running', result: null, error: null, completed_at: null }, ignoredArtifactRegistrations: [], ignoredAttachmentRegistrations: [] })).toBeNull();
  });

  it('summarizes registration failure only for otherwise done executor results', () => {
    expect(summarizeExecutorEvidenceRegistrationFailure({ execStatus: 'done', artifactRegistrationErrors: ['artifact failed'], attachmentRegistrationErrors: [] })).toEqual({
      registrationFailed: true,
      registrationError: 'Completion blocked by evidence registration failure. Artifacts: artifact failed. Attachments: none. Generated files: none.',
    });
    expect(summarizeExecutorEvidenceRegistrationFailure({ execStatus: 'failed', artifactRegistrationErrors: ['artifact failed'], attachmentRegistrationErrors: [] })).toEqual({ registrationFailed: false, registrationError: null });
  });

  it('validates generated project file claims before done completion', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-generated-files-'));
    try {
      writeFileSync(join(projectRoot, 'present.txt'), 'ok\n', 'utf8');
      expect(validateExecutorGeneratedFiles(projectRoot, {
        card_id: 'code-a',
        status: 'done',
        status_text: 'Done',
        artifacts: [],
        attachments: [],
        fallback_with_evidence: null,
        result: { generated_files: ['present.txt'] },
      } as unknown as ExecutorResult)).toEqual([]);
      const errors = validateExecutorGeneratedFiles(projectRoot, {
        card_id: 'code-a',
        status: 'done',
        status_text: 'Done',
        artifacts: [],
        attachments: [],
        fallback_with_evidence: null,
        result: { generated_files: ['missing.txt', '../outside.txt'] },
      } as unknown as ExecutorResult);
      expect(errors).toEqual(expect.arrayContaining([
        "Generated file claim does not exist: 'missing.txt'.",
        "Generated file claim points outside project root: '../outside.txt'.",
      ]));
      expect(summarizeExecutorEvidenceRegistrationFailure({
        execStatus: 'done',
        artifactRegistrationErrors: [],
        attachmentRegistrationErrors: [],
        generatedFileValidationErrors: errors,
      }).registrationFailed).toBe(true);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
