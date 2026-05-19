import { describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkFindingDossiers } from '../scripts/check-finding-dossiers.js';

function writeDossier(root: string, dossier: 'audit-findings' | 'ui-findings', files: Record<string, string>, readme: string): void {
  const dossierRoot = join(root, dossier);
  mkdirSync(join(dossierRoot, 'findings'), { recursive: true });
  writeFileSync(join(dossierRoot, 'README.md'), readme);
  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(dossierRoot, 'findings', filename), content);
  }
}

function withFixture(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'saivage-finding-dossiers-'));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const auditFinding = `# FIND-999 Synthetic audit finding

Status: fixed

## Evidence

Synthetic evidence.

## Resolution

Fixed in synthetic commit.
`;

const auditFindingWithRegressionGuard = `${auditFinding}
## Regression guard

A focused synthetic regression guard keeps this behavior covered.
`;

const uiFinding = `# UI-999 Synthetic UI finding

Status: fixed

## Evidence

Synthetic evidence.

## Resolution

Fixed in synthetic commit.
`;

const uiFindingWithRegressionGuard = `${uiFinding}
## Regression guard

A focused synthetic regression guard keeps this UI behavior covered.
`;

const auditReadme = '# Audit findings\n\n## Remediation log\n\n- FIND-999 fixed in `abc123`: synthetic fix.\n';
const auditReadmeWithRegressionGuard = `${auditReadme}- FIND-999 regression guard strengthened in \`def456\`: synthetic guard.\n`;
const uiReadme = '# UI findings\n\n## Remediation log\n\n- UI-999 fixed in `abc123`: synthetic fix.\n';
const uiReadmeWithRegressionGuard = `${uiReadme}- UI-999 regression guard strengthened in \`def456\`: synthetic guard.\n`;

function writeGoodDossiers(root: string): void {
  writeDossier(root, 'audit-findings', { 'FIND-999-synthetic.md': auditFinding }, auditReadme);
  writeDossier(root, 'ui-findings', { 'UI-999-synthetic.md': uiFinding }, uiReadme);
}

