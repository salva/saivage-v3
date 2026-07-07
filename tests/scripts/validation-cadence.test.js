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
  'test:direct': 'node ./node_modules/jest/bin/jest.js',
  'audit:root': 'npm audit --audit-level=high --omit=dev',
  'audit:web': 'cd web && npm audit --audit-level=high --omit=dev',
  'audit:security': 'npm run audit:root && npm run audit:web',
  'audit:security:all': 'npm audit --audit-level=moderate && cd web && npm audit --audit-level=moderate',
  'deps:freshness': 'node scripts/check-dependency-freshness.js',
  'deps:review': 'npm run audit:security:all && npm run deps:freshness',
  'web:typecheck': 'cd web && npm run typecheck',
  'web:test': 'cd web && npm run test',
  'test:web': 'npm run web:test',
  'web:test:sweep': 'npm run web:test:control-room && npm run web:test:stores',
  'test:web:sweep': 'npm run web:test:sweep',
  'web:test:operator-smoke': 'cd web && npx vitest run src/__tests__/operator-dashboard-smoke.test.ts',
  'test:web:operator-smoke': 'npm run web:test:operator-smoke',
  'web:test:analyst-ui': 'cd web && npx vitest run src/__tests__/analyst-chat-panel.test.ts',
  'test:web:analyst-ui': 'npm run web:test:analyst-ui',
  'validate:docs': 'npm run docs:verify',
  'validate:routine': 'npm run typecheck && npm run docs:verify',
  'validate:ui-smoke': 'npm run web:test:operator-smoke',
  'validate:ui': 'npm run web:typecheck && npm run web:test:sweep && npm run web:test:operator-smoke',
  'validate:release': 'npm run typecheck && npm run build && npm test && npm run web:test:operator-smoke && npm run docs:verify',
  'web:test:e2e:install': 'playwright install chromium',
  'web:test:e2e:smoke': 'playwright test -c tests/playwright/playwright.config.ts',
};

const PACKAGE_JSON = JSON.stringify({
  engines: { node: '>=24 <25', npm: '>=10 <12' },
  scripts: PACKAGE_SCRIPTS,
});

const WEB_PACKAGE_JSON = JSON.stringify({
  engines: { node: '>=24 <25', npm: '>=10 <12' },
  scripts: { build: 'vite build' },
});

const VALID_PROFILE_DOCS = '```bash\nnpm run validate:docs\nnpm run validate:routine\nnpm run validate:ui-smoke\nnpm run validate:ui\nnpm run validate:release\nnpm run audit:security\nnpm run deps:review\n```\n`npm run validate:docs` intentionally runs docs verification only and does not run `npm test` or the Vitest smoke guard.\n';

const VALID_DOCS_VERIFY = `#!/usr/bin/env bash
set -euo pipefail
npm run docs:build
node scripts/check-existing.js
NODE_OPTIONS=--experimental-vm-modules npx jest tests/existing.test.js --runInBand --forceExit || ALL_OK=false
`;

