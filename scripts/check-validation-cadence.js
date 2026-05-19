#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_DOCUMENTED_COMMAND_FILES = [
  'README.md',
  'docs/runbook/release.md',
  'docs/runbook/index.md',
];

const REQUIRED_VALIDATION_SCRIPTS = [
  {
    name: 'web:test:operator-smoke',
    mustInclude: 'operator-dashboard-smoke.test.ts',
    description: 'direct operator-dashboard smoke guard',
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

function splitCommandSegments(command) {
  return command
    .split(/\s+(?:&&|;)\s+/)
    .map((segment) => stripEnvAssignments(segment))
    .filter(Boolean);
}

function readPackageScripts(root) {
  const packagePath = path.join(root, 'package.json');
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  return pkg.scripts ?? {};
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
    for (const command of bashFenceCommands(markdown)) {
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
    if (required.mustInclude && !command.includes(required.mustInclude)) {
      failures.push(`package.json script "${required.name}" must run ${required.mustInclude}, but is currently: ${command}`);
    }
    const documented = documentedCommands.some((location) => location.includes(`npm run ${required.name}`));
    if (!documented) {
      failures.push(`required validation script "${required.name}" is not documented in README.md or docs/runbook/*.md validation cadence`);
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
  const requiredScripts = validateRequiredValidationScripts({
    scripts,
    documentedCommands: documented.checked,
  });
  const docsVerify = validateDocsVerifySubguards({ root, scripts });
  const failures = [...documented.failures, ...requiredScripts.failures, ...docsVerify.failures];
  return {
    ok: failures.length === 0,
    failures,
    documentedCommandsChecked: documented.checked,
    requiredValidationScriptsChecked: requiredScripts.checked,
    docsVerifyEntriesChecked: docsVerify.checked,
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
    `✓ validation cadence check passed — ${result.documentedCommandsChecked.length} documented validation command(s), ${result.requiredValidationScriptsChecked.length} required validation script(s), and ${result.docsVerifyEntriesChecked.length} docs:verify sub-guard entry point(s) resolve`,
  );
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  main();
}
