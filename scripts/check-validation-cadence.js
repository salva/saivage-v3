#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const DEFAULT_DOCUMENTED_COMMAND_FILES = [
  'README.md',
  'docs/architecture/system-architecture.md',
];

const DEFAULT_WORKFLOW_DIRS = ['.github/workflows'];

const REQUIRED_WORKFLOW_PROFILES = ['validate:routine', 'validate:docs'];

const EXPECTED_NODE_MAJOR = '24';
const EXPECTED_NODE_ENGINE = '>=24 <25';
const EXPECTED_NPM_ENGINE = '>=10 <12';
const RUNTIME_REFERENCE_PATTERN = /Node(?:\.js)?\s+24[\s\S]{0,160}(?:npm\s+10|package\.json\s+engines|package engines|CI|GitHub Actions)/i;
const REQUIRED_RUNTIME_DOC_FILES = ['README.md', 'docs/architecture/system-architecture.md'];
const PASS_WITH_NO_TESTS_FLAG = '--passWithNoTests';
const DATED_LIVE_VALIDATION_RECORD = 'docs/validation/live-getrich-v2-launch-playwright-issues-2026-06-24.md';
const PLAYWRIGHT_SUITE_OWNERS = [
  ['preview smoke', 'tests/playwright/smoke', 'tests/playwright/smoke/playwright.config.ts', 'web:test:e2e:preview-smoke', String.raw`testMatch: /.*\.spec\.ts/`],
  ['browser-client smoke', 'tests/playwright/browser-client', 'tests/playwright/browser-client/chat-api-client-browser.config.ts', 'web:test:e2e:browser-client-smoke', String.raw`testMatch: /(^|\/)chat-api-client-browser\.spec\.ts$/`],
  ['live GetRich v2', 'tests/playwright/live-getrich-v2', 'tests/playwright/live-getrich-v2/live-getrich-v2.config.ts', 'web:test:live-getrich-v2', String.raw`testMatch: /live-getrich-v2(-extra|-ui|-coverage)?\.spec\.ts/`],
];