const VALID_WORKFLOW = `name: Validation profiles
on:
  pull_request:
  push:
    branches:
      - main
  workflow_dispatch:
    inputs:
      run_full_sweep:
        default: 'true'
  schedule:
    - cron: '17 5 * * *'
permissions:
  contents: read
concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  classify-changes:
    runs-on: ubuntu-latest
    outputs:
      backend: \${{ steps.classify.outputs.backend }}
      ui: \${{ steps.classify.outputs.ui }}
      browser: \${{ steps.classify.outputs.browser }}
      docs_only: \${{ steps.classify.outputs.docs_only }}
      package_or_workflow: \${{ steps.classify.outputs.package_or_workflow }}
      run_all: \${{ steps.classify.outputs.run_all }}
      summary: \${{ steps.classify.outputs.summary }}
    steps:
      - uses: actions/checkout@v4
      - id: classify
        run: |
          set -euo pipefail
          echo "run_all=true" >> "$GITHUB_OUTPUT"
          echo "package_or_workflow=true" >> "$GITHUB_OUTPUT"
          echo "summary=fixture" >> "$GITHUB_OUTPUT"
  routine-docs:
    runs-on: ubuntu-latest
    needs: classify-changes
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run validate:routine
      - run: npm run validate:docs
  backend-jest-build:
    runs-on: ubuntu-latest
    needs: classify-changes
    if: \${{ needs.classify-changes.outputs.run_all == 'true' }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: npm test
  ui-smoke:
    runs-on: ubuntu-latest
    needs: classify-changes
    if: \${{ needs.classify-changes.outputs.ui == 'true' }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run validate:ui-smoke
  browser-smoke:
    runs-on: ubuntu-latest
    needs: classify-changes
    if: \${{ needs.classify-changes.outputs.browser == 'true' }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run web:test:e2e:install
      - run: npx playwright install-deps chromium
      - run: npm run web:test:e2e:smoke
  scheduled-release-backstop:
    runs-on: ubuntu-latest
    needs: classify-changes
    if: \${{ github.event_name == 'schedule' }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run validate:release
      - run: npm run web:test:e2e:install
      - run: npx playwright install-deps chromium
      - run: npm run web:test:e2e:smoke
  dependency-hygiene:
    runs-on: ubuntu-latest
    needs: classify-changes
    if: \${{ github.event_name == 'schedule' || needs.classify-changes.outputs.run_all == 'true' || needs.classify-changes.outputs.package_or_workflow == 'true' }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: cd web && npm ci
      - run: npm run audit:security
      - run: npm run deps:review
        if: \${{ github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' }}
  validation-required:
    runs-on: ubuntu-latest
    if: \${{ always() }}
    needs:
      - classify-changes
      - routine-docs
      - backend-jest-build
      - ui-smoke
      - browser-smoke
      - scheduled-release-backstop
      - dependency-hygiene
    steps:
      - run: |
          DEPENDENCY_RESULT=success
          DEPENDENCY_APPLIES=true
        env:
          DEPENDENCY_RESULT: \${{ needs.dependency-hygiene.result }}
          DEPENDENCY_APPLIES: \${{ github.event_name == 'schedule' || needs.classify-changes.outputs.run_all == 'true' || needs.classify-changes.outputs.package_or_workflow == 'true' }}
          require_applicable dependency-hygiene "$DEPENDENCY_APPLIES" "$DEPENDENCY_RESULT"
          echo "- dependency-hygiene: $DEPENDENCY_RESULT (applies=$DEPENDENCY_APPLIES)"
          echo validation-required passed
`;

function validFiles(overrides = {}) {
  return {
    'package.json': PACKAGE_JSON,
    'README.md': 'Use Node.js 24 with `node >=24 <25` and `npm >=10 <12`, matching package.json engines and GitHub Actions CI.\n```bash\nnpm run docs:verify\nnpm run typecheck\nnpm run build\nnpm test\nnpm run web:test:operator-smoke\n```\n' + VALID_PROFILE_DOCS,
    'web/package.json': WEB_PACKAGE_JSON,
    'docs/architecture/system-architecture.md': 'Run Saivage with Node.js 24; package.json engines require `node >=24 <25` and `npm >=10 <12`, matching CI.\nValidation-command confusion: canonical `npm run web:test:analyst-ui` and alias `npm run test:web:analyst-ui`; smoke uses `npm run web:test:operator-smoke` or `npm run test:web:operator-smoke`.\n```bash\nnpm run docs:build\nnpm run web:test:sweep\nnpm run test:web:sweep\n```\n' + VALID_PROFILE_DOCS,
    '.github/workflows/validation.yml': VALID_WORKFLOW,
    'scripts/docs-verify.sh': VALID_DOCS_VERIFY,
    'scripts/check-existing.js': '#!/usr/bin/env node\n',
    'scripts/check-dependency-freshness.js': '#!/usr/bin/env node\n',
    'tests/existing.test.js': 'test("ok", () => {});\n',
    ...overrides,
  };
}

