#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_NAMES = ['storage', 'execution', 'interfaces', 'configuration', 'tooling'];
const ISOLATED = {
  'test:redaction-progress': 'tests/utils/redaction-key-progress.test.ts',
  'test:terminal-child': 'tests/boot/app-terminal-child-process.test.ts',
};

export function parseDiscovery(result, label, root) {
  if (result.error || result.status !== 0 || result.signal) {
    throw new Error(`${label}: Jest discovery failed (${result.error?.message ?? result.signal ?? result.status})\n${result.stderr ?? ''}`);
  }
  let files;
  try {
    files = JSON.parse(result.stdout);
  } catch {
    throw new Error(`${label}: malformed Jest discovery JSON`);
  }
  if (!Array.isArray(files) || files.length === 0
      || files.some((file) => typeof file !== 'string' || !path.isAbsolute(file))) {
    throw new Error(`${label}: zero or invalid Jest discovery`);
  }
  const normalized = files.map((file) => path.relative(root, path.normalize(file)).split(path.sep).join('/')).sort();
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label}: duplicate discovery paths`);
  return normalized;
}

function discover(root, script, args = []) {
  const result = spawnSync('npm', ['run', '--silent', script, '--', ...args, '--listTests', '--json', '--runInBand'], {
    cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  return parseDiscovery(result, script, root);
}

function compare(actual, expected, label, failures) {
  for (const file of expected) if (!actual.has(file)) failures.push(`${label}: missing ${file}`);
  for (const file of actual) if (!expected.has(file)) failures.push(`${label}: unexpected ${file}`);
}

export function checkTestPartitions(root = fileURLToPath(new URL('..', import.meta.url))) {
  const require = createRequire(path.join(root, 'package.json'));
  const config = require('./scripts/jest-focused.config.cjs');
  const names = config.projects.map((project) => project.displayName);
  if (names.length !== PROJECT_NAMES.length || new Set(names).size !== names.length
      || names.some((name) => !PROJECT_NAMES.includes(name))) {
    throw new Error(`unknown, missing or duplicate focused project names: ${JSON.stringify(names)}`);
  }
  const ordinary = discover(root, 'test:direct');
  const projects = Object.fromEntries(PROJECT_NAMES.map((name) => [name, discover(root, `test:focus:${name}`)]));
  const failures = [];
  const union = new Set();
  for (const [name, files] of Object.entries(projects)) {
    for (const file of files) {
      if (union.has(file)) failures.push(`duplicate ownership: ${file} (including ${name})`);
      union.add(file);
    }
  }
  compare(union, new Set(ordinary), 'focused union', failures);
  const isolated = {};
  for (const [script, file] of Object.entries(ISOLATED)) {
    isolated[script] = discover(root, script);
    compare(new Set(isolated[script]), new Set([file]), script, failures);
    if (ordinary.includes(file)) failures.push(`duplicate ordinary/isolated ownership: ${file}`);
  }
  const complete = discover(root, 'test:direct', ['--testPathIgnorePatterns=<rootDir>/tests/(playwright|e2e)/']);
  compare(new Set([...ordinary, ...Object.values(isolated).flat()]), new Set(complete), 'non-E2E union', failures);
  if (failures.length) throw new Error(failures.join('\n'));
  return { ordinary, projects, isolated, complete };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(checkTestPartitions(), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
