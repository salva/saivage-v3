import { describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse, stringify } from 'yaml';
import { verifyValidationCadence } from '../../scripts/check-validation-cadence.js';

const TERMINAL_CHILD_PATH = 'tests/boot/app-terminal-child-process.test.ts';
const TERMINAL_CHILD_IGNORE_REGEX = String.raw`<rootDir>/tests/boot/app-terminal-child-process\.test\.ts$`;
const TERMINAL_CHILD_COMMAND = `NODE_OPTIONS=--experimental-vm-modules node ./node_modules/jest/bin/jest.js --runInBand --runTestsByPath ${TERMINAL_CHILD_PATH} --testPathIgnorePatterns='<rootDir>/tests/(playwright|e2e)/'`;
const JEST_IGNORE_PATTERNS = [
  '<rootDir>/tests/playwright/',
  '<rootDir>/tests/e2e/',
  TERMINAL_CHILD_IGNORE_REGEX,
];

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
  test: 'npm run test:parallel && npm run test:terminal-child',
  'test:parallel': 'NODE_OPTIONS=--experimental-vm-modules jest',
  'test:terminal-child': TERMINAL_CHILD_COMMAND,
  'test:direct': 'NODE_OPTIONS=--experimental-vm-modules node ./node_modules/jest/bin/jest.js',
  'test:e2e': "NODE_OPTIONS=--experimental-vm-modules jest tests/e2e/ --testPathIgnorePatterns='<rootDir>/tests/playwright/'",
  'audit:root': 'npm audit --audit-level=high --omit=dev',
  'audit:web': 'cd web && npm audit --audit-level=high --omit=dev',
  'audit:security': 'npm run audit:root && npm run audit:web',
  'audit:security:all': 'npm audit --audit-level=moderate && cd web && npm audit --audit-level=moderate',
  'deps:freshness': 'node scripts/check-dependency-freshness.js',
  'deps:review': 'npm run audit:security:all && npm run deps:freshness',
  'check:export-consumers': 'node scripts/check-export-consumers.js',
  'test:import-boundaries': 'node scripts/check-import-boundaries.cjs --self-test && node --test tests/scripts/import-boundary-ratchet.test.cjs && node scripts/check-import-boundaries.cjs',
  lint: 'npm run check:export-consumers && npm run check:stamp-producers && eslint src/ && npm run test:import-boundaries && node scripts/check-web-component-boundaries.cjs && npm run format',
  'web:typecheck': 'cd web && npm run typecheck',
  'web:test': 'cd web && npm run test',
  'web:test:sweep': 'npm run web:test:control-room && npm run web:test:stores',
  'web:test:operator-smoke': 'cd web && npx vitest run src/__tests__/operator-cockpit-smoke.test.ts',
  'web:test:analyst-ui': 'cd web && npx vitest run src/__tests__/analyst-chat-panel.test.ts',
  'validate:docs': 'npm run docs:verify',
  'validate:routine': 'npm run typecheck && npm run check:export-consumers && npm run check:canonical-persistence-drift && npm run test:direct -- --runInBand tests/architecture && npm run docs:verify',
  'validate:ui-smoke': 'npm run web:test:operator-smoke',
  'validate:ui': 'npm run web:typecheck && npm run web:test:sweep && npm run web:test:operator-smoke',
  'validate:release': 'npm run typecheck && npm run build && npm test && npm run test:e2e && npm run web:test:operator-smoke && npm run docs:verify',
  'web:test:e2e:install': 'playwright install chromium',
  'web:test:e2e:preview-smoke': 'playwright test -c tests/playwright/smoke/playwright.config.ts',
  'web:test:e2e:browser-client-smoke': 'playwright test -c tests/playwright/browser-client/chat-api-client-browser.config.ts',
  'web:test:e2e:smoke': 'npm run web:test:e2e:preview-smoke && npm run web:test:e2e:browser-client-smoke',
};

const PACKAGE_JSON = JSON.stringify({
  engines: { node: '>=24 <25', npm: '>=10 <12' },
  scripts: PACKAGE_SCRIPTS,
  jest: { testPathIgnorePatterns: JEST_IGNORE_PATTERNS },
});

const WEB_PACKAGE_JSON = JSON.stringify({
  engines: { node: '>=24 <25', npm: '>=10 <12' },
  scripts: { build: 'vite build' },
});

const VALID_PROFILE_DOCS = '```bash\nnpm run check:export-consumers\nnpm run validate:docs\nnpm run validate:routine\nnpm run validate:ui-smoke\nnpm run validate:ui\nnpm run validate:release\nnpm run audit:security\nnpm run deps:review\n```\n';

const VALID_PLAYWRIGHT_DOCS = `
\`\`\`bash
npm ci
(cd web && npm ci)
npm run build
\`\`\`
See \`tests/playwright/smoke/preview.spec.ts\`.
`;

const VALID_DOCS_VERIFY = `#!/usr/bin/env bash
set -euo pipefail
npm run docs:build
node scripts/check-existing.js
NODE_OPTIONS=--experimental-vm-modules npx jest tests/existing.test.js --runInBand --forceExit || ALL_OK=false
`;

