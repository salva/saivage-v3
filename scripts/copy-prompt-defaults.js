#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenizePromptTemplate } from './prompt-placeholder-validator.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const activePairs = [
  ['project', 'planner'],
  ['project', 'reviewer'],
  ['goal', 'planner'],
  ['goal', 'reviewer'],
  ['architecture', 'executor'],
  ['code', 'executor'],
  ['test', 'executor'],
  ['doc', 'executor'],
  ['data', 'executor'],
  ['research', 'executor'],
  ['ops', 'executor'],
  ['analyst', 'analyst'],
];

function walkFiles(root, current = root) {
  const files = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(root, path));
    else if (entry.isFile()) files.push(relative(root, path));
  }
  return files.sort();
}

function assertPromptTree(root) {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`Prompt defaults directory is missing: ${relative(repoRoot, root)}`);
  }
  const expected = activePairs.map(([cardType, role]) => join(cardType, `${role}.md`)).sort();
  const actual = walkFiles(root);
  if (actual.length !== expected.length || actual.some((file, index) => file !== expected[index])) {
    throw new Error(`Prompt defaults directory must contain exactly: ${expected.join(', ')}`);
  }
  for (const file of actual) {
    tokenizePromptTemplate(file, join(root, file));
  }
}

function copyTree(sourceRoot, outputRoot) {
  rmSync(outputRoot, { recursive: true, force: true });
  for (const relativePath of walkFiles(sourceRoot)) {
    const source = join(sourceRoot, relativePath);
    const destination = join(outputRoot, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
}

export function copyPromptDefaults({ sourceRoot = join(repoRoot, 'src', 'prompts'), outputRoot = join(repoRoot, 'dist', 'prompts') } = {}) {
  rmSync(join(repoRoot, 'dist', 'src', 'utils', `prompt-${'defaults'}.yaml`), { force: true });
  assertPromptTree(sourceRoot);
  copyTree(sourceRoot, outputRoot);
  assertPromptTree(outputRoot);
  return walkFiles(outputRoot);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const copied = copyPromptDefaults();
    console.log(`Copied ${copied.length} prompt defaults to ${relative(repoRoot, join(repoRoot, 'dist', 'prompts'))}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
