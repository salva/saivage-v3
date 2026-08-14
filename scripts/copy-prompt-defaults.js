#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  const processPrompts = new Set();
  for (const cardType of Object.values(DEFAULT_SAIVAGE_CONFIG.card_types)) {
    for (const entry of Object.values(cardType.workflow.entries)) if (entry.prompt !== undefined) processPrompts.add(entry.prompt);
    for (const node of Object.values(cardType.workflow.nodes)) {
      processPrompts.add(node.prompt);
      processPrompts.add(node.correction_prompt);
      for (const edge of Object.values(node.edges)) if (edge.prompt !== undefined) processPrompts.add(edge.prompt);
    }
  }
  const requiredProcessPrompts = ['correct-execution-result', 'correct-plan-result', 'correct-review-result', 'execute', 'plan', 'plan-to-review', 'recover', 'review', 'review-to-plan', 'stopped-recovery'];
  const referencedProcessPrompts = [...processPrompts].sort();
  if (JSON.stringify(referencedProcessPrompts) !== JSON.stringify(requiredProcessPrompts)) {
    throw new Error(`Default workflow process-prompt closure must be exactly: ${requiredProcessPrompts.join(', ')}`);
  }
  const agentPrompts = [...new Set(Object.values(DEFAULT_SAIVAGE_CONFIG.agents).map((agent) => agent.prompt))].map((reference) => join('agents', '_shared', `${reference}.md`));
  const expected = [
    ...agentPrompts,
    ...referencedProcessPrompts.map((id) => join('process', '_shared', `${id}.md`)),
  ].sort();
  const actual = walkFiles(root);
  if (actual.length !== expected.length || actual.some((file, index) => file !== expected[index])) {
    throw new Error(`Prompt defaults directory must contain exactly: ${expected.join(', ')}`);
  }
  compileProjectWorkflows(DEFAULT_SAIVAGE_CONFIG, { defaultPromptRoot: root });
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
