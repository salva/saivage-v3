#!/usr/bin/env node

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { copyPromptDefaults } from '../../scripts/copy-prompt-defaults.js';
import { assertPromptPlaceholders, tokenizePromptTemplate } from '../../scripts/prompt-placeholder-validator.js';

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

function walkFiles(root, current = root) {
  const files = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(root, path));
    else if (entry.isFile()) files.push(relative(root, path));
  }
  return files.sort();
}

function writeFixtureTree(root) {
  for (const agent of ['analyst', 'planner', 'reviewer', 'executor']) {
    const path = join(root, 'agents', `${agent}.md`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${agent} {{contractDescription}} {{toolList}}`);
  }
  for (const cardType of ['project', 'goal']) {
    for (const id of ['plan', 'recover', 'review', 'correct-plan-result', 'correct-review-result', 'plan-to-review', 'review-to-plan', 'stopped-recovery']) {
      const path = join(root, cardType, 'process', `${id}.md`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${cardType}/${id}`);
    }
  }
  for (const cardType of ['architecture', 'code', 'test', 'doc', 'data', 'research', 'ops']) {
    for (const id of ['execute', 'correct-execution-result', 'stopped-recovery']) {
      const path = join(root, cardType, 'process', `${id}.md`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${cardType}/${id}`);
    }
  }
}

function assertTreesEqual(sourceRoot, outputRoot) {
  const sourceFiles = walkFiles(sourceRoot);
  const outputFiles = walkFiles(outputRoot);
  if (sourceFiles.join('\n') !== outputFiles.join('\n')) fail('copied prompt file set does not match source tree');
  for (const file of sourceFiles) {
    const source = readFileSync(join(sourceRoot, file), 'utf8');
    const output = readFileSync(join(outputRoot, file), 'utf8');
    if (source !== output) fail(`copied prompt content does not match for ${file}`);
  }
}

function assertPlaceholderValidationRejectsInvalidTemplates() {
  assertThrows('stray close placeholder', () => tokenizePromptTemplate('Use }}', 'test'), "stray '}}'");
  assertThrows('nested placeholder', () => tokenizePromptTemplate('Use {{outer {{inner}}', 'test'), 'nested placeholder');
  assertThrows('unknown placeholder', () => assertPromptPlaceholders('Use {{cardTitle}}', 'test', new Set(['cardId'])), 'unknown placeholder: cardTitle');
}

function runCopyPromptDefaultsTest() {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'saivage-copy-source-'));
  const outputRoot = mkdtempSync(join(tmpdir(), 'saivage-copy-output-'));
  const staleYaml = join('dist', 'src', 'utils', `prompt-${'defaults'}.yaml`);
  try {
    writeFixtureTree(sourceRoot);
    writeFileSync(join(outputRoot, 'stale.md'), 'stale');
    mkdirSync(dirname(staleYaml), { recursive: true });
    writeFileSync(staleYaml, 'stale yaml');
    copyPromptDefaults({ sourceRoot, outputRoot });
    if (existsSync(join(outputRoot, 'stale.md'))) fail('stale output file survived copy');
    if (existsSync(staleYaml)) fail('stale YAML prompt defaults survived copy');
    assertTreesEqual(sourceRoot, outputRoot);
    copyPromptDefaults({ sourceRoot, outputRoot });
    assertTreesEqual(sourceRoot, outputRoot);
    assertPlaceholderValidationRejectsInvalidTemplates();
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(outputRoot, { recursive: true, force: true });
  }
}

if (typeof globalThis.test === 'function') {
  globalThis.test('copies prompt defaults as a directory tree idempotently', () => {
    runCopyPromptDefaultsTest();
  });
} else {
  runCopyPromptDefaultsTest();
  console.log('copy-prompt-defaults test passed');
}