const VALID_WORKFLOW = readFileSync(new URL('../../.github/workflows/validation.yml', import.meta.url), 'utf8');
const PATH_JOBS = [
  ['backend-jest-build', 'BACKEND'], ['backend-e2e', 'BACKEND_E2E'],
  ['ui-vitest', 'UI'], ['browser-smoke', 'BROWSER'],
  ['dependency-hygiene', 'DEPENDENCY'], ['lint-guards', 'LINT_GUARDS'],
];

function shellEnv(root) {
  return { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GITHUB_OUTPUT: join(root, 'output'), GITHUB_STEP_SUMMARY: join(root, 'summary') };
}

function classify(paths, expectedTrue, { base, head, failDiff = false, workflow = VALID_WORKFLOW } = {}) {
  withFixture({}, (root) => {
    const env = shellEnv(root);
    const git = (...args) => {
      const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
      expect(result.status).toBe(0);
      return result.stdout.trim();
    };
    git('init', '--quiet', '--template=');
    git('commit', '--quiet', '--allow-empty', '-m', 'base');
    const baseSha = git('rev-parse', 'HEAD');
    for (const file of paths) {
      mkdirSync(join(root, file, '..'), { recursive: true });
      writeFileSync(join(root, file), 'fixture\n');
    }
    git('add', '--all');
    git('commit', '--quiet', '--allow-empty', '-m', 'head');
    const headSha = git('rev-parse', 'HEAD');
    const script = parse(workflow).jobs['classify-changes'].steps.find((step) => step.id === 'classify').run
      .replaceAll('${{ github.event.before }}', base ?? baseSha).replaceAll('${{ github.sha }}', head ?? headSha);
    // Only the otherwise hard-to-induce diff failure is injected; all other Git calls are real.
    const diffFailure = failDiff ? 'git() { if [[ "$1" == diff ]]; then return 1; fi; command git "$@"; }\n' : '';
    const result = spawnSync('bash', ['--noprofile', '--norc', '-c', diffFailure + script], { cwd: root, env, encoding: 'utf8' });
    expect(result.status).toBe(0);
    const outputs = Object.fromEntries(readFileSync(env.GITHUB_OUTPUT, 'utf8').trimEnd().split('\n').map((line) => {
      const equals = line.indexOf('=');
      return [line.slice(0, equals), line.slice(equals + 1)];
    }));
    expect(Object.keys(outputs).sort()).toEqual(['backend', 'browser', 'docs_only', 'package_or_workflow', 'run_all', 'summary', 'ui']);
    for (const name of Object.keys(outputs).filter((name) => name !== 'summary')) {
      expect(outputs[name]).toBe(expectedTrue.includes(name) ? 'true' : 'false');
    }
  });
}

function aggregate(overrides = {}, workflow = VALID_WORKFLOW) {
  const { expectedStatus = 0, ...values } = overrides;
  withFixture({}, (root) => {
    const env = { ...shellEnv(root), CLASSIFIER_RESULT: 'success', ROUTINE_RESULT: 'success', CLASSIFIER_SUMMARY: 'fixture' };
    for (const [, prefix] of PATH_JOBS) Object.assign(env, { [`${prefix}_APPLIES`]: 'false', [`${prefix}_RESULT`]: 'skipped' });
    Object.assign(env, values);
    const script = parse(workflow).jobs['validation-required'].steps.find((step) => typeof step.run === 'string').run;
    const result = spawnSync('bash', ['--noprofile', '--norc', '-c', script], { cwd: root, env, encoding: 'utf8' });
    expect(result.status).toBe(expectedStatus);
  });
}

describe('actual workflow shell decisions', () => {
  const all = ['backend', 'ui', 'browser', 'package_or_workflow', 'run_all'];
  it.each([
    ['empty', [], ['docs_only']],
    ['docs-only', ['docs/page.txt', 'architecture-audit/report.txt', 'audit-findings/report.txt', 'ui-findings/report.txt', 'notes.md', 'EADME.md'], ['docs_only']],
    ['backend', ['src/runtime/task.ts', 'bin/tool.js', 'scripts/check.js', 'tests/unit/check.ts', 'jest.config.js', 'tsconfig.test.json'], ['backend']],
    ['contracts', ['src/contracts/api.ts'], ['backend', 'ui', 'browser']],
    ['schemas', ['src/schemas/api.ts'], ['backend', 'ui', 'browser']],
    ['web', ['web/src/view.vue'], ['ui', 'browser']],
    ['Playwright-only', ['tests/playwright/smoke/example.spec.ts'], ['ui', 'browser']],
    ...['package.json', 'package-lock.json', 'web/package.json', 'web/package-lock.json'].map((file) => [file, [file], ['backend', 'ui', 'browser', 'package_or_workflow']]),
    ['workflow', ['.github/workflows/example.yml'], all],
    ['unknown', ['unknown.txt'], all],
    ['mixed docs/unknown', ['docs/page.md', 'unknown.txt'], all],
  ])('classifies %s committed paths', (_label, paths, expected) => classify(paths, expected));

  it.each([
    ['zero base', { base: '0'.repeat(40) }], ['missing base', { base: '' }],
    ['missing head', { head: '' }], ['unavailable base', { base: 'f'.repeat(40) }],
    ['unavailable head', { head: 'f'.repeat(40) }], ['failed diff', { failDiff: true }],
  ])('promotes all gates for %s', (_label, options) => classify(['docs/page.md'], all, options));

  it('admits selected successes and unselected skips', () => {
    aggregate();
    aggregate(Object.fromEntries(PATH_JOBS.flatMap(([, prefix]) => [[`${prefix}_APPLIES`, 'true'], [`${prefix}_RESULT`, 'success']])));
    aggregate({ BACKEND_APPLIES: 'true', BACKEND_RESULT: 'success' });
  });
  it.each(['CLASSIFIER_RESULT', 'ROUTINE_RESULT'])('rejects failed %s', (name) => {
    aggregate({ [name]: 'failure', expectedStatus: 1 });
  });
  it.each(PATH_JOBS)('enforces %s result admission', (_job, prefix) => {
    for (const result of ['failure', 'cancelled', 'skipped']) aggregate({ [`${prefix}_APPLIES`]: 'true', [`${prefix}_RESULT`]: result, expectedStatus: 1 });
    for (const result of ['success', 'failure', 'cancelled']) aggregate({ [`${prefix}_RESULT`]: result, expectedStatus: 1 });
  });
});