const REQUIRED_VALIDATION_SCRIPTS = [
  {
    name: 'web:test:operator-smoke',
    mustInclude: ['operator-dashboard-smoke.test.ts'],
    description: 'direct operator-dashboard smoke guard',
  },
  {
    name: 'audit:root',
    mustInclude: ['npm audit --audit-level=high --omit=dev'],
    description: 'root production dependency security gate',
    documentationOptional: true,
  },
  {
    name: 'audit:web',
    mustInclude: ['cd web && npm audit --audit-level=high --omit=dev'],
    description: 'web production dependency security gate',
    documentationOptional: true,
  },
  {
    name: 'audit:security',
    mustInclude: ['npm run audit:root', 'npm run audit:web'],
    description: 'combined production dependency security gate',
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
    documentedExclusion: /validate:docs[\s\S]{0,240}(?:does not|without|excludes|omits)[\s\S]{0,160}(?:web:test:operator-smoke|Vitest smoke|npm test)/i,
    description: 'docs-only validation profile',
  },
  {
    name: 'validate:routine',
    mustInclude: ['npm run typecheck', 'npm run docs:verify'],
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
    mustInclude: ['npm run typecheck', 'npm run build', 'npm test', 'npm run web:test:operator-smoke', 'npm run docs:verify'],
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

function workflowRunCommands(content) {
  const commands = [];
  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const inlineRun = trimmed.match(/^(?:-\s*)?run:\s*(.+)$/);
    if (inlineRun && !/[|>]\s*$/.test(inlineRun[1].trim())) {
      const command = inlineRun[1].trim().replace(/^['"]|['"]$/g, '');
      commands.push({ command: normalizeCommandLine(command), line: index + 1 });
      continue;
    }
    if (/^(?:-\s*)?run:\s*[|>]$/.test(trimmed)) {
      const blockIndent = rawLine.match(/^\s*/)?.[0].length ?? 0;
      let pending = '';
      for (let blockIndex = index + 1; blockIndex < lines.length; blockIndex += 1) {
        const blockLine = lines[blockIndex];
        const indent = blockLine.match(/^\s*/)?.[0].length ?? 0;
        if (blockLine.trim() && indent <= blockIndent) {
          break;
        }
        const blockTrimmed = blockLine.trim();
        if (!blockTrimmed || blockTrimmed.startsWith('#')) {
          continue;
        }
        pending = pending ? `${pending} ${blockTrimmed}` : blockTrimmed;
        if (/\\\s*$/.test(blockTrimmed)) {
          pending = pending.replace(/\\\s*$/, '').trim();
          continue;
        }
        commands.push({ command: normalizeCommandLine(pending), line: blockIndex + 1 });
        pending = '';
      }
      if (pending) {
        commands.push({ command: normalizeCommandLine(pending), line: index + 1 });
      }
    }
  }
  return commands;
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

function readPackageScripts(root) {
  const pkg = readJsonFile(root, 'package.json');
  return pkg.scripts ?? {};
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
  const markdownByFile = new Map();

  for (const file of files) {
    const fullPath = path.join(root, file);
    if (!existsSync(fullPath)) {
      continue;
    }
    const markdown = readFileSync(fullPath, 'utf8');
    markdownByFile.set(file, markdown);
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

  return { checked, failures, markdownByFile };
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

function topLevelBlockLines(content, key) {
  const lines = content.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^${key}:\\s*(?:#.*)?$`).test(line));
  if (start === -1) {
    return [];
  }
  const block = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (index > start && /^\S/.test(line)) {
      break;
    }
    block.push({ line, number: index + 1 });
  }
  return block;
}

function workflowNodeVersion(content) {
  if (!/uses:\s*actions\/setup-node@v4\b/.test(content)) {
    return null;
  }
  const match = content.match(/^\s*node-version:\s*['"]?([^'"\s]+)['"]?\s*$/m);
  return match?.[1] ?? null;
}

function workflowUsesExpectedNode(content) {
  return workflowNodeVersion(content) === EXPECTED_NODE_MAJOR;
}

function validateWorkflowPermissions({ file, content, failures }) {
  if (/^permissions:\s*(?:write-all|read-all)\s*$/im.test(content)) {
    failures.push(`${file}:${lineNumberForPattern(content, /^permissions:\s*(?:write-all|read-all)\s*$/i)} must not use broad workflow permissions; use least-privilege contents: read`);
    return;
  }

  const block = topLevelBlockLines(content, 'permissions');
  if (block.length === 0) {
    failures.push(`${file} must declare top-level least-privilege permissions with contents: read`);
    return;
  }

  if (!block.some(({ line }) => /^\s+contents:\s*read\s*$/.test(line))) {
    failures.push(`${file}:${block[0].number} permissions block must include contents: read`);
  }

  const writePermission = block.find(({ line }) => /^\s+[A-Za-z0-9_-]+:\s*write\s*$/.test(line));
  if (writePermission) {
    failures.push(`${file}:${writePermission.number} permissions block must not request write permissions for validation`);
  }
}

function validateWorkflowConcurrency({ file, content, failures }) {
  const block = topLevelBlockLines(content, 'concurrency');
  if (block.length === 0) {
    failures.push(`${file} must declare top-level concurrency with a group and cancel-in-progress: true`);
    return;
  }
  if (!block.some(({ line }) => /^\s+group:\s*\S+/.test(line))) {
    failures.push(`${file}:${block[0].number} concurrency block must include a stable group`);
  }
  if (!block.some(({ line }) => /^\s+cancel-in-progress:\s*true\s*$/.test(line))) {
    failures.push(`${file}:${block[0].number} concurrency block must set cancel-in-progress: true`);
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

function validateWorkflowHardening({ file, content, commands, failures }) {
  validateWorkflowPermissions({ file, content, failures });
  validateWorkflowConcurrency({ file, content, failures });
  validateWorkflowSecretSafety({ file, content, failures });

  if (!workflowUsesExpectedNode(content)) {
    failures.push(`${file} must use actions/setup-node@v4 with node-version: ${EXPECTED_NODE_MAJOR}`);
  }

  const npmCi = commands.find(({ command }) => command === 'npm ci');
  if (!npmCi) {
    failures.push(`${file} must install dependencies with npm ci before validation profiles`);
  }

  const firstValidation = commands.find(({ command }) => /^npm\s+run\s+validate:/.test(command));
  if (npmCi && firstValidation && npmCi.line > firstValidation.line) {
    failures.push(`${file}:${npmCi.line} npm ci must run before validation profiles`);
  }
}

function validateWorkflowCommands({ root, scripts, workflowFiles }) {
  const failures = [];
  const checked = [];
  const profileCommands = new Set();
  const workflowDocuments = new Map();
  const files = workflowFiles ?? listWorkflowFiles(root);

  for (const file of files) {
    const fullPath = path.join(root, file);
    if (!existsSync(fullPath)) {
      failures.push(`workflow/template ${file} does not exist`);
      continue;
    }
    const content = readFileSync(fullPath, 'utf8');
    const document = parseDocument(content, { uniqueKeys: true });
    if (document.errors.length > 0) {
      for (const error of document.errors) {
        failures.push(`${file} has invalid YAML: ${error.message}`);
      }
      continue;
    }
    const workflow = document.toJS();
    workflowDocuments.set(file, { content, workflow });
    const commands = workflowRunCommands(content);
    validateWorkflowHardening({ file, content, commands, failures });
    for (const { command, line } of commands) {
      for (const segment of splitCommandSegments(command)) {
        const location = `${file}:${line}: ${segment}`;
        if (checkNpmRun({ scripts, segment, location, failures })) {
          checked.push(location);
          const match = segment.match(/^npm\s+run\s+(validate:[^\s]+)/);
          if (match) {
            profileCommands.add(match[1]);
          }
          continue;
        }
        if (checkDirectScript({ root, segment, location, failures })) {
          checked.push(location);
          continue;
        }
        checked.push(location);
      }
    }
  }

  if (files.length === 0) {
    failures.push('no validation workflow/template found under .github/workflows; add CI automation or pass workflowFiles to the guard');
  }

  for (const required of REQUIRED_WORKFLOW_PROFILES) {
    if (!profileCommands.has(required)) {
      failures.push(`validation workflow/template must run npm run ${required}`);
    }
  }

  return { checked, failures, workflowFilesChecked: files, workflowDocuments };
}

function expressionBody(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const match = value.match(/^\s*\$\{\{([\s\S]*)\}\}\s*$/);
  return (match?.[1] ?? value).replace(/\s+/g, ' ').trim();
}

function scalarRunSteps(job) {
  return Array.isArray(job?.steps)
    ? job.steps.filter((step) => step && typeof step === 'object' && typeof step.run === 'string')
    : [];
}

function requirePattern({ file, text, label, pattern, failures, checked }) {
  checked.push(`${file} ${label}`);
  if (!pattern.test(text)) {
    failures.push(`${file} validation workflow must preserve ${label}`);
  }
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

function validateClassifier({ file, jobs, failures, checked }) {
  const job = jobs?.['classify-changes'];
  if (!job || typeof job !== 'object') {
    failures.push(`${file} validation workflow must define classify-changes`);
    return;
  }
  checked.push(`${file} classify-changes outputs`);
  if (JSON.stringify(job.outputs) !== JSON.stringify(CLASSIFIER_OUTPUTS)) {
    failures.push(`${file} classify-changes must publish exactly backend, ui, browser, docs_only, package_or_workflow, run_all, and summary from steps.classify.outputs`);
  }
  const classifyStep = Array.isArray(job.steps) ? job.steps.find((step) => step?.id === 'classify') : null;
  const shell = classifyStep?.run;
  if (typeof shell !== 'string') {
    failures.push(`${file} classify-changes must contain the inline classify shell step`);
    return;
  }
  checked.push(`${file} classifier has no event-selection dispatch`);
  if (/github\.event_name|inputs\.|github\.event\.pull_request/.test(shell)) {
    failures.push(`${file} classify-changes must not contain event-selection dispatch; every invocation is a push`);
  }
  const requirements = [
    ['push base from github.event.before', /base='\$\{\{ github\.event\.before \}\}'/],
    ['push head from github.sha', /head='\$\{\{ github\.sha \}\}'/],
    ['empty or all-zero push-base fail-closed check', /\[\[ -z "\$base" \|\| "\$base" =~ \^0\+\$ \]\][\s\S]*fail_closed 'push base SHA unavailable'/],
    ['base/head presence fail-closed check', /\[\[ -z "\$base" \|\| -z "\$head" \]\][\s\S]*fail_closed 'base or head SHA unavailable'/],
    ['base/head commit availability fail-closed check', /git cat-file -e "\$base\^\{commit\}"[\s\S]*git cat-file -e "\$head\^\{commit\}"[\s\S]*fail_closed 'base or head commit unavailable after checkout'/],
    ['git diff failure fail-closed check', /! git diff --name-only "\$base" "\$head" > changed-files\.txt[\s\S]*fail_closed 'git diff failed'/],
    ['docs-like path class', /docs\/\*\|architecture-audit\/\*\|audit-findings\/\*\|ui-findings\/\*\|\*\.md\|README\.md\|EADME\.md/],
    ['package/workflow path class', /package\.json\|package-lock\.json\|web\/package\.json\|web\/package-lock\.json\|\.github\/workflows\/\*/],
    ['workflow run-all path class', /\.github\/workflows\/\*\)[\s\S]*?run_all=true/],
    ['contracts backend/UI/browser path class', /src\/contracts\/\*\)[\s\S]*?backend=true[\s\S]*?ui=true[\s\S]*?browser=true/],
    ['backend path class with Playwright exclusion', /src\/\*\|src\/\*\*\/\*\|bin\/\*\|bin\/\*\*\/\*\|scripts\/\*\|scripts\/\*\*\/\*\|tests\/\*\|tests\/\*\*\/\*\|jest\.config\.\*\|tsconfig\*\.json\)[\s\S]*?"\$file" != tests\/playwright\/\*/],
    ['web/Playwright UI and browser path class', /web\/\*\|web\/\*\*\/\*\|tests\/playwright\/\*\|tests\/playwright\/\*\*\/\*\)[\s\S]*?ui=true[\s\S]*?browser=true/],
    ['non-doc clearing', /if \[\[ "\$docs_like" != true \]\]; then[\s\S]*?docs_only=false/],
    ['empty-list routine/docs-only handling', /if \[\[ ! -s changed-files\.txt \]\]; then[\s\S]*?docs_only=true[\s\S]*?routine\/docs only/],
    ['normal-list initial docs-only classification', /else\s+docs_only=true\s+while IFS= read -r changed_file/],
    ['run-all promotion', /if \[\[ "\$run_all" == true \]\]; then\s+backend=true\s+ui=true\s+browser=true\s+package_or_workflow=true\s+docs_only=false/],
    ['package/workflow promotion', /elif \[\[ "\$package_or_workflow" == true \]\]; then\s+backend=true\s+ui=true\s+browser=true/],
  ];
  for (const [label, pattern] of requirements) {
    requirePattern({ file, text: shell, label: `classifier ${label}`, pattern, failures, checked });
  }
  const failClosedBody = shell.match(/fail_closed\(\) \{([\s\S]*?)\n\s*\}/)?.[1] ?? '';
  requirePattern({ file, text: failClosedBody, label: 'classifier fail-closed run_all assignment', pattern: /run_all=true/, failures, checked });
  requirePattern({ file, text: failClosedBody, label: 'classifier fail-closed docs_only assignment', pattern: /docs_only=false/, failures, checked });
  for (const output of Object.keys(CLASSIFIER_OUTPUTS)) {
    requirePattern({ file, text: shell, label: `classifier ${output} GITHUB_OUTPUT write`, pattern: new RegExp(`echo "${output}=\\$${output}"[\\s\\S]*?\\$GITHUB_OUTPUT`), failures, checked });
  }
}

function validateAggregate({ file, jobs, failures, checked }) {
  const aggregate = jobs?.['validation-required'];
  if (!aggregate || typeof aggregate !== 'object') {
    failures.push(`${file} validation workflow must define validation-required`);
    return;
  }
  const expectedNeeds = ['classify-changes', 'routine-docs', ...Object.keys(PATH_JOBS)];
  checked.push(`${file} validation-required exact needs`);
  if (!Array.isArray(aggregate.needs) || aggregate.needs.length !== expectedNeeds.length || !expectedNeeds.every((name) => aggregate.needs.includes(name))) {
    failures.push(`${file} validation-required needs must contain exactly ${expectedNeeds.join(', ')}`);
  }
  if (expressionBody(aggregate.if) !== 'always()') {
    failures.push(`${file} validation-required must retain if: \${{ always() }}`);
  }
  const enforceStep = scalarRunSteps(aggregate).find((step) => step.name === 'Enforce required validation conclusions') ?? scalarRunSteps(aggregate)[0];
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
  const aggregateRequirements = [
    ['classifier require_success', /require_success classify-changes "\$CLASSIFIER_RESULT"/],
    ['routine require_success', /require_success routine-docs "\$ROUTINE_RESULT"/],
    ['classifier summary line', /classifier: \$CLASSIFIER_RESULT \(\$CLASSIFIER_SUMMARY\)/],
    ['routine summary line', /routine-docs: \$ROUTINE_RESULT/],
    ['failure array initialization', /failures=\(\)/],
    ['require_success semantics', /require_success\(\) \{[^}]*if \[\[ "\$result" != success \]\][^}]*failures\+=/],
    ['applicable success semantics', /require_applicable\(\) \{[^}]*if \[\[ "\$applies" == true \]\]; then[^}]*if \[\[ "\$result" != success \]\][^}]*failures\+=/],
    ['non-applicable skipped semantics', /require_applicable\(\) \{[^}]*else\s+if \[\[ "\$result" != skipped \]\][^}]*failures\+=/],
    ['failure accumulation exit', /if \(\(\$\{#failures\[@\]\} > 0\)\); then[\s\S]*?exit 1/],
  ];
  for (const [label, pattern] of aggregateRequirements) {
    requirePattern({ file, text: shell, label: `aggregate ${label}`, pattern, failures, checked });
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
    requirePattern({ file, text: shell, label: `aggregate ${jobName} require_applicable call`, pattern: new RegExp(`require_applicable ${jobName} "\\$${appliesName}" "\\$${resultName}"`), failures, checked });
    requirePattern({ file, text: shell, label: `aggregate ${jobName} summary line`, pattern: new RegExp(`${jobName}: \\$${resultName} \\(applies=\\$${appliesName}\\)`), failures, checked });
  }
  const allowedEnv = new Set([...Object.keys(exactEnv), ...Object.values(PATH_JOBS).flatMap(({ prefix }) => [`${prefix}_RESULT`, `${prefix}_APPLIES`])]);
  for (const name of Object.keys(env)) {
    if (!allowedEnv.has(name)) failures.push(`${file} validation-required has unexpected aggregate environment state ${name}`);
  }
}

function validateValidationWorkflowContract({ workflowDocuments }) {
  const failures = [];
  const checked = [];
  for (const [file, { content, workflow }] of workflowDocuments) {
    validatePushOnlyTrigger({ file, workflow, failures, checked });
    const executable = JSON.stringify(workflow);
    for (const token of ['schedule', 'workflow_dispatch', 'pull_request', 'run_full_sweep', 'scheduled-release-backstop']) {
      if (executable.includes(token)) failures.push(`${file} validation workflow must not retain obsolete event/backstop token ${token}`);
    }
    const jobs = workflow?.jobs;
    if (!jobs || typeof jobs !== 'object' || Array.isArray(jobs)) {
      failures.push(`${file} validation workflow must define a jobs mapping`);
      continue;
    }
    validateClassifier({ file, jobs, failures, checked });
    validateAggregate({ file, jobs, failures, checked });

    const backendRuns = scalarRunSteps(jobs['backend-jest-build']).map(({ run }) => run);
    const expectedBackendRuns = ['npm ci', 'cd web && npm ci', 'npm run build', 'npm test'];
    checked.push(`${file} exact backend install/build/test order`);
    if (JSON.stringify(backendRuns) !== JSON.stringify(expectedBackendRuns)) {
      failures.push(`${file} backend-jest-build scalar commands must be exactly ${expectedBackendRuns.join(' -> ')}`);
    }

    const browser = jobs['browser-smoke'];
    const browserRuns = scalarRunSteps(browser).map(({ run }) => run);
    const expectedBrowserRuns = ['npm ci', 'cd web && npm ci', 'npm run web:test:e2e:install', 'npx playwright install-deps chromium', 'npm run web:test:e2e:smoke'];
    checked.push(`${file} exact browser setup and smoke command order`);
    if (JSON.stringify(browserRuns) !== JSON.stringify(expectedBrowserRuns)) {
      failures.push(`${file} browser-smoke scalar commands must be exactly ${expectedBrowserRuns.join(' -> ')}`);
    }
    const browserSteps = Array.isArray(browser?.steps) ? browser.steps : [];
    if (!browserSteps.some((step) => step?.uses === 'actions/checkout@v4')) failures.push(`${file} browser-smoke must check out with actions/checkout@v4`);
    const browserNode = browserSteps.find((step) => step?.uses === 'actions/setup-node@v4');
    if (`${browserNode?.with?.['node-version']}` !== '24') failures.push(`${file} browser-smoke must set up Node 24 with actions/setup-node@v4`);
    if (browserNode?.with?.cache !== 'npm') failures.push(`${file} browser-smoke Node setup must retain npm caching`);
    const smokeIndex = browserSteps.findIndex((step) => step?.run === 'npm run web:test:e2e:smoke');
    const artifactSteps = browserSteps.filter((step) => step?.uses === 'actions/upload-artifact@v4');
    const workflowArtifactSteps = Object.values(jobs).flatMap((job) => Array.isArray(job?.steps) ? job.steps : []).filter((step) => step?.uses === 'actions/upload-artifact@v4');
    checked.push(`${file} browser failure/cancellation artifact semantics and order`);
    if (artifactSteps.length !== 1 || workflowArtifactSteps.length !== 1) {
      failures.push(`${file} validation workflow must contain exactly one actions/upload-artifact@v4 step, in browser-smoke`);
    } else {
      const artifact = artifactSteps[0];
      if (browserSteps[smokeIndex + 1] !== artifact) failures.push(`${file} browser artifact upload must immediately follow the browser smoke command`);
      if (expressionBody(artifact.if) !== 'failure() || cancelled()') failures.push(`${file} browser artifact upload condition must be exactly failure() || cancelled()`);
      const artifactPaths = typeof artifact.with?.path === 'string' ? artifact.with.path.split(/\r?\n/).map((value) => value.trim()).filter(Boolean) : [];
      if (JSON.stringify(artifactPaths) !== JSON.stringify(['tmp/playwright-report', 'tmp/playwright-results'])) failures.push(`${file} browser artifact upload paths must be exactly tmp/playwright-report and tmp/playwright-results in that order`);
      if (artifact.with?.['if-no-files-found'] !== 'warn') failures.push(`${file} browser artifact upload must set if-no-files-found: warn`);
      if (Object.hasOwn(artifact, 'continue-on-error')) failures.push(`${file} browser artifact upload must not set continue-on-error`);
    }
    if (content.includes('web:test:live-getrich-v2') || content.includes('live-getrich-v2.config.ts')) failures.push(`${file} validation workflow must exclude the external live GetRich v2 suite`);

    const dependency = jobs['dependency-hygiene'];
    checked.push(`${file} path-aware production dependency audit gate`);
    const dependencyRuns = scalarRunSteps(dependency).map(({ run }) => run);
    for (const command of ['npm ci', 'cd web && npm ci', 'npm run audit:security']) {
      if (!dependencyRuns.includes(command)) failures.push(`${file} dependency-hygiene must run ${command}`);
    }
    if (content.includes('npm run deps:review')) failures.push(`${file} dependency-hygiene must not run the local-only deps:review command in CI`);
  }
  return { checked, failures };
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
  for (const file of ['README.md', DATED_LIVE_VALIDATION_RECORD]) {
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

  const readme = existsSync(path.join(root, 'README.md')) ? readFileSync(path.join(root, 'README.md'), 'utf8') : '';
  const requirements = [
    ['root/web clean-install build order', /npm ci\s*\n\(cd web && npm ci\)\s*\nnpm run build/],
    ['backend dual clean install', /backend-jest-build[\s\S]{0,300}root `npm ci`[\s\S]{0,160}web `cd web && npm ci`/i],
    ['30-test self-contained smoke ownership', /web:test:e2e:smoke[\s\S]{0,300}30[\s\S]{0,200}self-contained/i],
    ['preview and dev-server prerequisites', /preview[\s\S]{0,200}dev server/i],
    ['live command and reachable deployment prerequisite', /npm run web:test:live-getrich-v2[\s\S]{0,260}reachable deployment/i],
    ['live base URL override', /SAIVAGE_LIVE_BASE_URL/],
    ['best-effort failed or cancelled browser artifacts', /failed or cancelled[\s\S]{0,220}best-effort[\s\S]{0,220}tmp\/playwright-report[\s\S]{0,100}tmp\/playwright-results/i],
  ];
  for (const [label, pattern] of requirements) {
    checked.push(`README.md ${label}`);
    if (!pattern.test(readme)) failures.push(`README.md must document ${label}`);
  }

  const recordPath = path.join(root, DATED_LIVE_VALIDATION_RECORD);
  const record = existsSync(recordPath) ? readFileSync(recordPath, 'utf8') : '';
  for (const required of ['npm run web:test:live-getrich-v2', 'SAIVAGE_LIVE_BASE_URL', 'tests/playwright/live-getrich-v2/live-getrich-v2.spec.ts:36', 'tests/playwright/live-getrich-v2/live-getrich-v2-coverage.spec.ts:167']) {
    checked.push(`${DATED_LIVE_VALIDATION_RECORD} ${required}`);
    if (!record.includes(required)) failures.push(`${DATED_LIVE_VALIDATION_RECORD} must contain ${required}`);
  }
  if (!/reachable deployment/i.test(record)) failures.push(`${DATED_LIVE_VALIDATION_RECORD} must state the reachable-deployment prerequisite`);
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

function validateFailClosedJestGates({ scripts, workflowCommands }) {
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

  for (const location of workflowCommands) {
    const command = location.replace(/^[^:]+:\d+:\s*/, '');
    for (const segment of splitCommandSegments(command)) {
      if (commandUsesPassWithNoTests(segment)) {
        failures.push(`${location} must not use ${PASS_WITH_NO_TESTS_FLAG}; CI validation gates must fail when no tests are discovered`);
      }
      const referencedScript = npmRunScriptName(segment);
      if (referencedScript && isAllowEmptyScriptName(referencedScript)) {
        failures.push(`${location} must not reference allow-empty script ${referencedScript}; CI validation gates must fail when no tests are discovered`);
      }
    }
  }

  return { checked, failures };
}

function markdownCorpus(markdownByFile) {
  return [...markdownByFile.values()].join('\n\n');
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
      failures.push(`required validation script "${required.name}" is not documented in README.md or docs/architecture/system-architecture.md validation cadence`);
    }
  }

  return { checked, failures };
}

function validateValidationProfiles({ scripts, documentedCommands, markdownByFile }) {
  const failures = [];
  const checked = [];
  const corpus = markdownCorpus(markdownByFile);

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
      failures.push(`validation profile "${profile.name}" is not documented in README.md or docs/architecture/system-architecture.md validation cadence`);
    }
    if (profile.documentedExclusion && !profile.documentedExclusion.test(corpus)) {
      failures.push(`validation profile "${profile.name}" has intentional exclusions, but the exclusion is not documented near the profile command`);
    }
  }

  return { checked, failures };
}


function expectedWebTestAliasTarget(scriptName) {
  if (scriptName === 'test:web') {
    return 'web:test';
  }
  if (scriptName.startsWith('test:web:')) {
    return `web:test:${scriptName.slice('test:web:'.length)}`;
  }
  return null;
}

function validateDocumentedWebTestAliases({ scripts, documentedCommands }) {
  const failures = [];
  const checked = [];

  for (const location of documentedCommands) {
    const command = location.replace(/^.*?:\s*/, '');
    const scriptName = npmRunScriptName(command);
    const canonical = scriptName ? expectedWebTestAliasTarget(scriptName) : null;
    if (!scriptName || !canonical) {
      continue;
    }

    checked.push(`package.json alias ${scriptName} -> ${canonical}`);
    if (!scripts[canonical]) {
      failures.push(`${location} documents npm run ${scriptName}, but canonical package.json script "${canonical}" is missing`);
      continue;
    }
    const aliasCommand = scripts[scriptName];
    const expected = `npm run ${canonical}`;
    if (!aliasCommand) {
      failures.push(`${location} documents npm run ${scriptName}, but package.json has no "${scriptName}" alias to "${canonical}"`);
      continue;
    }
    if (aliasCommand.trim() !== expected) {
      failures.push(`package.json alias "${scriptName}" must be exactly "${expected}", but is currently: ${aliasCommand}`);
    }
  }

  return { checked, failures };
}

function validateRuntimeEngines({ root, workflowFiles = DEFAULT_WORKFLOW_DIRS.flatMap(() => []), markdownByFile }) {
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

  for (const file of workflowFiles) {
    const fullPath = path.join(root, file);
    if (!existsSync(fullPath)) {
      continue;
    }
    const content = readFileSync(fullPath, 'utf8');
    checked.push(`${file} setup-node ${workflowNodeVersion(content) ?? 'missing'}`);
  }

  for (const file of REQUIRED_RUNTIME_DOC_FILES) {
    const markdown = markdownByFile.get(file) ?? (existsSync(path.join(root, file)) ? readFileSync(path.join(root, file), 'utf8') : '');
    checked.push(`${file} runtime reference`);
    if (!RUNTIME_REFERENCE_PATTERN.test(markdown)) {
      failures.push(`${file} must document the supported runtime as Node.js ${EXPECTED_NODE_MAJOR} with ${EXPECTED_NPM_ENGINE} npm range or clearly defer to package.json engines/CI`);
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
  const scripts = options.packageScripts ?? readPackageScripts(root);
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
  const validationWorkflowContract = validateValidationWorkflowContract({ workflowDocuments: workflow.workflowDocuments });
  const requiredScripts = validateRequiredValidationScripts({
    scripts,
    documentedCommands: documented.checked,
  });
  const profiles = validateValidationProfiles({
    scripts,
    documentedCommands: documented.checked,
    markdownByFile: documented.markdownByFile,
  });
  const webTestAliases = validateDocumentedWebTestAliases({
    scripts,
    documentedCommands: documented.checked,
  });
  const runtimeEngines = validateRuntimeEngines({ root, workflowFiles: workflow.workflowFilesChecked, markdownByFile: documented.markdownByFile });
  const docsVerify = validateDocsVerifySubguards({ root, scripts });
  const failClosedJest = validateFailClosedJestGates({ scripts, workflowCommands: workflow.checked });
  const playwrightOwnership = validatePlaywrightOwnership({ root, scripts });
  const playwrightDocumentation = validatePlaywrightDocumentation({ root });
  const failures = [...documented.failures, ...workflow.failures, ...validationWorkflowContract.failures, ...requiredScripts.failures, ...profiles.failures, ...webTestAliases.failures, ...runtimeEngines.failures, ...docsVerify.failures, ...failClosedJest.failures, ...playwrightOwnership.failures, ...playwrightDocumentation.failures];
  return {
    ok: failures.length === 0,
    failures,
    documentedCommandsChecked: documented.checked,
    workflowCommandsChecked: workflow.checked,
    validationWorkflowContractEntriesChecked: validationWorkflowContract.checked,
    workflowFilesChecked: workflow.workflowFilesChecked,
    requiredValidationScriptsChecked: requiredScripts.checked,
    validationProfilesChecked: profiles.checked,
    webTestAliasEntriesChecked: webTestAliases.checked,
    runtimeEngineEntriesChecked: runtimeEngines.checked,
    docsVerifyEntriesChecked: docsVerify.checked,
    failClosedJestGateEntriesChecked: failClosedJest.checked,
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
    `✓ validation cadence check passed — ${result.documentedCommandsChecked.length} documented validation command(s), ${result.workflowCommandsChecked.length} workflow command(s), ${result.requiredValidationScriptsChecked.length} required validation script(s), ${result.validationProfilesChecked.length} validation profile(s), ${result.webTestAliasEntriesChecked.length} web-test alias item(s), ${result.runtimeEngineEntriesChecked.length} runtime engine alignment item(s), ${result.docsVerifyEntriesChecked.length} docs:verify sub-guard entry point(s), and ${result.failClosedJestGateEntriesChecked.length} fail-closed Jest gate item(s) resolve`,
  );
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  main();
}