describe('finding dossier consistency guard', () => {
  it('passes for known-good synthetic audit and UI dossiers with fixed Resolution sections', () => {
    withFixture((root) => {
      writeGoodDossiers(root);

      const result = checkFindingDossiers({ root });

      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.checkedFiles).toBe(2);
      expect(result.fixedFindingIds).toEqual(['FIND-999', 'UI-999']);
    });
  });

  it('fails when a finding is missing a canonical Status line', () => {
    withFixture((root) => {
      writeGoodDossiers(root);
      writeDossier(
        root,
        'audit-findings',
        { 'FIND-999-synthetic.md': auditFinding.replace('Status: fixed', 'Status - fixed') },
        auditReadme,
      );

      const result = checkFindingDossiers({ root });

      expect(result.ok).toBe(false);
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'missing-status', file: expect.stringContaining('FIND-999-synthetic.md') }),
        expect.objectContaining({ kind: 'non-canonical-status', file: expect.stringContaining('FIND-999-synthetic.md') }),
      ]));
    });
  });

  it('fails when a finding has duplicate canonical Status lines', () => {
    withFixture((root) => {
      writeGoodDossiers(root);
      writeDossier(
        root,
        'audit-findings',
        { 'FIND-999-synthetic.md': auditFinding.replace('Status: fixed', 'Status: fixed\nStatus: open') },
        auditReadme,
      );

      const result = checkFindingDossiers({ root });

      expect(result.ok).toBe(false);
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'duplicate-status', file: expect.stringContaining('FIND-999-synthetic.md') }),
      ]));
    });
  });

  it('fails when a fixed finding lacks a Resolution section', () => {
    withFixture((root) => {
      writeGoodDossiers(root);
      writeDossier(
        root,
        'ui-findings',
        { 'UI-999-synthetic.md': uiFinding.replace('\n## Resolution\n\nFixed in synthetic commit.\n', '') },
        uiReadme,
      );

      const result = checkFindingDossiers({ root });

      expect(result.ok).toBe(false);
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'missing-resolution', file: expect.stringContaining('UI-999-synthetic.md') }),
      ]));
    });
  });

  it('fails when a fixed finding is absent from the matching README remediation log', () => {
    withFixture((root) => {
      writeGoodDossiers(root);
      writeDossier(
        root,
        'ui-findings',
        { 'UI-999-synthetic.md': uiFinding },
        '# UI findings\n\n## Remediation log\n\n- UI-998 fixed in `abc123`: wrong finding.\n',
      );

      const result = checkFindingDossiers({ root });

      expect(result.ok).toBe(false);
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'missing-remediation-log-entry', file: expect.stringContaining('ui-findings/README.md') }),
      ]));
    });
  });

  it('passes when audit and UI fixed findings have matching Regression guard notes and README remediation-log entries', () => {
    withFixture((root) => {
      writeDossier(root, 'audit-findings', { 'FIND-999-synthetic.md': auditFindingWithRegressionGuard }, auditReadmeWithRegressionGuard);
      writeDossier(root, 'ui-findings', { 'UI-999-synthetic.md': uiFindingWithRegressionGuard }, uiReadmeWithRegressionGuard);

      const result = checkFindingDossiers({ root });

      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
    });
  });

  it('fails when an audit finding has a Regression guard note without a matching README remediation-log entry', () => {
    withFixture((root) => {
      writeDossier(root, 'audit-findings', { 'FIND-999-synthetic.md': auditFindingWithRegressionGuard }, auditReadme);
      writeDossier(root, 'ui-findings', { 'UI-999-synthetic.md': uiFinding }, uiReadme);

      const result = checkFindingDossiers({ root });

      expect(result.ok).toBe(false);
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({
          dossier: 'audit-findings',
          kind: 'missing-regression-guard-log-entry',
          file: expect.stringContaining('audit-findings/README.md'),
        }),
      ]));
    });
  });

  it('fails when a UI finding has a Regression guard note without a matching README remediation-log entry', () => {
    withFixture((root) => {
      writeDossier(root, 'audit-findings', { 'FIND-999-synthetic.md': auditFinding }, auditReadme);
      writeDossier(root, 'ui-findings', { 'UI-999-synthetic.md': uiFindingWithRegressionGuard }, uiReadme);

      const result = checkFindingDossiers({ root });

      expect(result.ok).toBe(false);
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({
          dossier: 'ui-findings',
          kind: 'missing-regression-guard-log-entry',
          file: expect.stringContaining('ui-findings/README.md'),
        }),
      ]));
    });
  });

  it('fails when an audit README has a regression-guard remediation-log entry without a matching finding note', () => {
    withFixture((root) => {
      writeDossier(root, 'audit-findings', { 'FIND-999-synthetic.md': auditFinding }, auditReadmeWithRegressionGuard);
      writeDossier(root, 'ui-findings', { 'UI-999-synthetic.md': uiFinding }, uiReadme);

      const result = checkFindingDossiers({ root });

      expect(result.ok).toBe(false);
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({
          dossier: 'audit-findings',
          kind: 'missing-regression-guard-finding-note',
          file: expect.stringContaining('FIND-999-synthetic.md'),
        }),
      ]));
    });
  });

  it('fails when a UI README has a regression-guard remediation-log entry without a matching finding note', () => {
    withFixture((root) => {
      writeDossier(root, 'audit-findings', { 'FIND-999-synthetic.md': auditFinding }, auditReadme);
      writeDossier(root, 'ui-findings', { 'UI-999-synthetic.md': uiFinding }, uiReadmeWithRegressionGuard);

      const result = checkFindingDossiers({ root });

      expect(result.ok).toBe(false);
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({
          dossier: 'ui-findings',
          kind: 'missing-regression-guard-finding-note',
          file: expect.stringContaining('UI-999-synthetic.md'),
        }),
      ]));
    });
  });
});
