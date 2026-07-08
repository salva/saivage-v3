#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as YAML from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const staleDir = join(repoRoot, 'dist', 'prompts');
const outputFile = join(repoRoot, 'dist', 'src', 'utils', 'prompt-defaults.yaml');
const roleKeys = ['planner', 'executor', 'reviewer', 'analyst'];

function fail(message) {
  throw new Error(message);
}

function assertDefaultsValid() {
  if (!existsSync(outputFile)) fail('prompt-defaults.yaml was not copied to dist/src/utils');
  const parsed = YAML.parse(readFileSync(outputFile, 'utf8'));
  const keys = Object.keys(parsed).sort();
  const expected = [...roleKeys].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    fail(`defaults.yaml has wrong role keys: ${keys.join(', ')}`);
  }
}

function assertStaleDirGone() {
  if (!existsSync(staleDir)) return;
  const entries = readdirSync(staleDir);
  if (entries.length > 0) fail('dist/prompts still contains stale files');
  fail('dist/prompts still exists');
}

function runCopyPromptDefaultsTest() {
  mkdirSync(staleDir, { recursive: true });
  writeFileSync(join(staleDir, 'stale.md'), 'stale');
  writeFileSync(join(staleDir, 'planner.md'), 'old planner');

  try {
    execFileSync('node', ['scripts/copy-prompt-defaults.js'], { cwd: repoRoot, stdio: 'inherit' });
    assertStaleDirGone();
    assertDefaultsValid();

    execFileSync('node', ['scripts/copy-prompt-defaults.js'], { cwd: repoRoot, stdio: 'inherit' });
    assertStaleDirGone();
    assertDefaultsValid();
  } finally {
    rmSync(staleDir, { recursive: true, force: true });
  }
}

if (typeof globalThis.test === 'function') {
  globalThis.test('copies prompt defaults and removes stale dist prompt files idempotently', () => {
    runCopyPromptDefaultsTest();
  });
} else {
  runCopyPromptDefaultsTest();
  console.log('copy-prompt-defaults test passed');
}
