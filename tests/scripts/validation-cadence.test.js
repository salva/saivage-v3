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

const PACKAGE_SCRIPTS = {
  'docs:verify': 'bash scripts/docs-verify.sh',
  'docs:build': 'vitepress build docs',
  typecheck: 'tsc --noEmit',
  build: 'tsc',
  test: 'jest',
  'web:typecheck': 'cd web && npm run typecheck',
  'web:test:sweep': 'npm run web:test:control-room && npm run web:test:stores',
  'web:test:operator-smoke': 'cd web && npx vitest run src/__tests__/operator-dashboard-smoke.test.ts',
  'validate:docs': 'npm run docs:verify',
  'validate:routine': 'npm run typecheck && npm run docs:verify',
  'validate:ui-smoke': 'npm run web:test:operator-smoke',
  'validate:ui': 'npm run web:typecheck && npm run web:test:sweep && npm run web:test:operator-smoke',
  'validate:release': 'npm run typecheck && npm run build && npm test && npm run web:test:operator-smoke && npm run docs:verify',
};

const PACKAGE_JSON = JSON.stringify({ scripts: PACKAGE_SCRIPTS });

const VALID_PROFILE_DOCS = '```bash\nnpm run validate:docs\nnpm run validate:routine\nnpm run validate:ui-smoke\nnpm run validate:ui\nnpm run validate:release\n```\n`npm run validate:docs` intentionally runs docs verification only and does not run `npm test` or the Vitest smoke guard.\n';

const VALID_DOCS_VERIFY = `#!/usr/bin/env bash
set -euo pipefail
npm run docs:build
node scripts/check-existing.js
NODE_OPTIONS=--experimental-vm-modules npx jest tests/existing.test.js --runInBand --forceExit || ALL_OK=false
`;

const VALID_WORKFLOW = `name: Validation profiles
on:
  pull_request:
  workflow_dispatch:
    inputs:
      run_ui_smoke:
        default: 'false'
      run_release_profile:
        default: 'false'
permissions:
  contents: read
concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  validation:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run validate:routine
      - run: npm run validate:docs
      - name: UI smoke validation profile (manual)
        if: inputs.run_ui_smoke == 'true'
        run: npm run validate:ui-smoke
      - name: Release validation profile (manual heavy gate)
        if: inputs.run_release_profile == 'true'
        run: npm run validate:release
`;

function validFiles(overrides = {}) {
  return {
    'package.json': PACKAGE_JSON,
    'README.md': '```bash\nnpm run docs:verify\nnpm run typecheck\nnpm run build\nnpm test\nnpm run web:test:operator-smoke\n```\n' + VALID_PROFILE_DOCS,
    'docs/runbook/release.md': '```bash\nnpm run docs:build\n```\n' + VALID_PROFILE_DOCS,
    'docs/runbook/index.md': 'No extra validation commands here.\n',
    '.github/workflows/validation.yml': VALID_WORKFLOW,
    'scripts/docs-verify.sh': VALID_DOCS_VERIFY,
    'scripts/check-existing.js': '#!/usr/bin/env node\n',
    'tests/existing.test.js': 'test("ok", () => {});\n',
    ...overrides,
  };
}

