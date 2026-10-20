#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LineCounter, parseDocument } from 'yaml';

const DEFAULT_DOCUMENTED_COMMAND_FILES = [
  'README.md',
  'docs/validation.md',
  'docs/architecture/system-architecture.md',
];

const DEFAULT_WORKFLOW_DIRS = ['.github/workflows'];

const REQUIRED_WORKFLOW_PROFILES = ['validate:routine'];

const EXPECTED_NODE_MAJOR = '24';
const EXPECTED_NODE_ENGINE = '>=24 <25';
const EXPECTED_NPM_ENGINE = '>=10 <12';
const PASS_WITH_NO_TESTS_FLAG = '--passWithNoTests';
const ROOT_TEST_COMMAND = 'npm run test:parallel && npm run test:terminal-child';
const PARALLEL_TEST_COMMAND = 'NODE_OPTIONS=--experimental-vm-modules jest';
const TERMINAL_CHILD_TEST_PATH = 'tests/boot/app-terminal-child-process.test.ts';
const TERMINAL_CHILD_IGNORE_REGEX = String.raw`<rootDir>/tests/boot/app-terminal-child-process\.test\.ts$`;
const JEST_IGNORE_PATTERNS = [
  '<rootDir>/tests/playwright/',
  '<rootDir>/tests/e2e/',
  TERMINAL_CHILD_IGNORE_REGEX,
];
const TERMINAL_CHILD_TEST_COMMAND = `NODE_OPTIONS=--experimental-vm-modules node ./node_modules/jest/bin/jest.js --runInBand --runTestsByPath ${TERMINAL_CHILD_TEST_PATH} --testPathIgnorePatterns='<rootDir>/tests/(playwright|e2e)/'`;
const EXPORT_CONSUMER_COMMAND = 'npm run check:export-consumers';
const EXPORT_CONSUMER_SCRIPT = 'node scripts/check-export-consumers.js';
const IMPORT_BOUNDARY_COMMAND = 'npm run test:import-boundaries';
const IMPORT_BOUNDARY_SCRIPT = 'node scripts/check-import-boundaries.cjs';
const IMPORT_BOUNDARY_TEST_COMMAND = `${IMPORT_BOUNDARY_SCRIPT} --self-test && node --test tests/scripts/import-boundary-ratchet.test.cjs && ${IMPORT_BOUNDARY_SCRIPT}`;
const PLAYWRIGHT_SUITE_OWNERS = [
  ['preview smoke', 'tests/playwright/smoke', 'tests/playwright/smoke/playwright.config.ts', 'web:test:e2e:preview-smoke', String.raw`testMatch: /.*\.spec\.ts/`],
  ['browser-client smoke', 'tests/playwright/browser-client', 'tests/playwright/browser-client/chat-api-client-browser.config.ts', 'web:test:e2e:browser-client-smoke', String.raw`testMatch: /(^|\/)chat-api-client-browser\.spec\.ts$/`],
];


const REQUIRED_VALIDATION_SCRIPTS = [
  {
    name: 'check:export-consumers',
    mustInclude: [EXPORT_CONSUMER_SCRIPT],
    description: 'complete repository semantic external-consumer guard',
  },
  {
    name: 'web:test:operator-smoke',
    mustInclude: ['operator-cockpit-smoke.test.ts'],
    description: 'direct operator-cockpit smoke guard',
  },
  {
    name: 'audit:root',
    mustInclude: ['npm audit --audit-level=high --omit=dev'],
    description: 'root dependency security gate',
    documentationOptional: true,
  },
  {
    name: 'audit:web',
    mustInclude: ['cd web && npm audit --audit-level=high --omit=dev'],
    description: 'web dependency security gate',
    documentationOptional: true,
  },
  {
    name: 'audit:security',
    mustInclude: ['npm run audit:root', 'npm run audit:web'],
    description: 'combined dependency security gate',
  },
  {
    name: 'audit:security:all',
    mustInclude: ['npm audit --audit-level=moderate', 'cd web && npm audit --audit-level=moderate'],
    description: 'full local dependency audit profile',
    documentationOptional: true,
  },
  {
    name: 'deps:freshness',
    mustInclude: ['node scripts/check-dependency-freshness.js'],
    description: 'dependency freshness and waiver integrity guard',
    documentationOptional: true,
  },
  {
    name: 'deps:review',
    mustInclude: ['npm run audit:security:all', 'npm run deps:freshness'],
    description: 'local dependency governance review',
  },
];

const REQUIRED_VALIDATION_PROFILES = [
  {
    name: 'validate:docs',
    mustInclude: ['npm run docs:verify'],
    mustNotInclude: ['web:test:operator-smoke', 'npm test'],
    description: 'docs-only validation profile',
  },
  {
    name: 'validate:routine',
    mustInclude: ['npm run typecheck', EXPORT_CONSUMER_COMMAND, 'npm run test:direct -- --runInBand tests/architecture', 'npm run docs:verify'],
    description: 'routine backend/runtime validation profile',
  },
  {
    name: 'validate:ui-smoke',
    mustInclude: ['npm run web:test:operator-smoke'],
    description: 'lightweight UI/operator smoke validation profile',
  },
  {
    name: 'validate:ui',
    mustInclude: ['npm run web:typecheck', 'npm run web:test', 'npm run web:test:operator-smoke'],
    description: 'UI/operator surface validation profile',
  },
  {
    name: 'validate:release',
    mustInclude: ['npm run typecheck', 'npm run build', 'npm test', 'npm run test:e2e', 'npm run web:test:operator-smoke', 'npm run docs:verify'],
    description: 'release sign-off validation profile',
  },
];

function stripEnvAssignments(command) {
  let remaining = command.trim();
  const envPattern = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s+/;
  while (envPattern.test(remaining)) {
    remaining = remaining.replace(envPattern, '').trim();
  }
  return remaining;
}

