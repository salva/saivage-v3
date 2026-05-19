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

const uiFinding = `# UI-999 Synthetic UI finding

Status: fixed

## Evidence

Synthetic evidence.

## Resolution

Fixed in synthetic commit.
`;

function writeGoodDossiers(root: string): void {
  writeDossier(
    root,
    'audit-findings',
    { 'FIND-999-synthetic.md': auditFinding },
    '# Audit findings\n\n## Remediation log\n\n- FIND-999 fixed in `abc123`: synthetic fix.\n',
  );
  writeDossier(
    root,
    'ui-findings',
    { 'UI-999-synthetic.md': uiFinding },
    '# UI findings\n\n## Remediation log\n\n- UI-999 fixed in `abc123`: synthetic fix.\n',
  );
}

describe('finding dossier consistency guard', () => {
  it('passes for known-good synthetic audit and UI dossiers', () => {
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
        '# Audit findings\n\n## Remediation log\n\n- FIND-999 fixed in `abc123`: synthetic fix.\n',
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
        '# Audit findings\n\n## Remediation log\n\n- FIND-999 fixed in `abc123`: synthetic fix.\n',
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
        '# UI findings\n\n## Remediation log\n\n- UI-999 fixed in `abc123`: synthetic fix.\n',
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
});
