#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as YAML from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceFile = join(repoRoot, 'src', 'utils', 'prompt-defaults.yaml');
const stalePromptDir = join(repoRoot, 'dist', 'prompts');
const outputDir = join(repoRoot, 'dist', 'src', 'utils');
const outputFile = join(outputDir, 'prompt-defaults.yaml');
const roleKeys = ['planner', 'executor', 'reviewer', 'analyst'];

function assertDefaultsFile(path) {
  if (!existsSync(path)) {
    throw new Error(`Prompt defaults file is missing: ${relative(repoRoot, path)}`);
  }

  const parsed = YAML.parse(readFileSync(path, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Prompt defaults file must contain a YAML mapping: ${relative(repoRoot, path)}`);
  }

  const keys = Object.keys(parsed).sort();
  const expected = [...roleKeys].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error(`Prompt defaults file must contain exactly these role keys: ${roleKeys.join(', ')}`);
  }

  for (const role of roleKeys) {
    if (typeof parsed[role] !== 'string' || parsed[role].length === 0) {
      throw new Error(`Prompt defaults file role must be a non-empty string: ${role}`);
    }
  }
}

function assertStalePromptDirRemoved() {
  if (!existsSync(stalePromptDir)) return;
  const entries = readdirSync(stalePromptDir);
  if (entries.length > 0) {
    throw new Error(`Obsolete prompt asset directory still contains files: ${relative(repoRoot, stalePromptDir)}`);
  }
  throw new Error(`Obsolete prompt asset directory still exists: ${relative(repoRoot, stalePromptDir)}`);
}

function copyPromptDefaults() {
  rmSync(stalePromptDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  copyFileSync(sourceFile, outputFile);

  assertDefaultsFile(outputFile);
  assertStalePromptDirRemoved();

  console.log(`Copied prompt defaults to ${relative(repoRoot, outputFile)}`);
}

try {
  copyPromptDefaults();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