function normalizeCommandLine(line) {
  return line
    .replace(/\\\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function bashFenceCommands(markdown) {
  const commands = [];
  const fencePattern = /```(?:bash|sh|shell)\s*\n([\s\S]*?)```/gi;
  let match;
  while ((match = fencePattern.exec(markdown)) !== null) {
    const block = match[1];
    let pending = '';
    for (const rawLine of block.split('\n')) {
      const trimmed = rawLine.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }
      pending = pending ? `${pending} ${trimmed}` : trimmed;
      if (/\\\s*$/.test(trimmed)) {
        pending = pending.replace(/\\\s*$/, '').trim();
        continue;
      }
      commands.push(normalizeCommandLine(pending));
      pending = '';
    }
    if (pending) {
      commands.push(normalizeCommandLine(pending));
    }
  }
  return commands;
}

function inlineNpmRunCommands(markdown) {
  const commands = [];
  const inlinePattern = /`(npm\s+(?:run\s+)?(?:validate:[^`\s]+|web:test(?::[^`\s]+)?|test:web(?::[^`\s]+)?|docs:verify|typecheck|build|test)(?:\s+[^`]*)?)`/g;
  let match;
  while ((match = inlinePattern.exec(markdown)) !== null) {
    commands.push(normalizeCommandLine(match[1]));
  }
  return commands;
}

function validateForbiddenDocumentedWebTestNamespace({ root, files = DEFAULT_DOCUMENTED_COMMAND_FILES }) {
  const failures = [];
  const checked = [];
  const forbidden = (scriptName) => scriptName === 'test:web' || scriptName.startsWith('test:web:');

  for (const file of files) {
    const fullPath = path.join(root, file);
    if (!existsSync(fullPath)) continue;
    const markdown = readFileSync(fullPath, 'utf8');
    const lines = markdown.split('\n');
    let shellFence = false;
    let pending = '';
    let pendingLine = 0;

    const inspect = (command, line) => {
      for (const segment of splitCommandSegments(normalizeCommandLine(command))) {
        const scriptName = npmRunScriptName(segment);
        if (!scriptName || !forbidden(scriptName)) continue;
        checked.push(`${file}:${line} forbidden documented npm script ${scriptName}`);
        failures.push(`${file}:${line} documents forbidden npm script namespace "${scriptName}"; use the canonical web:test* namespace`);
      }
    };

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const trimmed = line.trim();
      if (/^```(?:bash|sh|shell)\s*$/i.test(trimmed)) {
        shellFence = true;
        pending = '';
        continue;
      }
      if (shellFence && /^```/.test(trimmed)) {
        if (pending) inspect(pending, pendingLine);
        shellFence = false;
        pending = '';
        continue;
      }
      if (shellFence && trimmed && !trimmed.startsWith('#')) {
        if (!pending) pendingLine = index + 1;
        pending = pending ? `${pending} ${trimmed}` : trimmed;
        if (!/\\\s*$/.test(trimmed)) {
          inspect(pending, pendingLine);
          pending = '';
        } else {
          pending = pending.replace(/\\\s*$/, '').trim();
        }
      }

      const inlinePattern = /`(npm\s+run\s+([^`\s]+)(?:\s+[^`]*)?)`/g;
      let match;
      while ((match = inlinePattern.exec(line)) !== null) {
        if (forbidden(match[2])) inspect(match[1], index + 1);
      }
    }
  }

  return { checked, failures };
}

function validateCanonicalWebTestNamespace({ scripts }) {
  const failures = [];
  const checked = ['package.json singular canonical web-test namespace'];
  const forbidden = Object.keys(scripts).filter((name) => name === 'test:web' || name.startsWith('test:web:'));
  if (forbidden.length > 0) {
    failures.push(`package.json must not define forbidden test:web* script keys: ${forbidden.join(', ')}`);
  }
  return { checked, failures };
}

function splitCommandSegments(command) {
  return command
    .split(/\s+(?:&&|;)\s+/)
    .map((segment) => stripEnvAssignments(segment))
    .filter(Boolean);
}

function readJsonFile(root, relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), 'utf8'));
}

function listFilesRecursively(root, relativeDirectory) {
  const directory = path.join(root, relativeDirectory);
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.join(relativeDirectory, entry.name).split(path.sep).join('/');
    if (entry.isDirectory()) return listFilesRecursively(root, relativePath);
    return entry.isFile() ? [relativePath] : [];
  }).sort();
}

function commandLocation(file, command) {
  return `${file}: ${command}`;
}

