#!/usr/bin/env node

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { copyPromptDefaults } from '../../scripts/copy-prompt-defaults.js';

function fail(message) {
  throw new Error(message);
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
    const path = join(root, 'agents', '_shared', `${agent}.md`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, agent === 'analyst' ? `${agent} {{toolList}} {{projectContext}} {{vocabularySnippet}}` : `${agent} {{contractDescription}} {{toolList}}`);
  }
  for (const id of ['plan', 'recover', 'review', 'correct-plan-result', 'correct-review-result', 'plan-to-review', 'review-to-plan', 'execute', 'correct-execution-result', 'stopped-recovery']) {
    const path = join(root, 'process', '_shared', `${id}.md`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${id} {{cardType}}`);
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

function runCopyPromptDefaultsTest() {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'saivage-copy-source-'));
  const outputRoot = mkdtempSync(join(tmpdir(), 'saivage-copy-output-'));
  try {
    writeFixtureTree(sourceRoot);
    writeFileSync(join(outputRoot, 'stale.md'), 'stale');
    copyPromptDefaults({ sourceRoot, outputRoot });
    if (existsSync(join(outputRoot, 'stale.md'))) fail('stale output file survived copy');
    assertTreesEqual(sourceRoot, outputRoot);
    copyPromptDefaults({ sourceRoot, outputRoot });
    assertTreesEqual(sourceRoot, outputRoot);
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