function mutateWorkflow(search, replacement = '') {
  expect(VALID_WORKFLOW).toContain(search);
  return VALID_WORKFLOW.replace(search, replacement);
}

function packageJson({ scripts = PACKAGE_SCRIPTS, ignorePatterns = JEST_IGNORE_PATTERNS } = {}) {
  return JSON.stringify({
    engines: { node: '>=24 <25', npm: '>=10 <12' },
    scripts,
    jest: { testPathIgnorePatterns: ignorePatterns },
  });
}

function expectPackageFailure(packageJsonText, expected) {
  withFixture(validFiles({ 'package.json': packageJsonText }), (root) => {
    const result = verifyValidationCadence({ root });
    expect(result.ok).toBe(false);
    expect(result.failures).toContainEqual(expect.stringContaining(expected));
  });
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
    'README.md': '```bash\nnpm run docs:verify\nnpm run typecheck\nnpm run build\nnpm test\nnpm run test:terminal-child\nnpm run web:test:operator-smoke\n```\n' + VALID_PROFILE_DOCS + VALID_PLAYWRIGHT_DOCS,
    'web/package.json': WEB_PACKAGE_JSON,
    'docs/architecture/system-architecture.md': 'Run Saivage with Node.js 24; package.json engines require `node >=24 <25` and `npm >=10 <12`, matching CI.\nCanonical commands include `npm run web:test:analyst-ui` and `npm run web:test:operator-smoke`.\n```bash\nnpm run docs:build\nnpm run web:test:sweep\n```\n' + VALID_PROFILE_DOCS,
    '.github/workflows/validation.yml': VALID_WORKFLOW,
    'scripts/docs-verify.sh': VALID_DOCS_VERIFY,
    'scripts/check-existing.js': '#!/usr/bin/env node\n',
    'scripts/check-dependency-freshness.js': '#!/usr/bin/env node\n',
    'scripts/check-export-consumers.js': '#!/usr/bin/env node\n',
    'tests/existing.test.js': 'test("ok", () => {});\n',
    'tests/playwright/smoke/playwright.config.ts': "testDir: '.'\ntestMatch: /.*\\.spec\\.ts/\n",
    'tests/playwright/smoke/preview.spec.ts': 'test();\n',
    'tests/playwright/browser-client/chat-api-client-browser.config.ts': "testDir: '.'\ntestMatch: /(^|\\/)chat-api-client-browser\\.spec\\.ts$/\n",
    'tests/playwright/browser-client/client.spec.ts': 'test();\n',
    ...overrides,
  };
}