function resolveRepoPath(root, candidate) {
  const withoutQuotes = candidate.replace(/^['"]|['"]$/g, '');
  return path.resolve(root, withoutQuotes);
}

function isRunnableFile(root, candidate) {
  return existsSync(resolveRepoPath(root, candidate));
}

function checkNpmRun({ scripts, segment, location, failures }) {
  const runMatch = segment.match(/^npm\s+run\s+([^\s]+)/);
  const shorthandMatch = segment.match(/^npm\s+(test)(?:\s|$)/);
  const match = runMatch ?? shorthandMatch;
  if (!match) {
    return false;
  }
  const scriptName = match[1];
  if (scriptName.includes('*')) {
    return true;
  }
  if (!scripts[scriptName]) {
    failures.push(`${location} documents npm ${scriptName === 'test' ? 'test' : `run ${scriptName}`}, but package.json has no "${scriptName}" script`);
  }
  return true;
}

function checkDirectScript({ root, segment, location, failures }) {
  const nodeOrBash = segment.match(/^(?:node|bash)\s+([^\s]+)/);
  if (nodeOrBash) {
    const scriptPath = nodeOrBash[1];
    if (!isRunnableFile(root, scriptPath)) {
      failures.push(`${location} invokes ${scriptPath}, but that script file does not exist`);
    }
    return true;
  }

  const direct = segment.match(/^(\.\/(?:bin|scripts)\/[^\s]+)/);
  if (direct) {
    const scriptPath = direct[1];
    if (!isRunnableFile(root, scriptPath)) {
      failures.push(`${location} invokes ${scriptPath}, but that executable entry point does not exist`);
    }
    return true;
  }

  return false;
}

function validateDocumentedCommands({ root, files = DEFAULT_DOCUMENTED_COMMAND_FILES, scripts }) {
  const failures = [];
  const checked = [];

  for (const file of files) {
    const fullPath = path.join(root, file);
    if (!existsSync(fullPath)) {
      continue;
    }
    const markdown = readFileSync(fullPath, 'utf8');
    const commands = [...bashFenceCommands(markdown), ...inlineNpmRunCommands(markdown)];
    for (const command of commands) {
      for (const segment of splitCommandSegments(command)) {
        const location = commandLocation(file, segment);
        if (checkNpmRun({ scripts, segment, location, failures })) {
          checked.push(location);
          continue;
        }
        if (checkDirectScript({ root, segment, location, failures })) {
          checked.push(location);
        }
      }
    }
  }

  return { checked, failures };
}

function listWorkflowFiles(root, workflowDirs = DEFAULT_WORKFLOW_DIRS) {
  const files = [];
  for (const workflowDir of workflowDirs) {
    const fullDir = path.join(root, workflowDir);
    if (!existsSync(fullDir)) {
      continue;
    }
    for (const entry of readdirSync(fullDir, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.(?:ya?ml)$/i.test(entry.name)) {
        continue;
      }
      files.push(path.join(workflowDir, entry.name));
    }
  }
  return files.sort();
}


function lineNumberForPattern(content, pattern) {
  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (pattern.test(lines[index])) {
      return index + 1;
    }
  }
  return 1;
}

function isMapping(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateWorkflowPermissions({ workflow, locate, failures }) {
  const permissions = workflow.permissions;
  const location = locate(['permissions']);
  if (permissions === 'write-all' || permissions === 'read-all') {
    failures.push(`${location} must not use broad workflow permissions; use least-privilege contents: read`);
    return;
  }

  if (!isMapping(permissions)) {
    failures.push(`${location} must declare top-level least-privilege permissions with contents: read`);
    return;
  }

  if (permissions.contents !== 'read') {
    failures.push(`${location} permissions block must include contents: read`);
  }

  for (const [name, value] of Object.entries(permissions)) {
    if (value === 'write') failures.push(`${locate(['permissions', name])} permissions block must not request write permissions for validation`);
  }
}

function validateWorkflowConcurrency({ workflow, locate, failures }) {
  const concurrency = workflow.concurrency;
  const location = locate(['concurrency']);
  if (!isMapping(concurrency)) {
    failures.push(`${location} must declare top-level concurrency with a group and cancel-in-progress: true`);
    return;
  }
  if (typeof concurrency.group !== 'string' || !concurrency.group.trim()) {
    failures.push(`${location} concurrency block must include a stable group`);
  }
  if (concurrency['cancel-in-progress'] !== true) {
    failures.push(`${location} concurrency block must set cancel-in-progress: true`);
  }
}

function validateWorkflowSecretSafety({ file, content, failures }) {
  const disallowed = [
    { pattern: /\$\{\{\s*secrets\.|\bsecrets\./i, message: 'must not reference GitHub secrets in validation workflow' },
    { pattern: /\bSAIVAGE_API_TOKEN\b/, message: 'must not set or reference SAIVAGE_API_TOKEN in validation workflow' },
    { pattern: /^\s*[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|PASSWORD)[A-Z0-9_]*\s*[:=]/im, message: 'must not assign API key/token/password environment variables in validation workflow' },
    { pattern: /\becho\b[^\n]*(?:secret|token|password|api[_-]?key)/i, message: 'must not echo secret or token values in validation workflow' },
  ];
  for (const rule of disallowed) {
    if (rule.pattern.test(content)) {
      failures.push(`${file}:${lineNumberForPattern(content, rule.pattern)} ${rule.message}`);
    }
  }
}

function validateWorkflowCommands({ root, scripts, workflowFiles }) {
  const failures = [];
  const checked = [];
  const profileCommands = new Set();
  const contractChecked = [];
  const setupChecked = [];
  const files = workflowFiles ?? listWorkflowFiles(root);

  for (const file of files) {
    const fullPath = path.join(root, file);
    if (!existsSync(fullPath)) {
      failures.push(`workflow/template ${file} does not exist`);
      continue;
    }
    const content = readFileSync(fullPath, 'utf8');
    const lineCounter = new LineCounter();
    const document = parseDocument(content, { uniqueKeys: true, lineCounter });
    if (document.errors.length > 0) {
      for (const error of document.errors) {
        failures.push(`${file} has invalid YAML: ${error.message}`);
      }
      continue;
    }
    const workflow = document.toJS();
    const locate = (keys) => {
      const node = document.getIn(keys, true);
      return `${file}:${lineCounter.linePos(node?.range?.[0] ?? document.contents?.range?.[0] ?? 0).line}`;
    };
    validateWorkflowSecretSafety({ file, content, failures });
    validateValidationWorkflowContract({ file, content, workflow, locate, root, scripts,
      failures, checked: contractChecked, commandChecked: checked, setupChecked, profileCommands });
  }

  if (files.length === 0) {
    failures.push('no validation workflow/template found under .github/workflows; add CI automation or pass workflowFiles to the guard');
  }

  for (const required of REQUIRED_WORKFLOW_PROFILES) {
    if (!profileCommands.has(required)) {
      failures.push(`validation workflow/template must run npm run ${required}`);
    }
  }

  return { checked, failures, workflowFilesChecked: files, contractChecked, setupChecked };
}

function expressionBody(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const match = value.match(/^\s*\$\{\{([\s\S]*)\}\}\s*$/);
  return (match?.[1] ?? value).replace(/\s+/g, ' ').trim();
}

function workflowStepCommands(run) {
  const commands = [];
  let pending = '';
  for (const line of run.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    pending = pending ? `${pending} ${trimmed}` : trimmed;
    if (/\\\s*$/.test(trimmed)) {
      pending = pending.replace(/\\\s*$/, '').trim();
      continue;
    }
    commands.push(normalizeCommandLine(pending));
    pending = '';
  }
  if (pending) commands.push(normalizeCommandLine(pending));
  return commands;
}

function exactSet(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length
    && new Set(actual).size === actual.length && expected.every((value) => actual.includes(value));
}

const CLASSIFIER_OUTPUTS = {
  backend: '${{ steps.classify.outputs.backend }}',
  ui: '${{ steps.classify.outputs.ui }}',
  browser: '${{ steps.classify.outputs.browser }}',
  docs_only: '${{ steps.classify.outputs.docs_only }}',
  package_or_workflow: '${{ steps.classify.outputs.package_or_workflow }}',
  run_all: '${{ steps.classify.outputs.run_all }}',
  summary: '${{ steps.classify.outputs.summary }}',
};

const PATH_JOBS = {
  'backend-jest-build': {
    prefix: 'BACKEND',
    condition: "needs.classify-changes.outputs.run_all == 'true' || needs.classify-changes.outputs.backend == 'true' || needs.classify-changes.outputs.package_or_workflow == 'true'",
  },
  'backend-e2e': {
    prefix: 'BACKEND_E2E',
    condition: "needs.classify-changes.outputs.run_all == 'true' || needs.classify-changes.outputs.backend == 'true' || needs.classify-changes.outputs.package_or_workflow == 'true'",
  },
  'ui-vitest': {
    prefix: 'UI',
    condition: "needs.classify-changes.outputs.run_all == 'true' || needs.classify-changes.outputs.ui == 'true' || needs.classify-changes.outputs.browser == 'true' || needs.classify-changes.outputs.package_or_workflow == 'true'",
  },
  'browser-smoke': {
    prefix: 'BROWSER',
    condition: "needs.classify-changes.outputs.run_all == 'true' || needs.classify-changes.outputs.browser == 'true' || needs.classify-changes.outputs.package_or_workflow == 'true'",
  },
  'dependency-hygiene': {
    prefix: 'DEPENDENCY',
    condition: "needs.classify-changes.outputs.run_all == 'true' || needs.classify-changes.outputs.package_or_workflow == 'true'",
  },
  'lint-guards': {
    prefix: 'LINT_GUARDS',
    condition: "needs.classify-changes.outputs.run_all == 'true' || needs.classify-changes.outputs.backend == 'true' || needs.classify-changes.outputs.ui == 'true' || needs.classify-changes.outputs.package_or_workflow == 'true'",
  },
};

function validatePushOnlyTrigger({ file, workflow, failures, checked }) {
  checked.push(`${file} push-only master trigger`);
  const trigger = workflow?.on;
  const valid = trigger && typeof trigger === 'object' && !Array.isArray(trigger)
    && Object.keys(trigger).length === 1
    && trigger.push && typeof trigger.push === 'object' && !Array.isArray(trigger.push)
    && Object.keys(trigger.push).length === 1
    && Array.isArray(trigger.push.branches)
    && trigger.push.branches.length === 1
    && trigger.push.branches[0] === 'master';
  if (!valid) {
    failures.push(`${file} must use the exact push-only master trigger: on.push.branches: [master]`);
  }
}

function validateClassifier({ file, jobs, classifyStep, failures, checked }) {
  const job = jobs?.['classify-changes'];
  if (!job || typeof job !== 'object') {
    failures.push(`${file} validation workflow must define classify-changes`);
    return;
  }
  checked.push(`${file} classify-changes outputs`);
  if (!job.outputs || !exactSet(Object.keys(job.outputs), Object.keys(CLASSIFIER_OUTPUTS))
      || Object.entries(CLASSIFIER_OUTPUTS).some(([name, value]) => job.outputs[name] !== value)) {
    failures.push(`${file} classify-changes must publish exactly backend, ui, browser, docs_only, package_or_workflow, run_all, and summary from steps.classify.outputs`);
  }
  const shell = classifyStep?.run;
  if (typeof shell !== 'string') {
    failures.push(`${file} classify-changes must contain the inline classify shell step`);
    return;
  }
  checked.push(`${file} classifier has no event-selection dispatch`);
  if (/github\.event_name|inputs\.|github\.event\.pull_request/.test(shell)) {
    failures.push(`${file} classify-changes must not contain event-selection dispatch; every invocation is a push`);
  }
}

function validateAggregate({ file, jobs, enforceStep, failures, checked }) {
  const aggregate = jobs?.['validation-required'];
  if (!aggregate || typeof aggregate !== 'object') {
    failures.push(`${file} validation workflow must define validation-required`);
    return;
  }
  const expectedNeeds = ['classify-changes', 'routine-docs', ...Object.keys(PATH_JOBS)];
  checked.push(`${file} validation-required exact needs`);
  if (!exactSet(aggregate.needs, expectedNeeds)) {
    failures.push(`${file} validation-required needs must contain exactly ${expectedNeeds.join(', ')}`);
  }
  if (expressionBody(aggregate.if) !== 'always()') {
    failures.push(`${file} validation-required must retain if: \${{ always() }}`);
  }
  const env = enforceStep?.env;
  const shell = enforceStep?.run;
  if (!env || typeof env !== 'object' || typeof shell !== 'string') {
    failures.push(`${file} validation-required must contain its enforcement shell step and environment`);
    return;
  }
  const exactEnv = {
    CLASSIFIER_RESULT: '${{ needs.classify-changes.result }}',
    ROUTINE_RESULT: '${{ needs.routine-docs.result }}',
    CLASSIFIER_SUMMARY: '${{ needs.classify-changes.outputs.summary }}',
  };
  for (const [name, value] of Object.entries(exactEnv)) {
    checked.push(`${file} aggregate ${name}`);
    if (env[name] !== value) failures.push(`${file} validation-required ${name} must be exactly ${value}`);
  }
  for (const [jobName, contract] of Object.entries(PATH_JOBS)) {
    const job = jobs[jobName];
    checked.push(`${file} ${jobName} classifier dependency and applicability`);
    if (!job || job.needs !== 'classify-changes') failures.push(`${file} ${jobName} must depend exactly on classify-changes`);
    if (expressionBody(job?.if) !== contract.condition) failures.push(`${file} ${jobName} must use exact push path applicability: ${contract.condition}`);
    const resultName = `${contract.prefix}_RESULT`;
    const appliesName = `${contract.prefix}_APPLIES`;
    const expectedResult = `\${{ needs.${jobName}.result }}`;
    if (env[resultName] !== expectedResult) failures.push(`${file} validation-required ${resultName} must be exactly ${expectedResult}`);
    if (expressionBody(env[appliesName]) !== contract.condition) failures.push(`${file} validation-required ${appliesName} must match ${jobName} applicability exactly`);
  }
  const allowedEnv = new Set([...Object.keys(exactEnv), ...Object.values(PATH_JOBS).flatMap(({ prefix }) => [`${prefix}_RESULT`, `${prefix}_APPLIES`])]);
  for (const name of Object.keys(env)) {
    if (!allowedEnv.has(name)) failures.push(`${file} validation-required has unexpected aggregate environment state ${name}`);
  }
}

function validateValidationWorkflowContract({ file, content, workflow, locate, root, scripts,
  failures, checked, commandChecked, setupChecked, profileCommands }) {
  if (!isMapping(workflow)) {
    failures.push(`${file}:1 validation workflow must be a mapping`);
    return;
  }
  validateWorkflowPermissions({ workflow, locate, failures });
  validateWorkflowConcurrency({ workflow, locate, failures });
  validatePushOnlyTrigger({ file, workflow, failures, checked });
  const executable = JSON.stringify(workflow);
  for (const token of ['schedule', 'workflow_dispatch', 'pull_request', 'run_full_sweep', 'scheduled-release-backstop']) {
    if (executable.includes(token)) failures.push(`${file} validation workflow must not retain obsolete event/backstop token ${token}`);
  }
  const jobs = workflow?.jobs;
  if (!jobs || typeof jobs !== 'object' || Array.isArray(jobs)) {
    failures.push(`${file} validation workflow must define a jobs mapping`);
    return;
  }
  const requiredConsumers = {
    'routine-docs': ['npm run validate:routine'],
    'backend-jest-build': ['npm run build', 'npm test'],
    'backend-e2e': ['npm run test:e2e'],
    'browser-smoke': ['npm run web:test:e2e:install', 'npx playwright install-deps chromium', 'npm run web:test:e2e:smoke'],
  };
  let classifyStep;
  let enforceStep;
  let artifactCount = 0;
  const browserArtifacts = [];
  let smokeIndex = -1;
  for (const [jobName, job] of Object.entries(jobs)) {
    const jobLocation = `${locate(['jobs', jobName])} ${jobName}`;
    if (!isMapping(job) || !Array.isArray(job.steps)) {
      failures.push(`${jobLocation} must define a steps sequence`);
      continue;
    }
    const commands = [];
    let checkoutIndex = -1;
    let nodeIndex = -1;
    let node;
    for (const [index, step] of job.steps.entries()) {
      const keys = ['jobs', jobName, 'steps', index];
      const stepLocation = `${locate(keys)} ${jobName} step ${index + 1}`;
      if (!isMapping(step)) {
        failures.push(`${stepLocation} must be a step mapping`);
        continue;
      }
      if (step.uses === 'actions/checkout@v4' && checkoutIndex < 0) checkoutIndex = index;
      if (step.uses === 'actions/setup-node@v4') {
        setupChecked.push(`${stepLocation} setup-node ${step.with?.['node-version'] ?? 'missing'}`);
        if (nodeIndex < 0) { nodeIndex = index; node = step; }
      }
      if (step.uses === 'actions/upload-artifact@v4') {
        artifactCount += 1;
        if (jobName === 'browser-smoke') browserArtifacts.push({ step, index });
      }
      if (Object.hasOwn(step, 'run') && typeof step.run !== 'string') {
        failures.push(`${stepLocation} run must be a string`);
        continue;
      }
      if (typeof step.run !== 'string') continue;
      if (jobName === 'classify-changes' && step.id === 'classify' && !classifyStep) classifyStep = step;
      if (jobName === 'validation-required' && (!enforceStep
          || (enforceStep.name !== 'Enforce required validation conclusions' && step.name === 'Enforce required validation conclusions'))) enforceStep = step;
      const runLocation = `${locate([...keys, 'run'])} ${jobName} step ${index + 1}`;
      let part = 0;
      for (const command of workflowStepCommands(step.run)) {
        const segments = splitCommandSegments(command);
        for (const [segmentIndex, segment] of segments.entries()) {
          const location = `${runLocation}: ${segment}`;
          commandChecked.push(location);
          if (!checkNpmRun({ scripts, segment, location, failures })) checkDirectScript({ root, segment, location, failures });
          validateWorkflowFailClosedCommand({ segment, location, failures });
          const match = segment.match(/^npm\s+run\s+(validate:[^\s]+)/);
          if (match) profileCommands.add(match[1]);
          // The web install remains one prerequisite within this command, never across steps.
          const prerequisite = segment === 'cd web' && segments[segmentIndex + 1] === 'npm ci'
            ? 'cd web && npm ci' : segment;
          if (!(segment === 'npm ci' && segments[segmentIndex - 1] === 'cd web')) {
            commands.push({ command: prerequisite, position: [index, part] });
          }
          if (jobName === 'browser-smoke' && segment === 'npm run web:test:e2e:smoke' && smokeIndex < 0) smokeIndex = index;
          part += 1;
        }
      }
    }
    if (jobName === 'dependency-hygiene') {
      checked.push(`${file} path-aware dependency audit gate`);
      for (const command of ['npm ci', 'cd web && npm ci', 'npm run audit:security']) {
        if (!commands.some((entry) => entry.command === command)) failures.push(`${jobLocation} must run ${command}`);
      }
    }
    const consumers = requiredConsumers[jobName];
    if (!consumers) continue;
    const position = (command) => commands.find((entry) => entry.command === command)?.position;
    const before = (first, second, label) => {
      if (!first || !second || !(first[0] < second[0] || (first[0] === second[0] && first[1] < second[1]))) {
        failures.push(`${jobLocation} must run ${label}`);
      }
    };
    checked.push(`${file} ${jobName} required coverage and prerequisites`);
    if (`${node?.with?.['node-version']}` !== EXPECTED_NODE_MAJOR) failures.push(`${jobLocation} must set up Node 24 with actions/setup-node@v4`);
    if (node?.with?.cache !== 'npm') failures.push(`${jobLocation} Node setup must retain npm caching`);
    before(checkoutIndex < 0 ? null : [checkoutIndex, 0], nodeIndex < 0 ? null : [nodeIndex, 0], 'checkout before cached Node setup');
    const installs = jobName === 'backend-e2e' ? ['npm ci'] : ['npm ci', 'cd web && npm ci'];
    for (const command of [...installs, ...consumers]) {
      if (!position(command)) failures.push(`${jobLocation} must run ${command}`);
    }
    for (const install of installs) {
      before(nodeIndex < 0 ? null : [nodeIndex, 0], position(install), `Node setup before ${install}`);
      for (const consumer of consumers) before(position(install), position(consumer), `${install} before ${consumer}`);
    }
    if (jobName === 'browser-smoke') {
      for (const setup of consumers.slice(0, 2)) before(position(setup), position(consumers[2]), `${setup} before ${consumers[2]}`);
    }
  }

  for (const jobName of Object.keys(requiredConsumers)) {
    if (!Object.hasOwn(jobs, jobName)) failures.push(`${file} validation workflow must define ${jobName} with required coverage and prerequisites`);
  }
  validateClassifier({ file, jobs, classifyStep, failures, checked });
  validateAggregate({ file, jobs, enforceStep, failures, checked });
  checked.push(`${file} browser failure/cancellation artifact semantics and order`);
  if (browserArtifacts.length !== 1 || artifactCount !== 1) {
    failures.push(`${file} validation workflow must contain exactly one actions/upload-artifact@v4 step, in browser-smoke`);
  } else {
    const { step: artifact, index } = browserArtifacts[0];
    if (smokeIndex < 0 || index <= smokeIndex) failures.push(`${file} browser artifact upload must follow the browser smoke command`);
    if (expressionBody(artifact.if) !== 'failure() || cancelled()') failures.push(`${file} browser artifact upload condition must be exactly failure() || cancelled()`);
    const artifactPaths = typeof artifact.with?.path === 'string' ? artifact.with.path.split(/\r?\n/).map((value) => value.trim()).filter(Boolean) : [];
    if (!exactSet(artifactPaths, ['tmp/playwright-report', 'tmp/playwright-results'])) failures.push(`${file} browser artifact upload paths must be exactly tmp/playwright-report and tmp/playwright-results`);
    if (artifact.with?.['if-no-files-found'] !== 'warn') failures.push(`${file} browser artifact upload must set if-no-files-found: warn`);
    if (Object.hasOwn(artifact, 'continue-on-error')) failures.push(`${file} browser artifact upload must not set continue-on-error`);
  }
  if (content.includes('web:test:live-getrich-v2') || content.includes('live-getrich-v2.config.ts')) failures.push(`${file} validation workflow must exclude the external live GetRich v2 suite`);

  if (content.includes('npm run deps:review')) failures.push(`${file} dependency-hygiene must not run the local-only deps:review command in CI`);
}

function validatePlaywrightOwnership({ root, scripts }) {
  const failures = [];
  const checked = [];
  const allSpecs = listFilesRecursively(root, 'tests/playwright').filter((file) => file.endsWith('.spec.ts'));
  const owned = new Set();
  for (const [name, directory, config, script, testMatch] of PLAYWRIGHT_SUITE_OWNERS) {
    const specs = allSpecs.filter((file) => file.startsWith(`${directory}/`));
    checked.push(`${name} positive owner (${specs.length} spec file(s))`);
    if (specs.length === 0) failures.push(`${name} Playwright owner must contain at least one .spec.ts file`);
    specs.forEach((spec) => owned.add(spec));
    if (!existsSync(path.join(root, config))) {
      failures.push(`${name} Playwright config ${config} does not exist`);
    } else {
      const configSource = readFileSync(path.join(root, config), 'utf8');
      if (!configSource.includes("testDir: '.'") || !configSource.includes(testMatch)) failures.push(`${name} Playwright config must positively own its exact directory and expected spec set`);
    }
    const expected = `playwright test -c ${config}`;
    if (scripts[script] !== expected) failures.push(`package.json script "${script}" must map exactly to ${config}, but is currently: ${scripts[script] ?? '<missing>'}`);
  }
  for (const spec of allSpecs) {
    if (!owned.has(spec)) failures.push(`Playwright spec ${spec} has no positive suite owner`);
  }
  const composite = 'npm run web:test:e2e:preview-smoke && npm run web:test:e2e:browser-client-smoke';
  checked.push('package.json self-contained Playwright smoke composition');
  if (scripts['web:test:e2e:smoke'] !== composite) failures.push(`package.json script "web:test:e2e:smoke" must compose exactly the two self-contained profiles: ${composite}`);
  if ((scripts['web:test:e2e:smoke'] ?? '').includes('live-getrich-v2')) failures.push('package.json self-contained web:test:e2e:smoke must exclude the external live GetRich v2 suite');
  return { checked, failures };
}

function validatePlaywrightDocumentation({ root }) {
  const failures = [];
  const checked = [];
  const literalPattern = /tests\/playwright\/[A-Za-z0-9_./-]+\.(?:spec|config)\.ts/g;
  for (const file of ['README.md', 'docs/validation.md']) {
    const fullPath = path.join(root, file);
    if (!existsSync(fullPath)) {
      failures.push(`${file} does not exist; cannot verify Playwright documentation`);
      continue;
    }
    const markdown = readFileSync(fullPath, 'utf8');
    for (const literal of markdown.match(literalPattern) ?? []) {
      checked.push(`${file} Playwright path ${literal}`);
      if (!existsSync(path.join(root, literal))) failures.push(`${file} references nonexistent Playwright path ${literal}`);
    }
  }

  return { checked, failures };
}

function extractDocsVerifyInvocations(content) {
  const invocations = [];
  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith('#') || line.startsWith('echo ') || line.startsWith('if ') || line.startsWith('for ')) {
      continue;
    }
    const nodeMatch = line.match(/(?:^|\s)node\s+(scripts\/[^\s|&]+)/);
    if (nodeMatch) {
      invocations.push({ kind: 'node-script', target: nodeMatch[1], line: index + 1 });
    }
    const npmRunMatch = line.match(/(?:^|\s)npm\s+run\s+([^\s|&]+)/);
    if (npmRunMatch) {
      invocations.push({ kind: 'npm-script', target: npmRunMatch[1], line: index + 1 });
    }
    const jestMatch = line.match(/(?:^|\s)npx\s+jest\s+(.+?)(?:\s+\|\|\s+ALL_OK=false|$)/);
    if (jestMatch) {
      const args = jestMatch[1].split(/\s+/).filter(Boolean);
      for (const arg of args) {
        if (arg.startsWith('-') || arg.includes('=')) {
          continue;
        }
        if (/^(tests|src|scripts)\//.test(arg)) {
          invocations.push({ kind: 'jest-entry', target: arg, line: index + 1 });
        }
      }
    }
  }
  return invocations;
}

function scriptIncludes(command, expected) {
  return command.includes(expected);
}


function commandUsesPassWithNoTests(command) {
  return command.includes(PASS_WITH_NO_TESTS_FLAG);
}

function isAllowEmptyScriptName(name) {
  return name.includes('allow-empty');
}

function npmRunScriptName(segment) {
  const runMatch = segment.match(/^npm\s+run\s+([^\s]+)/);
  const shorthandMatch = segment.match(/^npm\s+(test)(?:\s|$)/);
  return (runMatch ?? shorthandMatch)?.[1] ?? null;
}

function validateWorkflowFailClosedCommand({ segment, location, failures }) {
  if (commandUsesPassWithNoTests(segment)) {
    failures.push(`${location} must not use ${PASS_WITH_NO_TESTS_FLAG}; CI validation gates must fail when no tests are discovered`);
  }
  const referencedScript = npmRunScriptName(segment);
  if (referencedScript && isAllowEmptyScriptName(referencedScript)) {
    failures.push(`${location} must not reference allow-empty script ${referencedScript}; CI validation gates must fail when no tests are discovered`);
  }
}

function validateFailClosedJestGates({ scripts }) {
  const failures = [];
  const checked = [];

  for (const [name, command] of Object.entries(scripts)) {
    if (name === 'test' || name === 'test:direct' || name.startsWith('validate:')) {
      checked.push(`package.json script ${name}`);
    }

    if (!commandUsesPassWithNoTests(command)) {
      continue;
    }

    if (!isAllowEmptyScriptName(name)) {
      failures.push(`package.json script ${name} must not use ${PASS_WITH_NO_TESTS_FLAG}; root/release Jest gates must fail when no tests are discovered`);
      continue;
    }

    checked.push(`package.json local allow-empty script ${name}`);
  }

  for (const [name, command] of Object.entries(scripts)) {
    if (!name.startsWith('validate:')) {
      continue;
    }
    for (const segment of splitCommandSegments(command)) {
      if (commandUsesPassWithNoTests(segment)) {
        failures.push(`package.json validation profile ${name} must not use ${PASS_WITH_NO_TESTS_FLAG}; release validation must fail when no tests are discovered`);
      }
      const referencedScript = npmRunScriptName(segment);
      if (referencedScript && isAllowEmptyScriptName(referencedScript)) {
        failures.push(`package.json validation profile ${name} must not reference allow-empty script ${referencedScript}; release validation must fail when no tests are discovered`);
      }
    }
  }

  return { checked, failures };
}

function validateTerminalChildJestContract({ root, pkg, scripts }) {
  const failures = [];
  const checked = [];

  checked.push('package.json root backend Jest composition');
  if (scripts.test !== ROOT_TEST_COMMAND) {
    failures.push(`package.json script "test" must compose exactly ${ROOT_TEST_COMMAND}, but is currently: ${scripts.test ?? '<missing>'}`);
  }

  checked.push('package.json ordinary parallel Jest owner');
  if (scripts['test:parallel'] !== PARALLEL_TEST_COMMAND) {
    failures.push(`package.json script "test:parallel" must be exactly the ordinary parallel Jest command ${PARALLEL_TEST_COMMAND}, but is currently: ${scripts['test:parallel'] ?? '<missing>'}`);
  }
  if ((scripts['test:parallel'] ?? '').includes('--runInBand')) {
    failures.push('package.json script "test:parallel" must retain Jest default worker parallelism and must not use --runInBand');
  }
  if ((scripts['test:parallel'] ?? '').includes(TERMINAL_CHILD_TEST_PATH)) {
    failures.push(`package.json script "test:parallel" must not positively select ${TERMINAL_CHILD_TEST_PATH}`);
  }

  const terminalChildCommand = scripts['test:terminal-child'] ?? '';
  checked.push('package.json exact serial terminal-child Jest owner');
  if (!terminalChildCommand.includes(`--runTestsByPath ${TERMINAL_CHILD_TEST_PATH}`)) {
    failures.push(`package.json script "test:terminal-child" must positively own exactly ${TERMINAL_CHILD_TEST_PATH} through --runTestsByPath`);
  }
  if (!terminalChildCommand.includes('--runInBand')) {
    failures.push('package.json script "test:terminal-child" must serialize its exact suite with --runInBand');
  }
  if (!terminalChildCommand.includes("--testPathIgnorePatterns='<rootDir>/tests/(playwright|e2e)/'")) {
    failures.push('package.json script "test:terminal-child" must override testPathIgnorePatterns with exactly the Playwright/E2E directory exclusion');
  }
  if (commandUsesPassWithNoTests(terminalChildCommand)) {
    failures.push(`package.json script test:terminal-child must not use ${PASS_WITH_NO_TESTS_FLAG}; the dedicated owner must fail when its exact test is absent`);
  }
  if (terminalChildCommand !== TERMINAL_CHILD_TEST_COMMAND) {
    failures.push(`package.json script "test:terminal-child" must be exactly: ${TERMINAL_CHILD_TEST_COMMAND}`);
  }
  const positiveOwners = Object.entries(scripts)
    .filter(([, command]) => command.includes(TERMINAL_CHILD_TEST_PATH))
    .map(([name]) => name);
  const dedicatedPathOccurrences = terminalChildCommand.split(TERMINAL_CHILD_TEST_PATH).length - 1;
  if (JSON.stringify(positiveOwners) !== JSON.stringify(['test:terminal-child']) || dedicatedPathOccurrences !== 1) {
    failures.push('package.json must have exactly one positive package owner for the terminal-child path: test:terminal-child with one exact path occurrence');
  }

  const ignorePatterns = pkg.jest?.testPathIgnorePatterns;
  checked.push('package.json exact ordinary Jest ignore array');
  if (!Array.isArray(ignorePatterns)) {
    failures.push('package.json ordinary terminal-child exclusion contract requires jest.testPathIgnorePatterns to be an array');
  } else {
    const canonicalCount = ignorePatterns.filter((entry) => entry === TERMINAL_CHILD_IGNORE_REGEX).length;
    if (canonicalCount === 0) {
      failures.push(`package.json ordinary terminal-child exclusion must contain the canonical escaped, end-anchored regex ${TERMINAL_CHILD_IGNORE_REGEX}`);
    } else if (canonicalCount > 1) {
      failures.push('package.json ordinary terminal-child exclusion must contain exactly one canonical regex; duplicate canonical entries are forbidden');
    }
    if (!exactSet(ignorePatterns, JEST_IGNORE_PATTERNS)) {
      failures.push('package.json ordinary Jest ignore array must contain exactly the Playwright entry, E2E entry, and one canonical terminal-child exclusion; noncanonical, extra, duplicate, and broader exclusions are forbidden');
    }
  }

  checked.push('package.json singular release backend Jest authority');
  const releaseSegments = splitCommandSegments(scripts['validate:release'] ?? '');
  if (releaseSegments.filter((segment) => segment === 'npm test').length !== 1
      || releaseSegments.some((segment) => /^npm run test:(?:parallel|terminal-child)(?:\s|$)/.test(segment))) {
    failures.push('package.json validate:release must invoke singular npm test exactly once and must not invoke backend Jest subphases independently');
  }
  checked.push('package.json release backend-E2E cadence');
  if (releaseSegments.filter((segment) => segment === 'npm run test:e2e').length !== 1) {
    failures.push('package.json validate:release must invoke npm run test:e2e exactly once');
  }

  const validation = existsSync(path.join(root, 'docs/validation.md')) ? readFileSync(path.join(root, 'docs/validation.md'), 'utf8') : '';
  if (!validation.includes('npm run test:terminal-child')) {
    failures.push('docs/validation.md must document npm run test:terminal-child');
  }

  return { checked, failures };
}

function validateRequiredValidationScripts({ scripts, documentedCommands }) {
  const failures = [];
  const checked = [];

  for (const required of REQUIRED_VALIDATION_SCRIPTS) {
    const command = scripts[required.name];
    checked.push(`package.json script ${required.name}`);
    if (!command) {
      failures.push(`package.json is missing required validation script "${required.name}" (${required.description})`);
      continue;
    }
    for (const expected of required.mustInclude ?? []) {
      if (!scriptIncludes(command, expected)) {
        failures.push(`package.json script "${required.name}" must run ${expected}, but is currently: ${command}`);
      }
    }
    const documented = documentedCommands.some((location) => location.includes(`npm run ${required.name}`));
    if (!documented && !required.documentationOptional) {
      failures.push(`required validation script "${required.name}" is not documented in README.md, docs/validation.md or docs/architecture/system-architecture.md validation cadence`);
    }
  }

  return { checked, failures };
}

function validateValidationProfiles({ scripts, documentedCommands }) {
  const failures = [];
  const checked = [];

  for (const profile of REQUIRED_VALIDATION_PROFILES) {
    const command = scripts[profile.name];
    checked.push(`package.json profile ${profile.name}`);
    if (!command) {
      failures.push(`package.json is missing validation profile "${profile.name}" (${profile.description})`);
      continue;
    }
    for (const expected of profile.mustInclude ?? []) {
      if (!scriptIncludes(command, expected)) {
        failures.push(`package.json profile "${profile.name}" must include ${expected}, but is currently: ${command}`);
      }
    }
    for (const excluded of profile.mustNotInclude ?? []) {
      if (scriptIncludes(command, excluded)) {
        failures.push(`package.json profile "${profile.name}" should intentionally exclude ${excluded}, but is currently: ${command}`);
      }
    }
    const documented = documentedCommands.some((location) => location.includes(`npm run ${profile.name}`));
    if (!documented) {
      failures.push(`validation profile "${profile.name}" is not documented in README.md, docs/validation.md or docs/architecture/system-architecture.md validation cadence`);
    }
  }

  return { checked, failures };
}

function validateExportConsumerCadence({ scripts }) {
  const failures = [];
  const checked = [
    'package.json exact export-consumer script edge',
    'package.json validate:routine required coverage',
    'package.json lint required coverage',
    'package.json import-boundary test coverage',
    'package.json singular lint import-boundary delegation',
  ];

  if (scripts['check:export-consumers'] !== EXPORT_CONSUMER_SCRIPT) {
    failures.push(`package.json script "check:export-consumers" must be exactly ${EXPORT_CONSUMER_SCRIPT}, but is currently: ${scripts['check:export-consumers'] ?? '<missing>'}`);
  }

  const importCommand = scripts['test:import-boundaries'] ?? '';
  if (!exactSet(importCommand.split(/\s+&&\s+/).map((segment) => segment.trim()), splitCommandSegments(IMPORT_BOUNDARY_TEST_COMMAND))) {
    failures.push(`package.json script "test:import-boundaries" must run the three required commands exactly once connected by &&: ${IMPORT_BOUNDARY_TEST_COMMAND}`);
  }

  const routineSegments = splitCommandSegments(scripts['validate:routine'] ?? '');
  const expectedRoutine = [
    'npm run typecheck',
    EXPORT_CONSUMER_COMMAND,
    'npm run check:canonical-persistence-drift',
    'npm run test:direct -- --runInBand tests/architecture',
    'npm run docs:verify',
  ];
  if (expectedRoutine.some((command) => routineSegments.filter((segment) => segment === command).length !== 1)
      || (scripts['validate:routine'] ?? '').includes(';')) {
    failures.push(`package.json script "validate:routine" must run each required command exactly once connected by &&: ${expectedRoutine.join(', ')}`);
  }

  const lintSegments = splitCommandSegments(scripts.lint ?? '');
  const requiredLintCommands = ['eslint src/', 'node scripts/check-web-component-boundaries.cjs'];
  if (lintSegments.filter((segment) => segment === EXPORT_CONSUMER_COMMAND).length !== 1
      || requiredLintCommands.some((command) => !lintSegments.includes(command))
      || (scripts.lint ?? '').includes(';')) {
    failures.push(`package.json script "lint" must invoke ${EXPORT_CONSUMER_COMMAND} exactly once and retain ${requiredLintCommands.join(', ')} connected by &&`);
  }
  const importBoundaryIndexes = lintSegments.flatMap((segment, index) => segment === IMPORT_BOUNDARY_COMMAND ? [index] : []);
  const invokesDirectChecker = lintSegments.some((segment) => segment === IMPORT_BOUNDARY_SCRIPT || segment.startsWith(`${IMPORT_BOUNDARY_SCRIPT} `));
  if (importBoundaryIndexes.length !== 1
      || invokesDirectChecker) {
    failures.push(`package.json script "lint" must delegate exactly once to ${IMPORT_BOUNDARY_COMMAND} and must not invoke ${IMPORT_BOUNDARY_SCRIPT} directly`);
  }

  return { checked, failures };
}


function validateRuntimeEngines({ root }) {
  const failures = [];
  const checked = [];
  const packages = [
    { file: 'package.json', description: 'root package' },
    { file: 'web/package.json', description: 'web package' },
  ];

  for (const pkg of packages) {
    const fullPath = path.join(root, pkg.file);
    checked.push(`${pkg.file} engines`);
    if (!existsSync(fullPath)) {
      failures.push(`${pkg.file} does not exist; cannot verify ${pkg.description} Node/npm engines`);
      continue;
    }
    const data = readJsonFile(root, pkg.file);
    if (data.engines?.node !== EXPECTED_NODE_ENGINE) {
      failures.push(`${pkg.file} engines.node must be "${EXPECTED_NODE_ENGINE}" to match CI Node ${EXPECTED_NODE_MAJOR}, but is ${JSON.stringify(data.engines?.node)}`);
    }
    if (data.engines?.npm !== EXPECTED_NPM_ENGINE) {
      failures.push(`${pkg.file} engines.npm must be "${EXPECTED_NPM_ENGINE}" for the supported npm range, but is ${JSON.stringify(data.engines?.npm)}`);
    }
  }

  return { checked, failures };
}

function validateDocsVerifySubguards({ root, scripts }) {
  const docsVerifyPath = path.join(root, 'scripts', 'docs-verify.sh');
  const failures = [];
  const checked = [];
  if (!existsSync(docsVerifyPath)) {
    return { checked, failures: ['scripts/docs-verify.sh does not exist'] };
  }
  const content = readFileSync(docsVerifyPath, 'utf8');
  const invocations = extractDocsVerifyInvocations(content);

  for (const invocation of invocations) {
    const location = `scripts/docs-verify.sh:${invocation.line}`;
    checked.push(`${location} ${invocation.kind} ${invocation.target}`);
    if (invocation.kind === 'npm-script') {
      if (!scripts[invocation.target]) {
        failures.push(`${location} invokes npm run ${invocation.target}, but package.json has no "${invocation.target}" script`);
      }
    } else if (!isRunnableFile(root, invocation.target)) {
      failures.push(`${location} invokes ${invocation.target}, but that docs:verify sub-guard entry point does not exist`);
    }
  }

  return { checked, failures };
}

export function verifyValidationCadence(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const pkg = readJsonFile(root, 'package.json');
  const scripts = options.packageScripts ?? pkg.scripts ?? {};
  const documented = validateDocumentedCommands({
    root,
    files: options.documentedCommandFiles ?? DEFAULT_DOCUMENTED_COMMAND_FILES,
    scripts,
  });
  const workflow = validateWorkflowCommands({
    root,
    scripts,
    workflowFiles: options.workflowFiles,
  });
  const requiredScripts = validateRequiredValidationScripts({
    scripts,
    documentedCommands: documented.checked,
  });
  const profiles = validateValidationProfiles({
    scripts,
    documentedCommands: documented.checked,
  });
  const exportConsumerCadence = validateExportConsumerCadence({ scripts });
  const forbiddenDocumentedWebTestNamespace = validateForbiddenDocumentedWebTestNamespace({ root, files: options.documentedCommandFiles ?? DEFAULT_DOCUMENTED_COMMAND_FILES });
  const canonicalWebTestNamespace = validateCanonicalWebTestNamespace({ scripts });
  const runtimeEngines = validateRuntimeEngines({ root });
  const docsVerify = validateDocsVerifySubguards({ root, scripts });
  const failClosedJest = validateFailClosedJestGates({ scripts });
  const terminalChildJest = validateTerminalChildJestContract({ root, pkg, scripts });
  const playwrightOwnership = validatePlaywrightOwnership({ root, scripts });
  const playwrightDocumentation = validatePlaywrightDocumentation({ root });
  const failures = [...documented.failures, ...forbiddenDocumentedWebTestNamespace.failures, ...workflow.failures, ...requiredScripts.failures, ...profiles.failures, ...exportConsumerCadence.failures, ...canonicalWebTestNamespace.failures, ...runtimeEngines.failures, ...docsVerify.failures, ...failClosedJest.failures, ...terminalChildJest.failures, ...playwrightOwnership.failures, ...playwrightDocumentation.failures];
  return {
    ok: failures.length === 0,
    failures,
    documentedCommandsChecked: documented.checked,
    workflowCommandsChecked: workflow.checked,
    validationWorkflowContractEntriesChecked: workflow.contractChecked,
    workflowFilesChecked: workflow.workflowFilesChecked,
    requiredValidationScriptsChecked: requiredScripts.checked,
    validationProfilesChecked: profiles.checked,
    exportConsumerCadenceEntriesChecked: exportConsumerCadence.checked,
    forbiddenDocumentedWebTestNamespaceEntriesChecked: forbiddenDocumentedWebTestNamespace.checked,
    canonicalWebTestNamespaceEntriesChecked: canonicalWebTestNamespace.checked,
    runtimeEngineEntriesChecked: [...runtimeEngines.checked, ...workflow.setupChecked],
    docsVerifyEntriesChecked: docsVerify.checked,
    failClosedJestGateEntriesChecked: failClosedJest.checked,
    terminalChildJestContractEntriesChecked: terminalChildJest.checked,
    playwrightOwnershipEntriesChecked: playwrightOwnership.checked,
    playwrightDocumentationEntriesChecked: playwrightDocumentation.checked,
  };
}

function main() {
  const result = verifyValidationCadence();
  if (!result.ok) {
    console.error('✗ validation cadence check failed');
    for (const failure of result.failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }
  console.log(
    `✓ validation cadence check passed — ${result.documentedCommandsChecked.length} documented validation command(s), ${result.workflowCommandsChecked.length} workflow command(s), ${result.requiredValidationScriptsChecked.length} required validation script(s), ${result.validationProfilesChecked.length} validation profile(s), ${result.runtimeEngineEntriesChecked.length} runtime engine alignment item(s), ${result.docsVerifyEntriesChecked.length} docs:verify sub-guard entry point(s), ${result.failClosedJestGateEntriesChecked.length} fail-closed Jest gate item(s), and ${result.terminalChildJestContractEntriesChecked.length} terminal-child Jest contract item(s) resolve`,
  );
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  main();
}
