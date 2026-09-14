#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { SYSTEM_TEMPLATES, resolveSystemTemplate } from '../../src/config/system-templates/registry.js';
import { minimalSystemTemplate, secondSystemTemplate } from '../fixtures/system-templates/minimal.js';
import { collectTemplatePromptClosure, copySystemTemplatePrompts } from '../../scripts/copy-system-template-prompts.js';

function fail(message) { throw new Error(message); }
function assert(condition, message) { if (!condition) fail(message); }
function expectThrows(run, pattern, message) {
  try { run(); } catch (error) {
    if (pattern.test(error instanceof Error ? error.message : String(error))) return;
    throw error;
  }
  fail(message);
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

function write(root, purpose, scope, id, text) {
  const path = join(root, purpose, scope, `${id}.md`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function assertTreesEqual(sourceRoot, outputRoot) {
  const sourceFiles = walkFiles(sourceRoot);
  const outputFiles = walkFiles(outputRoot);
  assert(sourceFiles.join('\n') === outputFiles.join('\n'), 'copied prompt file set does not match source tree');
  for (const file of sourceFiles) {
    assert(readFileSync(join(sourceRoot, file), 'utf8') === readFileSync(join(outputRoot, file), 'utf8'), `copied prompt content does not match for ${file}`);
  }
}

const CLASSIC_CLOSURE = [
  'agents/_shared/analyst.md', 'agents/_shared/executor.md', 'agents/_shared/planner.md', 'agents/_shared/reviewer.md',
  ...['common', 'planner', 'executor', 'reviewer', 'analyst'].map((id) => `fragments/_shared/project-guidance-${id}.md`),
  'process/_shared/correct-execution-result.md', 'process/_shared/correct-plan-result.md', 'process/_shared/correct-review-result.md',
  'process/_shared/execute.md', 'process/_shared/plan-to-review.md', 'process/_shared/plan.md', 'process/_shared/recover.md',
  'process/_shared/handle-notifications.md', 'process/_shared/review-to-notifications.md',
  'process/_shared/review-to-plan.md', 'process/_shared/review.md', 'process/_shared/stopped-recovery.md',
].sort();
const TYPED_CLOSURE = [
  ...['analyst', 'executor', 'planner', 'reviewer'].map((id) => `agents/_shared/${id}.md`),
  ...['common', 'planner', 'executor', 'reviewer', 'analyst'].map((id) => `fragments/_shared/project-guidance-${id}.md`),
  ...['correct-execution-result', 'correct-plan-result', 'correct-review-result', 'execute', 'handle-notifications', 'review-to-notifications', 'specialized-plan-to-review', 'specialized-plan', 'specialized-recover', 'specialized-review-to-plan', 'specialized-review', 'stopped-recovery'].map((id) => `process/_shared/${id}.md`),
  ...['code-red', 'code-green', 'code-refactor', 'code-red-to-green', 'code-to-refactor', 'code-green-retry', 'code-regression-to-green'].map((id) => `process/code/${id}.md`),
  ...['test-diagnose', 'test-add-coverage', 'test-repair', 'test-verify', 'test-to-add-coverage', 'test-to-repair', 'test-to-verify', 'test-repair-retry'].map((id) => `process/test/${id}.md`),
  ...['research-explore', 'research-assess', 'research-report', 'research-to-assess', 'research-continue-exploration', 'research-supported-to-report', 'research-refuted-to-report', 'research-inconclusive-to-report'].map((id) => `process/research/${id}.md`),
  ...['data-schema', 'data-validate', 'data-implement', 'data-to-validate', 'data-to-implement', 'data-revise-schema', 'data-implementation-retry'].map((id) => `process/data/${id}.md`),
  ...['architecture-draft', 'architecture-component-review', 'architecture-system-review', 'architecture-to-component-review', 'architecture-to-system-review', 'architecture-component-revision', 'architecture-system-revision', 'architecture-notifications-to-draft'].map((id) => `process/architecture/${id}.md`),
].sort();
const SHARED_PROMPT_FILES = [
  ...['analyst', 'executor', 'planner', 'reviewer'].map((id) => `agents/_shared/${id}.md`),
  ...['common', 'planner', 'executor', 'reviewer', 'analyst'].map((id) => `fragments/_shared/project-guidance-${id}.md`),
  ...['execute', 'handle-notifications', 'review-to-notifications', 'stopped-recovery', 'correct-plan-result', 'correct-review-result', 'correct-execution-result'].map((id) => `process/_shared/${id}.md`),
];

function writeFixtureUnion(root) {
  write(root, 'agents', '_shared', 'analyst', 'analyst {{vocabularySnippet}}');
  write(root, 'agents', '_shared', 'executor', 'executor {{contractDescription}}');
  write(root, 'agents', '_shared', 'specialist', 'specialist {{> specialist-piece}} {{contractDescription}}');
  write(root, 'fragments', '_shared', 'specialist-piece', 'SECOND TEMPLATE FRAGMENT');
  write(root, 'process', '_shared', 'execute', 'execute {{cardType}}');
  write(root, 'process', '_shared', 'second-execute', 'second execute {{cardType}}');
  write(root, 'process', '_shared', 'correct-execution-result', 'correct {{cardType}}');
  write(root, 'process', '_shared', 'stopped-recovery', 'recover {{cardType}}');
}

function runCopySystemTemplatePromptsTest() {
  const roots = [];
  const temporary = (prefix) => { const root = mkdtempSync(join(tmpdir(), prefix)); roots.push(root); return root; };
  try {
    const unionRoot = temporary('saivage-template-union-');
    writeFixtureUnion(unionRoot);
    const minimal = minimalSystemTemplate(unionRoot);
    const second = secondSystemTemplate(unionRoot);
    const minimalClosure = collectTemplatePromptClosure({ template: minimal });
    const secondClosure = collectTemplatePromptClosure({ template: second });
    const expectedMinimal = [
      'agents/_shared/analyst.md', 'agents/_shared/executor.md',
      'process/_shared/correct-execution-result.md', 'process/_shared/execute.md', 'process/_shared/stopped-recovery.md',
    ].sort();
    const expectedSecond = [
      'agents/_shared/analyst.md', 'agents/_shared/specialist.md', 'fragments/_shared/specialist-piece.md',
      'process/_shared/correct-execution-result.md', 'process/_shared/second-execute.md', 'process/_shared/stopped-recovery.md',
    ].sort();
    assert(Object.isFrozen(minimalClosure), 'collected closure is not frozen');
    assert(minimalClosure.join('\n') === expectedMinimal.join('\n'), 'minimal template closure omitted a selected prompt');
    assert(secondClosure.join('\n') === expectedSecond.join('\n'), 'second template closure omitted a template-only prompt or direct fragment');
    assert(collectTemplatePromptClosure({ template: minimal }).join('\n') === minimalClosure.join('\n'), 'closure collection is not deterministic');

    const outside = temporary('saivage-template-outside-');
    const escapedRoot = temporary('saivage-template-escaped-');
    writeFixtureUnion(escapedRoot);
    writeFileSync(join(outside, 'analyst.md'), 'outside {{vocabularySnippet}}');
    const escaped = minimalSystemTemplate(escapedRoot);
    const escapedAnalyst = structuredClone(escaped.config.agents.analyst);
    escaped.config.agents = { ...structuredClone(escaped.config.agents), analyst: { ...escapedAnalyst, prompt: `../../../${basename(outside)}/analyst` } };
    expectThrows(
      () => collectTemplatePromptClosure({ template: escaped }),
      /Invalid|outside the supplied prompt root/u,
      'closure accepted a prompt reference that escapes the template root',
    );

    const fragmentPath = join(unionRoot, 'fragments', '_shared', 'specialist-piece.md');
    rmSync(fragmentPath);
    expectThrows(
      () => collectTemplatePromptClosure({ template: second }),
      /ENOENT|specialist-piece\.md/u,
      'closure accepted a missing selected direct fragment',
    );

    const emptyRoot = temporary('saivage-template-empty-');
    expectThrows(
      () => collectTemplatePromptClosure({ template: minimalSystemTemplate(emptyRoot) }),
      /ENOENT|analyst\.md/u,
      'closure accepted a missing selected agent artifact',
    );

    const classicRoot = resolveSystemTemplate('classic').promptRoot;
    const typedRoot = resolveSystemTemplate('classic-typed').promptRoot;
    assert(SYSTEM_TEMPLATES.map((template) => template.name).join(',') === 'classic,classic-typed', 'registered templates must be exactly classic then classic-typed');
    assert(collectTemplatePromptClosure({ template: resolveSystemTemplate('classic') }).join('\n') === CLASSIC_CLOSURE.join('\n'), 'classic closure differs from the source-declared lock');
    assert(collectTemplatePromptClosure({ template: resolveSystemTemplate('classic-typed') }).join('\n') === TYPED_CLOSURE.join('\n'), 'classic-typed closure differs from the source-declared lock');
    assert(walkFiles(classicRoot).join('\n') === CLASSIC_CLOSURE.join('\n'), 'classic source tree contains an unselected or missing artifact');
    assert(walkFiles(typedRoot).join('\n') === TYPED_CLOSURE.join('\n'), 'classic-typed source tree contains an unselected or missing artifact');
    for (const file of SHARED_PROMPT_FILES) {
      assert(readFileSync(join(classicRoot, file), 'utf8') === readFileSync(join(typedRoot, file), 'utf8'), `classic-family shared prompt drifted between templates: ${file}`);
    }

    const distRoot = temporary('saivage-template-dist-');
    copySystemTemplatePrompts({ distRoot });
    const classicOutput = join(distRoot, 'src', 'config', 'system-templates', 'classic', 'prompts');
    const typedOutput = join(distRoot, 'src', 'config', 'system-templates', 'classic-typed', 'prompts');
    assertTreesEqual(classicRoot, classicOutput);
    assertTreesEqual(typedRoot, typedOutput);
    copySystemTemplatePrompts({ distRoot });
    assertTreesEqual(classicRoot, classicOutput);
    assertTreesEqual(typedRoot, typedOutput);
    writeFileSync(join(classicOutput, 'stale.md'), 'stale');
    writeFileSync(join(typedOutput, 'process', '_shared', 'stale.md'), 'stale');
    copySystemTemplatePrompts({ distRoot });
    assert(!existsSync(join(classicOutput, 'stale.md')), 'stale output file survived copy');
    assert(!existsSync(join(typedOutput, 'process', '_shared', 'stale.md')), 'stale nested output file survived copy');
    assertTreesEqual(classicRoot, classicOutput);
    assertTreesEqual(typedRoot, typedOutput);

    const mutatedSource = temporary('saivage-template-source-');
    cpSync(classicRoot, mutatedSource, { recursive: true });
    const mutated = { ...resolveSystemTemplate('classic'), promptRoot: mutatedSource };
    writeFileSync(join(mutatedSource, 'extra.md'), 'unselected');
    expectThrows(() => copySystemTemplatePrompts({ templates: [mutated], distRoot }), /must contain exactly its compiled closure/u, 'copy accepted an extra unselected source artifact');
    rmSync(join(mutatedSource, 'extra.md'));
    rmSync(join(mutatedSource, 'process', '_shared', 'execute.md'));
    expectThrows(() => copySystemTemplatePrompts({ templates: [mutated], distRoot }), /ENOENT|execute\.md/u, 'copy accepted a missing selected source artifact');
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
}

if (typeof globalThis.test === 'function') {
  globalThis.test('collects each template closure and copies exact per-template trees idempotently', runCopySystemTemplatePromptsTest);
} else {
  runCopySystemTemplatePromptsTest();
  console.log('copy-system-template-prompts test passed');
}
