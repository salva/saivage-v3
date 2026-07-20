import { describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  'validate:routine': 'npm run typecheck && npm run check:canonical-persistence-drift && npm run docs:verify',
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

const VALID_WORKFLOW = readFileSync(new URL('../../.github/workflows/validation.yml', import.meta.url), 'utf8');

function mutateWorkflow(search, replacement = '') {
  expect(VALID_WORKFLOW).toContain(search);
  return VALID_WORKFLOW.replace(search, replacement);
}

function expectWorkflowFailure(workflow, expected) {
  withFixture(validFiles({ '.github/workflows/validation.yml': workflow }), (root) => {
    const result = verifyValidationCadence({ root });
    expect(result.ok).toBe(false);
    expect(result.failures).toContainEqual(expect.stringContaining(expected));
  });
}

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
      expect(result.validationWorkflowContractEntriesChecked).toContain('.github/workflows/validation.yml path-aware production dependency audit gate');
      expect(result.validationWorkflowContractEntriesChecked).toContain('.github/workflows/validation.yml aggregate dependency-hygiene require_applicable call');
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
      expect(result.failures).toContainEqual(expect.stringContaining('dependency-hygiene must depend exactly'));
    });
  });

  it('fails clearly when validation-required omits dependency-hygiene aggregation', () => {
    const workflowWithoutAggregate = VALID_WORKFLOW.replace('          require_applicable dependency-hygiene "$DEPENDENCY_APPLIES" "$DEPENDENCY_RESULT"\n', '');
    withFixture(validFiles({ '.github/workflows/validation.yml': workflowWithoutAggregate }), (root) => {
      const result = verifyValidationCadence({ root });
      expect(result.ok).toBe(false);
      expect(result.failures).toContainEqual(expect.stringContaining('aggregate dependency-hygiene require_applicable call'));
    });
  });

  describe('structured YAML and exact trigger mutations', () => {
    const triggerBlock = 'on:\n  push:\n    branches:\n      - master\n';
    const triggerMutations = [
      ['malformed YAML', 'on: [', 'invalid YAML'],
      ['duplicate top-level on', `${triggerBlock}on:\n  push:\n    branches: [master]\n`, 'Map keys must be unique'],
      ['duplicate push', `on:\n  push:\n    branches: [master]\n  push:\n    branches: [master]\n`, 'Map keys must be unique'],
      ['duplicate branches', `on:\n  push:\n    branches: [master]\n    branches: [master]\n`, 'Map keys must be unique'],
      ['wrong branch', `on:\n  push:\n    branches: [main]\n`, 'exact push-only master trigger'],
      ['missing branch', `on:\n  push:\n    branches: []\n`, 'exact push-only master trigger'],
      ['extra branch', `on:\n  push:\n    branches: [master, release]\n`, 'exact push-only master trigger'],
      ['duplicate branch item', `on:\n  push:\n    branches: [master, master]\n`, 'exact push-only master trigger'],
      ['scalar on', `on: push\n`, 'exact push-only master trigger'],
      ['null on', `on:\n`, 'exact push-only master trigger'],
      ['list on', `on: [push]\n`, 'exact push-only master trigger'],
      ['scalar push', `on:\n  push: master\n`, 'exact push-only master trigger'],
      ['null push', `on:\n  push:\n`, 'exact push-only master trigger'],
      ['list push', `on:\n  push: [master]\n`, 'exact push-only master trigger'],
      ...['pull_request', 'workflow_dispatch', 'schedule'].map((event) => [`extra ${event} event`, `${triggerBlock}  ${event}:\n`, 'exact push-only master trigger']),
      ...['paths', 'paths-ignore', 'tags', 'tags-ignore', 'future-filter'].map((filter) => [`extra ${filter} push filter`, `on:\n  push:\n    branches: [master]\n    ${filter}: ['**']\n`, 'exact push-only master trigger']),
    ];

    it.each(triggerMutations)('rejects %s', (_label, replacement, expected) => {
      expectWorkflowFailure(mutateWorkflow(triggerBlock, replacement), expected);
    });
  });

  describe('classifier contract mutations', () => {
    const mutations = [
      ['push base', "base='\${{ github.event.before }}'", "base='\${{ github.sha }}'", 'push base from github.event.before'],
      ['push head', "head='\${{ github.sha }}'", "head='\${{ github.event.before }}'", 'push head from github.sha'],
      ['empty/all-zero fallback', 'if [[ -z "$base" || "$base" =~ ^0+$ ]]; then', 'if [[ -z "$base" ]]; then', 'empty or all-zero push-base'],
      ['base/head presence', 'if [[ -z "$base" || -z "$head" ]]; then', 'if [[ -z "$base" ]]; then', 'base/head presence'],
      ['commit availability', 'elif ! git cat-file -e "$base^{commit}" 2>/dev/null || ! git cat-file -e "$head^{commit}" 2>/dev/null; then', 'elif false; then', 'commit availability'],
      ['diff failure', 'elif ! git diff --name-only "$base" "$head" > changed-files.txt; then', 'elif git diff --name-only "$base" "$head" > changed-files.txt; then', 'git diff failure'],
      ['fail-closed run_all', '            run_all=true\n            docs_only=false\n            summary="fail-closed: $1"', '            docs_only=false\n            summary="fail-closed: $1"', 'fail-closed run_all assignment'],
      ['fail-closed docs_only', '            run_all=true\n            docs_only=false\n            summary="fail-closed: $1"', '            run_all=true\n            summary="fail-closed: $1"', 'fail-closed docs_only assignment'],
      ['docs-like class', 'docs/*|architecture-audit/*|audit-findings/*|ui-findings/*|*.md|README.md|EADME.md', 'docs/*', 'docs-like path class'],
      ['package/workflow class', 'package.json|package-lock.json|web/package.json|web/package-lock.json|.github/workflows/*', 'package.json', 'package/workflow path class'],
      ['workflow run-all class', '              .github/workflows/*)\n                run_all=true', '              .github/workflows/*)\n                package_or_workflow=true', 'workflow run-all path class'],
      ['contracts class', '              src/contracts/*)', '              src/contract-files/*)', 'contracts backend/UI/browser'],
      ['backend class', 'src/*|src/**/*|bin/*|bin/**/*|scripts/*|scripts/**/*|tests/*|tests/**/*|jest.config.*|tsconfig*.json)', 'src/*)', 'backend path class with Playwright exclusion'],
      ['Playwright exclusion', 'if [[ "$file" != tests/playwright/* ]]; then', 'if [[ true ]]; then', 'backend path class with Playwright exclusion'],
      ['web/Playwright class', 'web/*|web/**/*|tests/playwright/*|tests/playwright/**/*)', 'web/*)', 'web/Playwright UI and browser'],
      ['non-doc clearing', 'if [[ "$docs_like" != true ]]; then', 'if [[ "$docs_like" == true ]]; then', 'non-doc clearing'],
      ['empty-list handling', 'if [[ ! -s changed-files.txt ]]; then', 'if [[ -s changed-files.txt ]]; then', 'empty-list routine/docs-only'],
      ['initial docs-only', '              else\n                docs_only=true\n                while IFS= read -r changed_file;', '              else\n                while IFS= read -r changed_file;', 'normal-list initial docs-only'],
      ['run-all promotion', '          if [[ "$run_all" == true ]]; then', '          if [[ "$run_all" == false ]]; then', 'run-all promotion'],
      ['package promotion', '          elif [[ "$package_or_workflow" == true ]]; then', '          elif [[ "$package_or_workflow" == false ]]; then', 'package/workflow promotion'],
      ['event dispatch remnant', '          base=', '          echo pull_request\n          base=', 'obsolete event/backstop token pull_request'],
      ['push event-selection dispatch', '          base=', "          if [[ \"\${{ github.event_name }}\" == push ]]; then :; fi\n          base=", 'must not contain event-selection dispatch'],
      ['obsolete backstop', 'jobs:\n', 'jobs:\n  scheduled-release-backstop: {}\n', 'obsolete event/backstop token scheduled-release-backstop'],
    ];
    for (const output of ['backend', 'ui', 'browser', 'docs_only', 'package_or_workflow', 'run_all', 'summary']) {
      mutations.push([`${output} declared output`, `      ${output}: \${{ steps.classify.outputs.${output} }}\n`, '', 'publish exactly']);
      mutations.push([`${output} output write`, `            echo "${output}=$${output}"\n`, '', `${output} GITHUB_OUTPUT write`]);
    }

    it.each(mutations)('rejects mutation of %s', (_label, search, replacement, expected) => {
      expectWorkflowFailure(mutateWorkflow(search, replacement), expected);
    });
  });

  describe('complete aggregate mutations', () => {
    const pathJobs = [
      ['backend-jest-build', 'BACKEND'],
      ['ui-vitest', 'UI'],
      ['browser-smoke', 'BROWSER'],
      ['dependency-hygiene', 'DEPENDENCY'],
    ];
    const mutations = [
      ...['classify-changes', 'routine-docs', ...pathJobs.map(([name]) => name)].map((name) => [`remove need ${name}`, `      - ${name}\n`, '', 'needs must contain exactly']),
      ...['classify-changes', 'routine-docs', ...pathJobs.map(([name]) => name)].map((name) => [`rename need ${name}`, `      - ${name}\n`, `      - ${name}-renamed\n`, 'needs must contain exactly']),
      ['extra need', '      - dependency-hygiene\n', '      - dependency-hygiene\n      - extra-job\n', 'needs must contain exactly'],
      ['always', '    if: \${{ always() }}', '    if: \${{ success() }}', 'must retain if'],
      ['classifier result', '          CLASSIFIER_RESULT: \${{ needs.classify-changes.result }}', '          CLASSIFIER_RESULT: wrong', 'CLASSIFIER_RESULT must be exactly'],
      ['routine result', '          ROUTINE_RESULT: \${{ needs.routine-docs.result }}', '          ROUTINE_RESULT: wrong', 'ROUTINE_RESULT must be exactly'],
      ['classifier require_success', '          require_success classify-changes "$CLASSIFIER_RESULT"\n', '', 'classifier require_success'],
      ['routine require_success', '          require_success routine-docs "$ROUTINE_RESULT"\n', '', 'routine require_success'],
      ['classifier summary ref', '          CLASSIFIER_SUMMARY: \${{ needs.classify-changes.outputs.summary }}', '          CLASSIFIER_SUMMARY: wrong', 'CLASSIFIER_SUMMARY must be exactly'],
      ['classifier summary line', '            echo "- classifier: $CLASSIFIER_RESULT ($CLASSIFIER_SUMMARY)"\n', '', 'classifier summary line'],
      ['routine summary line', '            echo "- routine-docs: $ROUTINE_RESULT"\n', '', 'routine summary line'],
      ['require_success semantics', '          require_success() {\n            local name="$1"\n            local result="$2"\n            if [[ "$result" != success ]]; then', '          require_success() {\n            local name="$1"\n            local result="$2"\n            if [[ "$result" == success ]]; then', 'require_success semantics'],
      ['applicable success', '            if [[ "$applies" == true ]]; then\n              if [[ "$result" != success ]]; then', '            if [[ "$applies" == true ]]; then\n              if [[ "$result" == success ]]; then', 'applicable success semantics'],
      ['non-applicable skipped', 'if [[ "$result" != skipped ]]; then', 'if [[ "$result" == skipped ]]; then', 'non-applicable skipped semantics'],
      ['failure accumulation', '          failures=()\n', '', 'failure array initialization'],
      ['failure exit', '            exit 1\n', '', 'failure accumulation exit'],
      ['obsolete event state', '          CLASSIFIER_RESULT:', '          EVENT_NAME: pull_request\n          CLASSIFIER_RESULT:', 'obsolete event/backstop token pull_request'],
    ];
    for (const [job, prefix] of pathJobs) {
      const header = `  ${job}:\n    name: ${job}\n    runs-on: ubuntu-latest\n    needs: classify-changes`;
      mutations.push(
        [`${job} classifier dependency`, header, header.replace('needs: classify-changes', 'needs: routine-docs'), 'must depend exactly'],
        [`${job} job applicability`, `${header}\n    if:`, `${header}\n    if: \${{ false }} #`, 'must use exact push path applicability'],
        [`${job} result env`, `          ${prefix}_RESULT: \${{ needs.${job}.result }}`, `          ${prefix}_RESULT: wrong`, `${prefix}_RESULT must be exactly`],
        [`${job} applies env`, `          ${prefix}_APPLIES:`, `          ${prefix}_APPLIES: \${{ false }} #`, `${prefix}_APPLIES must match`],
        [`${job} call`, `          require_applicable ${job} "$${prefix}_APPLIES" "$${prefix}_RESULT"\n`, '', `${job} require_applicable call`],
        [`${job} summary`, `            echo "- ${job}: $${prefix}_RESULT (applies=$${prefix}_APPLIES)"\n`, '', `${job} summary line`],
      );
    }
    mutations.push(
      ['browser schedule exclusion', '          BROWSER_APPLIES:', "          BROWSER_APPLIES: \${{ github.event_name != 'schedule' &&", 'obsolete event/backstop token schedule'],
      ['dependency schedule alternative', '          DEPENDENCY_APPLIES:', "          DEPENDENCY_APPLIES: \${{ github.event_name == 'schedule' ||", 'obsolete event/backstop token schedule'],
    );

    it.each(mutations)('rejects mutation of %s', (_label, search, replacement, expected) => {
      expectWorkflowFailure(mutateWorkflow(search, replacement), expected);
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
