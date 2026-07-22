#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenizePromptTemplate } from './prompt-placeholder-validator.js';
import { createPromptTemplateRegistry } from '../src/utils/prompt-api.js';
import { DEFAULT_SAIVAGE_CONFIG } from '../src/agents/default-workflow-config.js';
import { compileProjectWorkflows } from '../src/runtime/card-process/card-process-config.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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
  const planningProcessPrompts = ['plan', 'recover', 'review', 'correct-plan-result', 'correct-review-result', 'plan-to-review', 'review-to-plan', 'stopped-recovery'];
  const terminalProcessPrompts = ['execute', 'correct-execution-result', 'stopped-recovery'];
  const agentPrompts = ['analyst', 'planner', 'reviewer', 'executor'].map((agent) => join('agents', `${agent}.md`));
  const expected = [
    ...agentPrompts,
    ...['project', 'goal'].flatMap((cardType) => planningProcessPrompts.map((id) => join(cardType, 'process', `${id}.md`))),
    ...['architecture', 'code', 'test', 'doc', 'data', 'research', 'ops'].flatMap((cardType) => terminalProcessPrompts.map((id) => join(cardType, 'process', `${id}.md`))),
  ].sort();
  const actual = walkFiles(root);
  if (actual.length !== expected.length || actual.some((file, index) => file !== expected[index])) {
    throw new Error(`Prompt defaults directory must contain exactly: ${expected.join(', ')}`);
  }
  for (const file of agentPrompts) {
    tokenizePromptTemplate(file, join(root, file));
  }
  createPromptTemplateRegistry(compileProjectWorkflows(DEFAULT_SAIVAGE_CONFIG), { defaultRoot: root });
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