describe('validation cadence guard', () => {
  it('passes when documented validation commands, workflow commands, dependency hygiene, and docs:verify sub-guards resolve', () => {
    withFixture(validFiles(), (root) => {
      const result = verifyValidationCadence({ root });
      expect(result.ok).toBe(true);
      expect(result.failures).toEqual([]);
      expect(result.requiredValidationScriptsChecked).toContain('package.json script web:test:operator-smoke');
      expect(result.requiredValidationScriptsChecked).toContain('package.json script audit:security');
      expect(result.requiredValidationScriptsChecked).toContain('package.json script deps:review');
      expect(result.dependencyHygieneWorkflowEntriesChecked).toContain('.github/workflows/validation.yml job dependency-hygiene');
      expect(result.dependencyHygieneWorkflowEntriesChecked).toContain('.github/workflows/validation.yml aggregate requires dependency-hygiene');
      expect(result.workflowCommandsChecked).toContainEqual(expect.stringContaining('npm run validate:routine'));
      expect(result.workflowCommandsChecked).toContainEqual(expect.stringContaining('npm run audit:security'));
      expect(result.validationProfilesChecked).toContain('package.json profile validate:release');
      expect(result.webTestAliasEntriesChecked).toContain('package.json alias test:web:sweep -> web:test:sweep');
      expect(result.webTestAliasEntriesChecked).toContain('package.json alias test:web:operator-smoke -> web:test:operator-smoke');
      expect(result.runtimeEngineEntriesChecked).toContain('package.json engines');
      expect(result.runtimeEngineEntriesChecked).toContain('web/package.json engines');
      expect(result.docsVerifyEntriesChecked).toContain('scripts/docs-verify.sh:4 node-script scripts/check-existing.js');
      expect(result.failClosedJestGateEntriesChecked).toContain('package.json script test');
    });
  });

  it('fails clearly when root npm test uses --passWithNoTests', () => {
    const packageWithPermissiveTest = JSON.stringify({ engines: { node: '>=24 <25', npm: '>=10 <12' }, scripts: { ...PACKAGE_SCRIPTS, test: 'jest --passWithNoTests' } });
    withFixture(validFiles({ 'package.json': packageWithPermissiveTest }), (root) => {
      const result = verifyValidationCadence({ root });
      expect(result.ok).toBe(false);
      expect(result.failures).toContain('package.json script test must not use --passWithNoTests; root/release Jest gates must fail when no tests are discovered');
    });
  });

  it('fails clearly when package engines drift from the supported Node/npm range', () => {
    const packageWithNode20 = JSON.stringify({ engines: { node: '>=20 <21', npm: '>=10 <12' }, scripts: PACKAGE_SCRIPTS });
    withFixture(validFiles({ 'package.json': packageWithNode20 }), (root) => {
      const result = verifyValidationCadence({ root });
      expect(result.ok).toBe(false);
      expect(result.failures).toContain('package.json engines.node must be ">=24 <25" to match CI Node 24, but is ">=20 <21"');
    });
  });

  it('fails clearly when workflow permissions are broad', () => {
    const workflowWithBroadPermissions = VALID_WORKFLOW.replace('permissions:\n  contents: read', 'permissions: write-all');
    withFixture(validFiles({ '.github/workflows/validation.yml': workflowWithBroadPermissions }), (root) => {
      const result = verifyValidationCadence({ root });
      expect(result.ok).toBe(false);
      expect(result.failures).toContainEqual(expect.stringContaining('must not use broad workflow permissions; use least-privilege contents: read'));
    });
  });

  it('fails clearly when setup-node drifts from Node 24', () => {
    const workflowWithoutNode24 = VALID_WORKFLOW.replace('          node-version: 24', '          node-version: 20');
    withFixture(validFiles({ '.github/workflows/validation.yml': workflowWithoutNode24 }), (root) => {
      const result = verifyValidationCadence({ root });
      expect(result.ok).toBe(false);
      expect(result.failures).toContain('.github/workflows/validation.yml must use actions/setup-node@v4 with node-version: 24');
    });
  });

  it('fails clearly when docs reference a stale npm validation command', () => {
    withFixture(validFiles({ 'README.md': '```bash\nnpm run docs:stale\nnpm run web:test:operator-smoke\n```\n' + VALID_PROFILE_DOCS }), (root) => {
      const result = verifyValidationCadence({ root });
      expect(result.ok).toBe(false);
      expect(result.failures).toContain('README.md: npm run docs:stale documents npm run docs:stale, but package.json has no "docs:stale" script');
    });
  });

  it('fails clearly when a documented test:web alias is missing', () => {
    const { 'test:web:analyst-ui': _alias, ...scripts } = PACKAGE_SCRIPTS;
    withFixture(validFiles({ 'package.json': JSON.stringify({ engines: { node: '>=24 <25', npm: '>=10 <12' }, scripts }) }), (root) => {
      const result = verifyValidationCadence({ root });
      expect(result.ok).toBe(false);
      expect(result.failures).toContain('docs/architecture/system-architecture.md: npm run test:web:analyst-ui documents npm run test:web:analyst-ui, but package.json has no "test:web:analyst-ui" script');
      expect(result.failures).toContain('docs/architecture/system-architecture.md: npm run test:web:analyst-ui documents npm run test:web:analyst-ui, but package.json has no "test:web:analyst-ui" alias to "web:test:analyst-ui"');
    });
  });

  it('fails clearly when a documented test:web alias drifts from its canonical web:test target', () => {
    const packageWithDriftedAlias = JSON.stringify({
      engines: { node: '>=24 <25', npm: '>=10 <12' },
      scripts: { ...PACKAGE_SCRIPTS, 'test:web:operator-smoke': 'cd web && npx vitest run src/__tests__/operator-dashboard-smoke.test.ts' },
    });
    withFixture(validFiles({ 'package.json': packageWithDriftedAlias }), (root) => {
      const result = verifyValidationCadence({ root });
      expect(result.ok).toBe(false);
      expect(result.failures).toContain('package.json alias "test:web:operator-smoke" must be exactly "npm run web:test:operator-smoke", but is currently: cd web && npx vitest run src/__tests__/operator-dashboard-smoke.test.ts');
    });
  });

  it('fails clearly when dependency hygiene scripts are missing', () => {
    const { 'audit:security': _auditSecurity, ...scripts } = PACKAGE_SCRIPTS;
    withFixture(validFiles({ 'package.json': JSON.stringify({ engines: { node: '>=24 <25', npm: '>=10 <12' }, scripts }) }), (root) => {
      const result = verifyValidationCadence({ root });
      expect(result.ok).toBe(false);
      expect(result.failures).toContain('package.json is missing required validation script "audit:security" (combined production dependency security gate)');
    });
  });

  it('fails clearly when dependency hygiene workflow job is missing', () => {
    const workflowWithoutJob = VALID_WORKFLOW.replace('  dependency-hygiene:', '  dependency-hygiene-removed:');
    withFixture(validFiles({ '.github/workflows/validation.yml': workflowWithoutJob }), (root) => {
      const result = verifyValidationCadence({ root });
      expect(result.ok).toBe(false);
      expect(result.failures).toContain('.github/workflows/validation.yml must define a dependency-hygiene job');
    });
  });

  it('fails clearly when validation-required omits dependency-hygiene aggregation', () => {
    const workflowWithoutAggregate = VALID_WORKFLOW.replace('          require_applicable dependency-hygiene "$DEPENDENCY_APPLIES" "$DEPENDENCY_RESULT"\n', '');
    withFixture(validFiles({ '.github/workflows/validation.yml': workflowWithoutAggregate }), (root) => {
      const result = verifyValidationCadence({ root });
      expect(result.ok).toBe(false);
      expect(result.failures).toContain('.github/workflows/validation.yml dependency-hygiene workflow must include aggregate requires dependency-hygiene');
    });
  });

  it('fails clearly when scheduled/manual dependency review is removed', () => {
    const workflowWithoutDepsReview = VALID_WORKFLOW.replace('      - run: npm run deps:review\n        if: \${{ github.event_name == \'schedule\' || github.event_name == \'workflow_dispatch\' }}\n', '');
    withFixture(validFiles({ '.github/workflows/validation.yml': workflowWithoutDepsReview }), (root) => {
      const result = verifyValidationCadence({ root });
      expect(result.ok).toBe(false);
      expect(result.failures).toContain('.github/workflows/validation.yml dependency-hygiene workflow must include scheduled/manual deps review');
    });
  });

  it('fails clearly when the operator smoke script stops targeting the smoke test', () => {
    const packageWithDriftedSmoke = JSON.stringify({ scripts: { ...PACKAGE_SCRIPTS, 'web:test:operator-smoke': 'cd web && npx vitest run src/__tests__/dashboard-view.test.ts' } });
    withFixture(validFiles({ 'package.json': packageWithDriftedSmoke }), (root) => {
      const result = verifyValidationCadence({ root });
      expect(result.ok).toBe(false);
      expect(result.failures).toContain('package.json script "web:test:operator-smoke" must run operator-dashboard-smoke.test.ts, but is currently: cd web && npx vitest run src/__tests__/dashboard-view.test.ts');
    });
  });
});
