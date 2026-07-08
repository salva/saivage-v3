#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as YAML from 'yaml';
import { assertGuidancePlaceholders } from '../../scripts/prompt-placeholder-validator.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const staleDir = join(repoRoot, 'dist', 'prompts');
const outputFile = join(repoRoot, 'dist', 'src', 'utils', 'prompt-defaults.yaml');
const roleKeys = ['planner', 'executor', 'reviewer', 'analyst'];
const topLevelKeys = [...roleKeys, 'cardTypeGuidance'];

function fail(message) {
  throw new Error(message);
}

function assertThrows(message, fn, expectedText) {
  try {
    fn();
  } catch (error) {
    const actual = error instanceof Error ? error.message : String(error);
    if (!actual.includes(expectedText)) fail(`${message}: expected error containing ${expectedText}, got ${actual}`);
    return;
  }
  fail(`${message}: expected error`);
}

function assertDefaultsValid() {
  if (!existsSync(outputFile)) fail('prompt-defaults.yaml was not copied to dist/src/utils');
  const parsed = YAML.parse(readFileSync(outputFile, 'utf8'));
  const keys = Object.keys(parsed).sort();
  const expected = [...topLevelKeys].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    fail(`defaults.yaml has wrong top-level keys: ${keys.join(', ')}`);
  }
  for (const role of roleKeys) {
    if (typeof parsed[role] !== 'string' || parsed[role].length === 0) fail(`defaults.yaml has invalid role template: ${role}`);
  }
  const guidance = parsed.cardTypeGuidance;
  if (guidance === null || typeof guidance !== 'object' || Array.isArray(guidance)) fail('defaults.yaml cardTypeGuidance is not a mapping');
  if (typeof guidance.default !== 'string' || guidance.default.length === 0) fail('defaults.yaml cardTypeGuidance.default is invalid');
  for (const [key, value] of Object.entries(guidance)) {
    if (typeof value !== 'string' || value.length === 0) fail(`defaults.yaml cardTypeGuidance.${key} is invalid`);
    assertGuidancePlaceholders(key, value);
  }
}

function assertPlaceholderValidationRejectsInvalidTemplates() {
  assertThrows('unsupported guidance placeholder', () => assertGuidancePlaceholders('test', 'Use {{cardTitle}}'), 'unsupported placeholder: cardTitle');
  assertThrows('malformed guidance placeholder', () => assertGuidancePlaceholders('test', 'Use {{card-type}}'), 'malformed placeholder');
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
    assertPlaceholderValidationRejectsInvalidTemplates();
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
