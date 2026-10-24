import { expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectQualityScope } from '../../src/quality/scope.js';
import { renderQualityReport } from '../../src/quality/report.js';
import { resolveOperationReadablePath } from '../../src/runtime/operation-execution.js';

it('selects only admitted exact source, accounts for exclusions and refuses resolved private aliases', () => {
  const root = mkdtempSync(join(tmpdir(), 'quality-scope-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 1;');
    writeFileSync(join(root, 'src/skip.ts'), 'excluded');
    mkdirSync(join(root, '.saivage/cards'), { recursive: true });
    symlinkSync(join(root, '.saivage/cards'), join(root, 'private-alias'));
    const args = { root, sourcePaths: ['src'], exclusions: ['src/skip.ts'], language: 'typescript' as const,
      resolveReadablePath: (path: string) => resolveOperationReadablePath(root, path) };
    const scope = selectQualityScope(args);
    expect(scope.files).toEqual([join(root, 'src/a.ts')]);
    expect(scope.skipped).toEqual([{ path: 'src/skip.ts', reason: 'excluded' }]);
    expect(() => selectQualityScope({ ...args, sourcePaths: ['private-alias'] })).toThrow(/allowed project source/);
    expect(() => selectQualityScope({ ...args, sourcePaths: ['.saivage/cards'] })).toThrow(/private/);
    expect(selectQualityScope({ ...args, sourcePaths: ['missing.ts'] }).skipped).toEqual([{ path: 'missing.ts', reason: 'unmatched' }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('bounds only the report, discloses omitted findings and keeps native/normalized links and nonverdict', () => {
  const findings = Array.from({ length: 1000 }, () => ({ file: 'a.ts', rule: 'typed/no-floating-promises',
    severity: 'error' as const, start: { line: 1, column: 1 }, end: null, message: 'A diagnostic '.repeat(30) }));
  const syntheticSecret = 'synthetic-quality-canary'.repeat(1500);
  findings[0]!.message = `Authorization: Bearer ${syntheticSecret}`;
  const content = renderQualityReport({ operation: 'code-quality.typescript.eslint', invocation: 'invocation', outcome: 'findings',
    artifactRoot: '.saivage/work/quality/invocation', files: ['a.ts'], skipped: [], result: {
      invocation: '11111111-1111-4111-8111-111111111111', outcome: 'findings', native_exit: 1, tool_versions: {},
      diagnostic: 'Authorization: Bearer synthetic-diagnostic-canary', native: [], findings, coverage: [], limitations: ['Fixture only.'],
      git: { head: null, status: null, applicability: 'unknown', diagnostic: null },
    } });
  expect(Buffer.byteLength(content)).toBeLessThan(48000);
  expect(content).toMatch(/omitted findings:[1-9]/);
  // The first raw finding alone exceeds the row budget, but its redacted form
  // fits. A cap-before-redaction implementation would show zero findings.
  expect(content).toMatch(/Shown findings:[1-9]/);
  expect(content).not.toContain('synthetic-quality-canary');
  expect(content).not.toContain('synthetic-diagnostic-canary');
  expect(content).toContain('[REDACTED]');
  expect(findings[0]!.message).toContain(syntheticSecret);
  expect(content).toContain('/native.json');
  expect(content).toContain('/findings.json');
  expect(content).toContain('not product acceptance');
  expect(findings).toHaveLength(1000);
});
