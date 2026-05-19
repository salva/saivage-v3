import { describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyValidationCadence } from '../../scripts/check-validation-cadence.js';

function withFixture(files, testFn) {
  const root = mkdtempSync(join(tmpdir(), 'saivage-validation-cadence-'));
  try {
    for (const [relativePath, content] of Object.entries(files)) {
      const fullPath = join(root, relativePath);
      mkdirSync(join(fullPath, '..'), { recursive: true });
      writeFileSync(fullPath, content);
    }
    testFn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const PACKAGE_JSON = JSON.stringify({
  scripts: {
    'docs:verify': 'bash scripts/docs-verify.sh',
    'docs:build': 'vitepress build docs',
    typecheck: 'tsc --noEmit',
    build: 'tsc',
    test: 'jest',
  },
});

const VALID_DOCS_VERIFY = `#!/usr/bin/env bash
set -euo pipefail
npm run docs:build
node scripts/check-existing.js
NODE_OPTIONS=--experimental-vm-modules npx jest tests/existing.test.js --runInBand --forceExit || ALL_OK=false
`;

describe('validation cadence guard', () => {
  it('passes when documented validation commands and docs:verify sub-guards resolve', () => {
    withFixture({
      'package.json': PACKAGE_JSON,
      'README.md': '```bash\nnpm run docs:verify\nnpm run typecheck\nnpm run build\nnpm test\n```\n',
      'docs/runbook/release.md': '```bash\nnpm run docs:build\n```\n',
      'docs/runbook/index.md': 'No validation commands here.\n',
      'scripts/docs-verify.sh': VALID_DOCS_VERIFY,
      'scripts/check-existing.js': '#!/usr/bin/env node\n',
      'tests/existing.test.js': 'test("ok", () => {});\n',
    }, (root) => {
      const result = verifyValidationCadence({ root });
      expect(result.ok).toBe(true);
      expect(result.failures).toEqual([]);
      expect(result.documentedCommandsChecked).toContain('README.md: npm run docs:verify');
      expect(result.docsVerifyEntriesChecked).toContain('scripts/docs-verify.sh:4 node-script scripts/check-existing.js');
    });
  });

  it('fails clearly when docs reference a stale npm validation command', () => {
    withFixture({
      'package.json': PACKAGE_JSON,
      'README.md': '```bash\nnpm run docs:stale\n```\n',
      'docs/runbook/release.md': '',
      'docs/runbook/index.md': '',
      'scripts/docs-verify.sh': VALID_DOCS_VERIFY,
      'scripts/check-existing.js': '#!/usr/bin/env node\n',
      'tests/existing.test.js': 'test("ok", () => {});\n',
    }, (root) => {
      const result = verifyValidationCadence({ root });
      expect(result.ok).toBe(false);
      expect(result.failures).toContain('README.md: npm run docs:stale documents npm run docs:stale, but package.json has no "docs:stale" script');
    });
  });

  it('fails clearly when docs:verify invokes a missing sub-guard script', () => {
    const docsVerify = VALID_DOCS_VERIFY.replace('scripts/check-existing.js', 'scripts/check-missing.js');
    withFixture({
      'package.json': PACKAGE_JSON,
      'README.md': '```bash\nnpm run docs:verify\n```\n',
      'docs/runbook/release.md': '',
      'docs/runbook/index.md': '',
      'scripts/docs-verify.sh': docsVerify,
      'tests/existing.test.js': 'test("ok", () => {});\n',
    }, (root) => {
      const result = verifyValidationCadence({ root });
      expect(result.ok).toBe(false);
      expect(result.failures).toContain('scripts/docs-verify.sh:4 invokes scripts/check-missing.js, but that docs:verify sub-guard entry point does not exist');
    });
  });
});