describe('validation cadence guard', () => {
  it('allows representation changes and independent check ordering without changing shell decisions', () => {
    const workflow = parse(VALID_WORKFLOW);
    const classifier = workflow.jobs['classify-changes'];
    classifier.outputs = Object.fromEntries(Object.entries(classifier.outputs).reverse());
    const classifyStep = classifier.steps.find((step) => step.id === 'classify');
    classifyStep.run = classifyStep.run.replaceAll('recognized', 'known_path').replaceAll('classify_file', 'select_path')
      .replace('changed-file classification completed', 'path selection finished').replace('### Validation path classification', '### Paths');
    const required = workflow.jobs['validation-required'];
    required.needs.reverse();
    required.steps[0].env = Object.fromEntries(Object.entries(required.steps[0].env).reverse());
    required.steps[0].run = required.steps[0].run.replaceAll('require_success', 'check_success').replaceAll('require_applicable', 'check_selected')
      .replace('### Required validation aggregate', '### Conclusions');
    for (const name of ['routine-docs', 'backend-jest-build', 'browser-smoke']) {
      const steps = workflow.jobs[name].steps;
      const root = steps.findIndex((step) => step.run === 'npm ci');
      const web = steps.findIndex((step) => step.run === 'cd web && npm ci');
      [steps[root], steps[web]] = [steps[web], steps[root]];
    }
    const browser = workflow.jobs['browser-smoke'].steps;
    const chromium = browser.findIndex((step) => step.run === 'npm run web:test:e2e:install');
    const deps = browser.findIndex((step) => step.run === 'npx playwright install-deps chromium');
    [browser[chromium], browser[deps]] = [browser[deps], browser[chromium]];
    browser.splice(browser.length - 1, 0, { name: 'Harmless note', run: 'echo complete' });
    browser.at(-1).with.path = 'tmp/playwright-results\ntmp/playwright-report\n';
    workflow.jobs['backend-e2e'].steps.splice(2, 0, { run: 'echo setup' });
    const scripts = { ...PACKAGE_SCRIPTS };
    for (const name of ['validate:routine', 'test:import-boundaries', 'lint', 'validate:release']) scripts[name] = scripts[name].split(' && ').reverse().join(' && ');
    const files = validFiles({ 'package.json': packageJson({ scripts, ignorePatterns: [...JEST_IGNORE_PATTERNS].reverse() }),
      '.github/workflows/validation.yml': stringify(workflow) });
    files['README.md'] += '\nValidation documentation may explain these commands in fresh wording.\n';
    files['docs/architecture/system-architecture.md'] = files['docs/architecture/system-architecture.md'].split('\n').slice(1).join('\n');
    withFixture(files, (root) => expect(verifyValidationCadence({ root }).failures).toEqual([]));
    classify(['tests/playwright/smoke/example.spec.ts'], ['ui', 'browser'], { workflow: stringify(workflow) });
    aggregate({ BACKEND_E2E_APPLIES: 'true', BACKEND_E2E_RESULT: 'failure', expectedStatus: 1 }, stringify(workflow));
  });

  it('rejects backend E2E cached Node setup before checkout even when both precede root install', () => {
    const workflow = parse(VALID_WORKFLOW);
    const steps = workflow.jobs['backend-e2e'].steps;
    [steps[0], steps[1]] = [steps[1], steps[0]];
    expectWorkflowFailure(stringify(workflow), 'backend-e2e must run checkout before cached Node setup');
  });

  it.each([
    ['routine-docs', 'npm ci', 'npm run validate:routine'],
    ['backend-e2e', 'npm ci', 'npm run test:e2e'],
    ['backend-jest-build', 'npm ci', 'npm test'],
    ['browser-smoke', 'npm run web:test:e2e:install', 'npm run web:test:e2e:smoke'],
    ['browser-smoke', 'npx playwright install-deps chromium', 'npm run web:test:e2e:smoke'],
  ])('rejects %s running %s after %s', (job, prerequisite, consumer) => {
    const workflow = parse(VALID_WORKFLOW);
    const steps = workflow.jobs[job].steps;
    const first = steps.findIndex((step) => step.run === prerequisite);
    const second = steps.findIndex((step) => step.run === consumer);
    [steps[first], steps[second]] = [steps[second], steps[first]];
    expectWorkflowFailure(stringify(workflow), `${job} must run ${prerequisite} before ${consumer}`);
  });

  it('rejects install before Node setup', () => {
    const workflow = parse(VALID_WORKFLOW);
    const steps = workflow.jobs['backend-e2e'].steps;
    [steps[1], steps[2]] = [steps[2], steps[1]];
    expectWorkflowFailure(stringify(workflow), 'backend-e2e must run Node setup before npm ci');
  });

  it('rejects artifact upload before smoke', () => {
    const workflow = parse(VALID_WORKFLOW);
    const steps = workflow.jobs['browser-smoke'].steps;
    [steps[steps.length - 1], steps[steps.length - 2]] = [steps[steps.length - 2], steps[steps.length - 1]];
    expectWorkflowFailure(stringify(workflow), 'browser artifact upload must follow the browser smoke command');
  });
  it('passes when documented validation commands, workflow commands, dependency hygiene, and docs:verify sub-guards resolve', () => {
    withFixture(validFiles(), (root) => {
      const result = verifyValidationCadence({ root });
      expect(result.ok).toBe(true);
      expect(result.failures).toEqual([]);
      expect(result.requiredValidationScriptsChecked).toContain('package.json script web:test:operator-smoke');
      expect(result.requiredValidationScriptsChecked).toContain('package.json script audit:security');
      expect(result.requiredValidationScriptsChecked).toContain('package.json script deps:review');
      expect(result.validationWorkflowContractEntriesChecked).toContain('.github/workflows/validation.yml path-aware dependency audit gate');
      expect(result.workflowCommandsChecked).toContainEqual(expect.stringContaining('npm run validate:routine'));
      expect(result.workflowCommandsChecked).toContainEqual(expect.stringContaining('npm run audit:security'));
      expect(result.validationProfilesChecked).toContain('package.json profile validate:release');
      expect(result.exportConsumerCadenceEntriesChecked).toContain('package.json singular lint import-boundary delegation');
      expect(result.canonicalWebTestNamespaceEntriesChecked).toContain('package.json singular canonical web-test namespace');
      expect(result.runtimeEngineEntriesChecked).toContain('package.json engines');
      expect(result.runtimeEngineEntriesChecked).toContain('web/package.json engines');
      expect(result.docsVerifyEntriesChecked).toContain('scripts/docs-verify.sh:4 node-script scripts/check-existing.js');
      expect(result.failClosedJestGateEntriesChecked).toContain('package.json script test');
      expect(result.terminalChildJestContractEntriesChecked).toContain('package.json exact ordinary Jest ignore array');
      expect(PACKAGE_JSON).toContain('app-terminal-child-process\\\\.test\\\\.ts$');
      expect(JSON.parse(PACKAGE_JSON).jest.testPathIgnorePatterns).toContain(TERMINAL_CHILD_IGNORE_REGEX);
    });
  });

  describe('export-consumer cadence mutations', () => {
    it.each([
      ['drops the validate:routine edge', PACKAGE_SCRIPTS['validate:routine'].replace(' && npm run check:export-consumers', '')],
      ['drops routine architecture coverage', PACKAGE_SCRIPTS['validate:routine'].replace(' && npm run test:direct -- --runInBand tests/architecture', '')],
      ['duplicates the routine docs gate', `${PACKAGE_SCRIPTS['validate:routine']} && npm run docs:verify`],
      ['breaks routine failure propagation', PACKAGE_SCRIPTS['validate:routine'].replace(' && ', ' ; ')],
    ])('rejects a package that %s', (_label, command) => {
      expectPackageFailure(packageJson({ scripts: { ...PACKAGE_SCRIPTS, 'validate:routine': command } }), 'validate:routine" must run each required command exactly once');
    });

    it.each([
      ['drops the lint edge', PACKAGE_SCRIPTS.lint.replace('npm run check:export-consumers && ', '')],
    ])('rejects a package that %s', (_label, command) => {
      expectPackageFailure(packageJson({ scripts: { ...PACKAGE_SCRIPTS, lint: command } }), 'lint" must invoke npm run check:export-consumers');
    });

    it('rejects a drifted checker script edge', () => {
      expectPackageFailure(packageJson({ scripts: { ...PACKAGE_SCRIPTS, 'check:export-consumers': 'node scripts/other.js' } }), 'check:export-consumers" must be exactly');
    });
  });

  describe('import-boundary command mutations', () => {
    it.each([
      ['drops the self-test', PACKAGE_SCRIPTS['test:import-boundaries'].replace('node scripts/check-import-boundaries.cjs --self-test && ', '')],
      ['drops the subprocess regressions', PACKAGE_SCRIPTS['test:import-boundaries'].replace('node --test tests/scripts/import-boundary-ratchet.test.cjs && ', '')],
      ['drops repository admission', PACKAGE_SCRIPTS['test:import-boundaries'].replace(' && node scripts/check-import-boundaries.cjs', '')],
      ['duplicates repository admission', `${PACKAGE_SCRIPTS['test:import-boundaries']} && node scripts/check-import-boundaries.cjs`],
      ['breaks failure propagation', PACKAGE_SCRIPTS['test:import-boundaries'].replace(' && ', ' ; ')],
    ])('rejects a focused command that %s', (_label, command) => {
      expectPackageFailure(packageJson({ scripts: { ...PACKAGE_SCRIPTS, 'test:import-boundaries': command } }), 'test:import-boundaries" must run the three required commands');
    });

    it('rejects lint without the focused delegation', () => {
      const lint = PACKAGE_SCRIPTS.lint.replace('npm run test:import-boundaries', 'node scripts/check-import-boundaries.cjs');
      expectPackageFailure(packageJson({ scripts: { ...PACKAGE_SCRIPTS, lint } }), 'must delegate exactly once');
    });

    it('rejects lint with a duplicate direct checker invocation', () => {
      const lint = PACKAGE_SCRIPTS.lint.replace('npm run test:import-boundaries', 'npm run test:import-boundaries && node scripts/check-import-boundaries.cjs');
      expectPackageFailure(packageJson({ scripts: { ...PACKAGE_SCRIPTS, lint } }), 'must delegate exactly once');
    });

  });

  describe('terminal-child Jest ownership mutations', () => {
    const ignoreMutations = [
      ['a missing ordinary exclusion', JEST_IGNORE_PATTERNS.slice(0, 2), 'ordinary terminal-child exclusion'],
      ['the revision-1 unescaped path-looking exclusion', [...JEST_IGNORE_PATTERNS.slice(0, 2), '<rootDir>/tests/boot/app-terminal-child-process.test.ts$'], 'ordinary terminal-child exclusion'],
      ['an exclusion without the end anchor', [...JEST_IGNORE_PATTERNS.slice(0, 2), String.raw`<rootDir>/tests/boot/app-terminal-child-process\.test\.ts`], 'ordinary terminal-child exclusion'],
      ['a boot-directory exclusion', [...JEST_IGNORE_PATTERNS.slice(0, 2), '<rootDir>/tests/boot/'], 'ordinary terminal-child exclusion'],
      ['a wildcard filename exclusion', [...JEST_IGNORE_PATTERNS.slice(0, 2), String.raw`<rootDir>/tests/boot/app-terminal-child-process.*`], 'ordinary terminal-child exclusion'],
      ['a broader exclusion alongside the canonical exclusion', [...JEST_IGNORE_PATTERNS, '<rootDir>/tests/boot/'], 'ordinary Jest ignore array'],
      ['a duplicate canonical exclusion', [...JEST_IGNORE_PATTERNS, TERMINAL_CHILD_IGNORE_REGEX], 'duplicate canonical entries'],
    ];

    it.each(ignoreMutations)('rejects %s', (_label, ignorePatterns, expected) => {
      expectPackageFailure(packageJson({ ignorePatterns }), expected);
    });

    const dedicatedMutations = [
      ['a dropped dedicated path', TERMINAL_CHILD_COMMAND.replace(TERMINAL_CHILD_PATH, ''), 'positively own exactly'],
      ['a broadened dedicated path', TERMINAL_CHILD_COMMAND.replace(TERMINAL_CHILD_PATH, 'tests/boot/'), 'positively own exactly'],
      ['a dropped --runTestsByPath owner', TERMINAL_CHILD_COMMAND.replace('--runTestsByPath ', ''), 'through --runTestsByPath'],
      ['a dropped --runInBand serialization flag', TERMINAL_CHILD_COMMAND.replace('--runInBand ', ''), 'serialize its exact suite'],
      ['a dropped Playwright/E2E ignore override', TERMINAL_CHILD_COMMAND.replace(" --testPathIgnorePatterns='<rootDir>/tests/(playwright|e2e)/'", ''), 'override testPathIgnorePatterns'],
      ['a permissive no-tests flag', `${TERMINAL_CHILD_COMMAND} --passWithNoTests`, 'dedicated owner must fail'],
    ];

    it.each(dedicatedMutations)('rejects %s', (_label, command, expected) => {
      expectPackageFailure(packageJson({ scripts: { ...PACKAGE_SCRIPTS, 'test:terminal-child': command } }), expected);
    });

    const compositionMutations = [
      ['the ordinary phase', 'npm run test:terminal-child'],
      ['the terminal-child phase', 'npm run test:parallel'],
      ['the required phase order', 'npm run test:terminal-child && npm run test:parallel'],
    ];

    it.each(compositionMutations)('rejects root composition without %s', (_label, test) => {
      expectPackageFailure(packageJson({ scripts: { ...PACKAGE_SCRIPTS, test } }), 'must compose exactly');
    });

    it('rejects serialization of the ordinary Jest phase', () => {
      expectPackageFailure(packageJson({ scripts: { ...PACKAGE_SCRIPTS, 'test:parallel': `${PACKAGE_SCRIPTS['test:parallel']} --runInBand` } }), 'must retain Jest default worker parallelism');
    });

    it('rejects positive terminal-child selection by the ordinary Jest phase', () => {
      expectPackageFailure(packageJson({ scripts: { ...PACKAGE_SCRIPTS, 'test:parallel': `${PACKAGE_SCRIPTS['test:parallel']} ${TERMINAL_CHILD_PATH}` } }), 'must not positively select');
    });

    it('rejects a second positive package owner for the terminal-child path', () => {
      expectPackageFailure(packageJson({ scripts: { ...PACKAGE_SCRIPTS, 'test:terminal-child-alias': TERMINAL_CHILD_COMMAND } }), 'exactly one positive package owner');
    });

    it('rejects release invoking a backend Jest subphase independently', () => {
      const release = `${PACKAGE_SCRIPTS['validate:release']} && npm run test:terminal-child`;
      expectPackageFailure(packageJson({ scripts: { ...PACKAGE_SCRIPTS, 'validate:release': release } }), 'must invoke singular npm test exactly once');
    });

    it.each([
      ['omits backend E2E', PACKAGE_SCRIPTS['validate:release'].replace(' && npm run test:e2e', '')],
      ['runs backend E2E twice', PACKAGE_SCRIPTS['validate:release'].replace('npm run test:e2e', 'npm run test:e2e && npm run test:e2e')],
    ])('rejects release when it %s', (_label, release) => {
      expectPackageFailure(packageJson({ scripts: { ...PACKAGE_SCRIPTS, 'validate:release': release } }), 'must invoke npm run test:e2e exactly once');
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

  it('rejects a reintroduced package test:web alias independently of documentation', () => {
    const scripts = { ...PACKAGE_SCRIPTS, 'test:web:operator-smoke': 'npm run web:test:operator-smoke' };
    expectPackageFailure(packageJson({ scripts }), 'package.json must not define forbidden test:web* script keys: test:web:operator-smoke');
  });

  it.each([
    ['README.md', 'Current inline guidance: `npm run test:web:operator-smoke`.\n'],
    ['docs/architecture/system-architecture.md', '```bash\nnpm run test:web:operator-smoke\n```\n'],
  ])('rejects a documented test:web alias in %s without a package alias', (file, reference) => {
    const current = validFiles()[file];
    withFixture(validFiles({ [file]: `${current}\n${reference}` }), (root) => {
      const result = verifyValidationCadence({ root });
      expect(result.ok).toBe(false);
      expect(result.failures).toContainEqual(expect.stringMatching(new RegExp(`^${file.replaceAll('.', '\\.')}:\\d+ documents forbidden npm script namespace "test:web:operator-smoke"`)));
    });
  });

  it('fails clearly when dependency hygiene scripts are missing', () => {
    const { 'audit:security': _auditSecurity, ...scripts } = PACKAGE_SCRIPTS;
    withFixture(validFiles({ 'package.json': JSON.stringify({ engines: { node: '>=24 <25', npm: '>=10 <12' }, scripts }) }), (root) => {
      const result = verifyValidationCadence({ root });
      expect(result.ok).toBe(false);
      expect(result.failures).toContain('package.json is missing required validation script "audit:security" (combined dependency security gate)');
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
      ['event dispatch remnant', '          base=', '          echo pull_request\n          base=', 'obsolete event/backstop token pull_request'],
      ['push event-selection dispatch', '          base=', "          if [[ \"\${{ github.event_name }}\" == push ]]; then :; fi\n          base=", 'must not contain event-selection dispatch'],
      ['obsolete backstop', 'jobs:\n', 'jobs:\n  scheduled-release-backstop: {}\n', 'obsolete event/backstop token scheduled-release-backstop'],
    ];
    for (const output of ['backend', 'ui', 'browser', 'docs_only', 'package_or_workflow', 'run_all', 'summary']) {
      mutations.push([`${output} declared output`, `      ${output}: \${{ steps.classify.outputs.${output} }}\n`, '', 'publish exactly']);
    }

    it.each(mutations)('rejects mutation of %s', (_label, search, replacement, expected) => {
      expectWorkflowFailure(mutateWorkflow(search, replacement), expected);
    });
  });

  describe('complete aggregate mutations', () => {
    const pathJobs = PATH_JOBS;
    const mutations = [
      ...['classify-changes', 'routine-docs', ...pathJobs.map(([name]) => name)].map((name) => [`remove need ${name}`, `      - ${name}\n`, '', 'needs must contain exactly']),
      ...['classify-changes', 'routine-docs', ...pathJobs.map(([name]) => name)].map((name) => [`rename need ${name}`, `      - ${name}\n`, `      - ${name}-renamed\n`, 'needs must contain exactly']),
      ['extra need', '      - dependency-hygiene\n', '      - dependency-hygiene\n      - extra-job\n', 'needs must contain exactly'],
      ['always', '    if: \${{ always() }}', '    if: \${{ success() }}', 'must retain if'],
      ['classifier result', '          CLASSIFIER_RESULT: \${{ needs.classify-changes.result }}', '          CLASSIFIER_RESULT: wrong', 'CLASSIFIER_RESULT must be exactly'],
      ['routine result', '          ROUTINE_RESULT: \${{ needs.routine-docs.result }}', '          ROUTINE_RESULT: wrong', 'ROUTINE_RESULT must be exactly'],
      ['classifier summary ref', '          CLASSIFIER_SUMMARY: \${{ needs.classify-changes.outputs.summary }}', '          CLASSIFIER_SUMMARY: wrong', 'CLASSIFIER_SUMMARY must be exactly'],
      ['obsolete event state', '          CLASSIFIER_RESULT:', '          EVENT_NAME: pull_request\n          CLASSIFIER_RESULT:', 'obsolete event/backstop token pull_request'],
    ];
    for (const [job, prefix] of pathJobs) {
      const header = `  ${job}:\n    name: ${job}\n    runs-on: ubuntu-latest\n    needs: classify-changes`;
      mutations.push(
        [`${job} classifier dependency`, header, header.replace('needs: classify-changes', 'needs: routine-docs'), 'must depend exactly'],
        [`${job} job applicability`, `${header}\n    if:`, `${header}\n    if: \${{ false }} #`, 'must use exact push path applicability'],
        [`${job} result env`, `          ${prefix}_RESULT: \${{ needs.${job}.result }}`, `          ${prefix}_RESULT: wrong`, `${prefix}_RESULT must be exactly`],
        [`${job} applies env`, `          ${prefix}_APPLIES:`, `          ${prefix}_APPLIES: \${{ false }} #`, `${prefix}_APPLIES must match`],
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

  describe('routine job command mutations', () => {
    const routineMutations = [
      ['omitted routine web install', '      - name: Install dependencies\n        run: npm ci\n\n      - name: Install web dependencies\n        run: cd web && npm ci\n\n      - name: Routine validation profile', '      - name: Install dependencies\n        run: npm ci\n\n      - name: Routine validation profile', 'routine-docs must run cd web && npm ci'],
      ['misordered routine web install', '      - name: Install web dependencies\n        run: cd web && npm ci\n\n      - name: Routine validation profile\n        run: npm run validate:routine', '      - name: Routine validation profile\n        run: npm run validate:routine\n\n      - name: Install web dependencies\n        run: cd web && npm ci', 'routine-docs must run cd web && npm ci before npm run validate:routine'],
    ];

    it.each(routineMutations)('rejects %s', (_label, search, replacement, expected) => {
      expectWorkflowFailure(mutateWorkflow(search, replacement), expected);
    });
  });

  describe('backend, browser, artifact, and Playwright ownership mutations', () => {
    const workflowMutations = [
      ['omitted backend web install', '      - name: Install web dependencies\n        run: cd web && npm ci\n\n      - name: Build project', '      - name: Build project', 'backend-jest-build must run cd web && npm ci'],
      ['misordered backend web install', '      - name: Install web dependencies\n        run: cd web && npm ci\n\n      - name: Build project\n        run: npm run build', '      - name: Build project\n        run: npm run build\n\n      - name: Install web dependencies\n        run: cd web && npm ci', 'backend-jest-build must run cd web && npm ci before npm run build'],
      ['omitted backend E2E command', '      - name: Backend E2E suite\n        run: npm run test:e2e\n', '', 'backend-e2e must run npm run test:e2e'],
      ['changed browser install command', '        run: npm run web:test:e2e:install', '        run: playwright install chromium', 'browser-smoke must run npm run web:test:e2e:install'],
      ['live suite enters CI', '        run: npm run web:test:e2e:smoke', '        run: npm run web:test:e2e:smoke && npm run web:test:live-getrich-v2', 'must exclude the external live GetRich v2 suite'],
      ['wrong artifact condition', '        if: ${{ failure() || cancelled() }}', '        if: ${{ failure() }}', 'condition must be exactly failure() || cancelled()'],
      ['wrong artifact path', '            tmp/playwright-results', '            tmp/other-results', 'upload paths must be exactly'],
    ];

    it.each(workflowMutations)('rejects %s', (_label, search, replacement, expected) => {
      expectWorkflowFailure(mutateWorkflow(search, replacement), expected);
    });

    it('rejects a Playwright spec outside every positive owner', () => {
      withFixture(validFiles({ 'tests/playwright/unowned.spec.ts': 'test();\n' }), (root) => {
        const result = verifyValidationCadence({ root });
        expect(result.failures).toContainEqual(expect.stringContaining('has no positive suite owner'));
      });
    });

    it('rejects broad Playwright discovery instead of exact command-to-config mapping', () => {
      const scripts = { ...PACKAGE_SCRIPTS, 'web:test:e2e:preview-smoke': 'playwright test -c tests/playwright' };
      withFixture(validFiles({ 'package.json': JSON.stringify({ engines: { node: '>=24 <25', npm: '>=10 <12' }, scripts }) }), (root) => {
        const result = verifyValidationCadence({ root });
        expect(result.failures).toContainEqual(expect.stringContaining('must map exactly'));
      });
    });

    it('rejects a config that broadens discovery outside its positive owner', () => {
      withFixture(validFiles({ 'tests/playwright/smoke/playwright.config.ts': "testDir: '..'\ntestMatch: /.*\\.spec\\.ts/\n" }), (root) => {
        const result = verifyValidationCadence({ root });
        expect(result.failures).toContainEqual(expect.stringContaining('must positively own its exact directory'));
      });
    });

    it('rejects a missing positive owner command', () => {
      const { 'web:test:e2e:browser-client-smoke': _missing, ...scripts } = PACKAGE_SCRIPTS;
      withFixture(validFiles({ 'package.json': JSON.stringify({ engines: { node: '>=24 <25', npm: '>=10 <12' }, scripts }) }), (root) => {
        const result = verifyValidationCadence({ root });
        expect(result.failures).toContainEqual(expect.stringContaining('web:test:e2e:browser-client-smoke'));
      });
    });

    it('rejects a composite smoke that drops a self-contained owner', () => {
      const scripts = { ...PACKAGE_SCRIPTS, 'web:test:e2e:smoke': 'npm run web:test:e2e:preview-smoke' };
      withFixture(validFiles({ 'package.json': JSON.stringify({ engines: { node: '>=24 <25', npm: '>=10 <12' }, scripts }) }), (root) => {
        const result = verifyValidationCadence({ root });
        expect(result.failures).toContainEqual(expect.stringContaining('must compose exactly the two self-contained profiles'));
      });
    });

    it('rejects the live profile entering the composite smoke', () => {
      const scripts = { ...PACKAGE_SCRIPTS, 'web:test:e2e:smoke': 'npm run web:test:e2e:preview-smoke && npm run web:test:e2e:browser-client-smoke && npm run web:test:live-getrich-v2' };
      withFixture(validFiles({ 'package.json': JSON.stringify({ engines: { node: '>=24 <25', npm: '>=10 <12' }, scripts }) }), (root) => {
        const result = verifyValidationCadence({ root });
        expect(result.failures).toContainEqual(expect.stringContaining('must exclude the external live GetRich v2 suite'));
      });
    });


    it('rejects a deleted pre-move README spec path', () => {
      const readme = validFiles()['README.md'].replace('tests/playwright/smoke/preview.spec.ts', 'tests/playwright/preview.spec.ts');
      withFixture(validFiles({ 'README.md': readme }), (root) => {
        const result = verifyValidationCadence({ root });
        expect(result.failures).toContainEqual(expect.stringContaining('references nonexistent Playwright path tests/playwright/preview.spec.ts'));
      });
    });

  });

  it('fails clearly when the operator smoke script stops targeting the smoke test', () => {
    const packageWithDriftedSmoke = JSON.stringify({ scripts: { ...PACKAGE_SCRIPTS, 'web:test:operator-smoke': 'cd web && npx vitest run src/__tests__/dashboard-view.test.ts' } });
    withFixture(validFiles({ 'package.json': packageWithDriftedSmoke }), (root) => {
      const result = verifyValidationCadence({ root });
      expect(result.ok).toBe(false);
      expect(result.failures).toContain('package.json script "web:test:operator-smoke" must run operator-cockpit-smoke.test.ts, but is currently: cd web && npx vitest run src/__tests__/dashboard-view.test.ts');
    });
  });
});