describe('validation cadence guard', () => {
  it('passes when documented validation commands, workflow commands, and docs:verify sub-guards resolve', () => {
    withFixture(validFiles(), (root) => {
      const result = verifyValidationCadence({ root });
      expect(result.ok).toBe(true);
      expect(result.failures).toEqual([]);
      expect(result.documentedCommandsChecked).toContain('README.md: npm run docs:verify');
      expect(result.workflowCommandsChecked).toContain('.github/workflows/validation.yml:25: npm run validate:routine');
      expect(result.workflowFilesChecked).toContain('.github/workflows/validation.yml');
      expect(result.requiredValidationScriptsChecked).toContain('package.json script web:test:operator-smoke');
      expect(result.validationProfilesChecked).toContain('package.json profile validate:release');
      expect(result.docsVerifyEntriesChecked).toContain('scripts/docs-verify.sh:4 node-script scripts/check-existing.js');
    });
  });



  it('fails clearly when a workflow omits least-privilege permissions', () => {
    const workflowWithoutPermissions = VALID_WORKFLOW.replace("permissions:\n  contents: read\n", '');
    withFixture(validFiles({ '.github/workflows/validation.yml': workflowWithoutPermissions }), (root) => {
      const result = verifyValidationCadence({ root });
      expect(result.ok).toBe(false);
      expect(result.failures).toContain('.github/workflows/validation.yml must declare top-level least-privilege permissions with contents: read');
    });
  });

  it('fails clearly when a workflow requests broad permissions', () => {
    const workflowWithBroadPermissions = VALID_WORKFLOW.replace("permissions:\n  contents: read", 'permissions: write-all');
    withFixture(validFiles({ '.github/workflows/validation.yml': workflowWithBroadPermissions }), (root) => {
      const result = verifyValidationCadence({ root });
      expect(result.ok).toBe(false);
      expect(result.failures).toContain('.github/workflows/validation.yml:10 must not use broad workflow permissions; use least-privilege contents: read');
    });
  });

  it('fails clearly when a workflow omits Node 22 setup', () => {
    const workflowWithoutNode22 = VALID_WORKFLOW.replace('          node-version: 22', '          node-version: 20');
    withFixture(validFiles({ '.github/workflows/validation.yml': workflowWithoutNode22 }), (root) => {
      const result = verifyValidationCadence({ root });
      expect(result.ok).toBe(false);
      expect(result.failures).toContain('.github/workflows/validation.yml must use actions/setup-node@v4 with node-version: 22');
    });
  });

  it('fails clearly when a workflow omits npm ci', () => {
    const workflowWithoutNpmCi = VALID_WORKFLOW.replace('      - run: npm ci\n', '');
    withFixture(validFiles({ '.github/workflows/validation.yml': workflowWithoutNpmCi }), (root) => {
      const result = verifyValidationCadence({ root });
      expect(result.ok).toBe(false);
      expect(result.failures).toContain('.github/workflows/validation.yml must install dependencies with npm ci before validation profiles');
    });
  });

  it('fails clearly when a workflow runs npm ci after validation profiles', () => {
    const workflowWithLateNpmCi = VALID_WORKFLOW.replace('      - run: npm ci\n      - run: npm run validate:routine\n', '      - run: npm run validate:routine\n      - run: npm ci\n');
    withFixture(validFiles({ '.github/workflows/validation.yml': workflowWithLateNpmCi }), (root) => {
      const result = verifyValidationCadence({ root });
      expect(result.ok).toBe(false);
      expect(result.failures).toContain('.github/workflows/validation.yml:25 npm ci must run before validation profiles');
    });
  });

  it('fails clearly when a workflow omits concurrency cancellation', () => {
    const workflowWithoutConcurrency = VALID_WORKFLOW.replace("concurrency:\n  group: \${{ github.workflow }}-\${{ github.ref }}\n  cancel-in-progress: true\n", '');
    withFixture(validFiles({ '.github/workflows/validation.yml': workflowWithoutConcurrency }), (root) => {
      const result = verifyValidationCadence({ root });
      expect(result.ok).toBe(false);
      expect(result.failures).toContain('.github/workflows/validation.yml must declare top-level concurrency with a group and cancel-in-progress: true');
    });
  });

  it('fails clearly when a workflow references secrets or token echo patterns', () => {
    const workflowWithSecrets = VALID_WORKFLOW.replace('      - run: npm ci', "      - run: echo ${{ secrets.SAIVAGE_API_TOKEN }}\n      - run: npm ci");
    withFixture(validFiles({ '.github/workflows/validation.yml': workflowWithSecrets }), (root) => {
      const result = verifyValidationCadence({ root });
      expect(result.ok).toBe(false);
      expect(result.failures).toContain('.github/workflows/validation.yml:24 must not reference GitHub secrets in validation workflow');
      expect(result.failures).toContain('.github/workflows/validation.yml:24 must not set or reference SAIVAGE_API_TOKEN in validation workflow');
      expect(result.failures).toContain('.github/workflows/validation.yml:24 must not echo secret or token values in validation workflow');
    });
  });

  it('fails clearly when a workflow assigns token-like environment variables', () => {
    const workflowWithTokenEnv = VALID_WORKFLOW.replace('      - run: npm ci', "      - run: npm ci\n        env:\n          API_KEY: synthetic");
    withFixture(validFiles({ '.github/workflows/validation.yml': workflowWithTokenEnv }), (root) => {
      const result = verifyValidationCadence({ root });
      expect(result.ok).toBe(false);
      expect(result.failures).toContain('.github/workflows/validation.yml:26 must not assign API key/token/password environment variables in validation workflow');
    });
  });

  it('fails clearly when docs reference a stale npm validation command', () => {
    withFixture(validFiles({
      'README.md': '```bash\nnpm run docs:stale\nnpm run web:test:operator-smoke\n```\n' + VALID_PROFILE_DOCS,
      'docs/runbook/release.md': '',
      'docs/runbook/index.md': '',
    }), (root) => {
      const result = verifyValidationCadence({ root });
      expect(result.ok).toBe(false);
      expect(result.failures).toContain('README.md: npm run docs:stale documents npm run docs:stale, but package.json has no "docs:stale" script');
    });
  });

  it('fails clearly when a workflow references a stale validation profile', () => {
    const staleWorkflow = VALID_WORKFLOW.replace('npm run validate:ui-smoke', 'npm run validate:ui-fast');
    withFixture(validFiles({ '.github/workflows/validation.yml': staleWorkflow }), (root) => {
      const result = verifyValidationCadence({ root });
      expect(result.ok).toBe(false);
      expect(result.failures).toContain('.github/workflows/validation.yml:29: npm run validate:ui-fast documents npm run validate:ui-fast, but package.json has no "validate:ui-fast" script');
    });
  });

  it('fails clearly when a workflow omits a required routine/docs profile', () => {
    const workflowWithoutRoutine = VALID_WORKFLOW.replace('      - run: npm run validate:routine\n', '');
    withFixture(validFiles({ '.github/workflows/validation.yml': workflowWithoutRoutine }), (root) => {
      const result = verifyValidationCadence({ root });
      expect(result.ok).toBe(false);
      expect(result.failures).toContain('validation workflow/template must run npm run validate:routine');
    });
  });

  it('fails clearly when a package validation profile script is missing', () => {
    const { 'validate:ui-smoke': _uiSmokeProfile, ...scripts } = PACKAGE_SCRIPTS;
    withFixture(validFiles({ 'package.json': JSON.stringify({ scripts }) }), (root) => {
      const result = verifyValidationCadence({ root });
      expect(result.ok).toBe(false);
      expect(result.failures).toContain('package.json is missing validation profile "validate:ui-smoke" (lightweight UI/operator smoke validation profile)');
      expect(result.failures).toContain('.github/workflows/validation.yml:29: npm run validate:ui-smoke documents npm run validate:ui-smoke, but package.json has no "validate:ui-smoke" script');
    });
  });

  it('fails clearly when docs:verify invokes a missing sub-guard script', () => {
    const docsVerify = VALID_DOCS_VERIFY.replace('scripts/check-existing.js', 'scripts/check-missing.js');
    withFixture(validFiles({
      'README.md': '```bash\nnpm run docs:verify\nnpm run web:test:operator-smoke\n```\n' + VALID_PROFILE_DOCS,
      'docs/runbook/release.md': '',
      'docs/runbook/index.md': '',
      'scripts/docs-verify.sh': docsVerify,
    }), (root) => {
      const result = verifyValidationCadence({ root });
      expect(result.ok).toBe(false);
      expect(result.failures).toContain('scripts/docs-verify.sh:4 invokes scripts/check-missing.js, but that docs:verify sub-guard entry point does not exist');
    });
  });

  it('fails clearly when the operator smoke script is missing', () => {
    const { 'web:test:operator-smoke': _smoke, ...scripts } = PACKAGE_SCRIPTS;
    const packageWithoutSmoke = JSON.stringify({ scripts });
    withFixture(validFiles({
      'package.json': packageWithoutSmoke,
      'README.md': '```bash\nnpm run docs:verify\n```\n' + VALID_PROFILE_DOCS,
      'docs/runbook/release.md': '',
      'docs/runbook/index.md': '',
    }), (root) => {
      const result = verifyValidationCadence({ root });
      expect(result.ok).toBe(false);
      expect(result.failures).toContain('package.json is missing required validation script "web:test:operator-smoke" (direct operator-dashboard smoke guard)');
    });
  });

  it('fails clearly when the operator smoke script is not documented', () => {
    withFixture(validFiles({
      'README.md': '```bash\nnpm run docs:verify\n```\n',
      'docs/runbook/release.md': '',
      'docs/runbook/index.md': '',
    }), (root) => {
      const result = verifyValidationCadence({ root });
      expect(result.ok).toBe(false);
      expect(result.failures).toContain('required validation script "web:test:operator-smoke" is not documented in README.md or docs/runbook/*.md validation cadence');
    });
  });

  it('fails clearly when the operator smoke script stops targeting the smoke test', () => {
    const packageWithDriftedSmoke = JSON.stringify({
      scripts: {
        ...PACKAGE_SCRIPTS,
        'web:test:operator-smoke': 'cd web && npx vitest run src/__tests__/dashboard-view.test.ts',
      },
    });
    withFixture(validFiles({
      'package.json': packageWithDriftedSmoke,
      'README.md': '```bash\nnpm run docs:verify\nnpm run web:test:operator-smoke\n```\n' + VALID_PROFILE_DOCS,
      'docs/runbook/release.md': '',
      'docs/runbook/index.md': '',
    }), (root) => {
      const result = verifyValidationCadence({ root });
      expect(result.ok).toBe(false);
      expect(result.failures).toContain('package.json script "web:test:operator-smoke" must run operator-dashboard-smoke.test.ts, but is currently: cd web && npx vitest run src/__tests__/dashboard-view.test.ts');
    });
  });

  it('fails clearly when a validation profile is missing an intended command', () => {
    const packageWithDriftedProfile = JSON.stringify({
      scripts: {
        ...PACKAGE_SCRIPTS,
        'validate:release': 'npm run typecheck && npm run build && npm test && npm run docs:verify',
      },
    });
    withFixture(validFiles({
      'package.json': packageWithDriftedProfile,
      'README.md': VALID_PROFILE_DOCS + '```bash\nnpm run web:test:operator-smoke\n```\n',
      'docs/runbook/release.md': '',
      'docs/runbook/index.md': '',
    }), (root) => {
      const result = verifyValidationCadence({ root });
      expect(result.ok).toBe(false);
      expect(result.failures).toContain('package.json profile "validate:release" must include npm run web:test:operator-smoke, but is currently: npm run typecheck && npm run build && npm test && npm run docs:verify');
    });
  });
});
