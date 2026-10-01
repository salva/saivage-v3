#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { SYSTEM_TEMPLATES, resolveSystemTemplate } from '../../src/config/system-templates/registry.js';
import { minimalSystemTemplate, secondSystemTemplate } from '../fixtures/system-templates/minimal.js';
import { assertClassicFamilyPromptParity, collectTemplatePromptClosure, copySystemTemplatePrompts } from '../../scripts/copy-system-template-prompts.js';

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
  'agents/_shared/analyst.md', 'agents/_shared/executor.md', 'agents/_shared/oversight.md', 'agents/_shared/planner.md', 'agents/_shared/reviewer.md',
  ...['common', 'planner', 'executor', 'reviewer', 'analyst', 'oversight'].map((id) => `fragments/_shared/project-guidance-${id}.md`),
  'process/_shared/correct-execution-result.md', 'process/_shared/correct-plan-result.md', 'process/_shared/correct-review-result.md',
  'process/_shared/execute.md', 'process/_shared/plan-to-review.md', 'process/_shared/plan.md', 'process/_shared/recover.md',
  'process/_shared/handle-notifications.md', 'process/_shared/review-to-notifications.md',
  'process/_shared/review-to-plan.md', 'process/_shared/review.md', 'process/_shared/stopped-recovery.md',
].sort();
const TYPED_CLOSURE = [
  ...['analyst', 'executor', 'oversight', 'planner', 'reviewer'].map((id) => `agents/_shared/${id}.md`),
  ...['common', 'planner', 'executor', 'reviewer', 'analyst', 'oversight'].map((id) => `fragments/_shared/project-guidance-${id}.md`),
  ...['correct-execution-result', 'correct-plan-result', 'correct-review-result', 'execute', 'handle-notifications', 'review-to-notifications', 'specialized-plan-to-review', 'specialized-plan', 'specialized-recover', 'specialized-review-to-plan', 'specialized-review', 'stopped-recovery'].map((id) => `process/_shared/${id}.md`),
  ...['code-red', 'code-green', 'code-refactor', 'code-red-to-green', 'code-to-refactor', 'code-green-retry', 'code-regression-to-green'].map((id) => `process/code/${id}.md`),
  ...['test-diagnose', 'test-add-coverage', 'test-repair', 'test-verify', 'test-to-add-coverage', 'test-to-repair', 'test-to-verify', 'test-repair-retry'].map((id) => `process/test/${id}.md`),
  ...['research-explore', 'research-assess', 'research-report', 'research-to-assess', 'research-continue-exploration', 'research-supported-to-report', 'research-refuted-to-report', 'research-inconclusive-to-report'].map((id) => `process/research/${id}.md`),
  ...['data-schema', 'data-validate', 'data-implement', 'data-to-validate', 'data-to-implement', 'data-revise-schema', 'data-implementation-retry'].map((id) => `process/data/${id}.md`),
  ...['architecture-draft', 'architecture-component-review', 'architecture-system-review', 'architecture-to-component-review', 'architecture-to-system-review', 'architecture-component-revision', 'architecture-system-revision', 'architecture-notifications-to-draft'].map((id) => `process/architecture/${id}.md`),
].sort();

function writeFixtureUnion(root) {
  write(root, 'agents', '_shared', 'analyst', 'analyst {{vocabularySnippet}}');
  write(root, 'agents', '_shared', 'executor', 'executor {{contractDescription}}');
  write(root, 'agents', '_shared', 'oversight', 'oversight {{vocabularySnippet}}');
  write(root, 'agents', '_shared', 'specialist', 'specialist {{> specialist-piece}} {{contractDescription}}');
  write(root, 'fragments', '_shared', 'specialist-piece', 'SECOND TEMPLATE FRAGMENT');
  write(root, 'process', '_shared', 'execute', 'execute {{cardType}}');
  write(root, 'process', '_shared', 'second-execute', 'second execute {{cardType}}');
  write(root, 'process', '_shared', 'correct-execution-result', 'correct {{cardType}}');
  write(root, 'process', '_shared', 'stopped-recovery', 'recover {{cardType}}');
}

function runClassicFamilyPromptParityTest() {
  const root = mkdtempSync(join(tmpdir(), 'saivage-template-parity-'));
  const fixtureFamily = (caseName) => SYSTEM_TEMPLATES.map((template) => {
    const promptRoot = join(root, caseName, template.name);
    cpSync(template.promptRoot, promptRoot, { recursive: true });
    return { ...template, config: structuredClone(template.config), promptRoot };
  });
  const selectFragment = (template, text) => {
    const analystPath = join(template.promptRoot, 'agents', '_shared', 'analyst.md');
    writeFileSync(analystPath, `${readFileSync(analystPath, 'utf8')}\n{{> newly-selected}}\n`);
    write(template.promptRoot, 'fragments', '_shared', 'newly-selected', text);
  };
  try {
    for (const missing of ['classic', 'classic-typed']) {
      expectThrows(
        () => assertClassicFamilyPromptParity({ templates: SYSTEM_TEMPLATES.filter((template) => template.name !== missing) }),
        new RegExp(`requires system template '${missing}'`, 'u'),
        `family parity silently skipped missing ${missing}`,
      );
    }

    const oversightDrift = fixtureFamily('oversight-drift');
    const oversightPath = join(oversightDrift[1].promptRoot, 'agents', '_shared', 'oversight.md');
    writeFileSync(oversightPath, `${readFileSync(oversightPath, 'utf8')}\nfixture byte drift\n`);
    expectThrows(() => assertClassicFamilyPromptParity({ templates: oversightDrift }), /bytes differ.*classic.*classic-typed.*agents\/_shared\/oversight\.md/u, 'family parity accepted changed Oversight bytes');

    const agentAddition = fixtureFamily('agent-addition');
    const typed = agentAddition[1];
    typed.config.agents.executor.prompt.reference = 'newly-selected-agent';
    write(typed.promptRoot, 'agents', '_shared', 'newly-selected-agent', readFileSync(join(typed.promptRoot, 'agents', '_shared', 'executor.md')));
    expectThrows(() => assertClassicFamilyPromptParity({ templates: agentAddition }), /membership differs.*agents\/_shared\//u, 'family parity accepted a one-sided selected agent');

    const fragmentAddition = fixtureFamily('fragment-addition');
    selectFragment(fragmentAddition[0], 'new fragment');
    expectThrows(() => assertClassicFamilyPromptParity({ templates: fragmentAddition }), /membership differs.*classic.*fragments\/_shared\/newly-selected\.md.*classic-typed/u, 'family parity accepted a one-sided selected fragment');

    const processDrift = fixtureFamily('process-drift');
    const processPath = join(processDrift[1].promptRoot, 'process', '_shared', 'execute.md');
    writeFileSync(processPath, `${readFileSync(processPath, 'utf8')}\nfixture byte drift\n`);
    expectThrows(() => assertClassicFamilyPromptParity({ templates: processDrift }), /bytes differ.*process\/_shared\/execute\.md/u, 'family parity accepted changed common process bytes');

    const typedOnly = fixtureFamily('typed-only');
    const classicClosure = new Set(collectTemplatePromptClosure({ template: typedOnly[0] }));
    const typedOnlyPaths = collectTemplatePromptClosure({ template: typedOnly[1] }).filter((path) => path.startsWith('process/') && !classicClosure.has(path));
    assert(typedOnlyPaths.some((path) => path.startsWith('process/_shared/')), 'fixture has no typed-only shared process path');
    assert(typedOnlyPaths.some((path) => path.startsWith('process/code/')), 'fixture has no typed card-scoped process path');
    for (const path of typedOnlyPaths) {
      const sourcePath = join(typedOnly[1].promptRoot, path);
      writeFileSync(sourcePath, `${readFileSync(sourcePath, 'utf8')}\nfixture typed-only change\n`);
    }
    assertClassicFamilyPromptParity({ templates: typedOnly });

    const bothFragments = fixtureFamily('both-fragments');
    for (const template of bothFragments) selectFragment(template, 'identical newly selected bytes');
    assertClassicFamilyPromptParity({ templates: bothFragments });
    write(bothFragments[1].promptRoot, 'fragments', '_shared', 'newly-selected', 'different newly selected bytes');
    expectThrows(() => assertClassicFamilyPromptParity({ templates: bothFragments }), /bytes differ.*fragments\/_shared\/newly-selected\.md/u, 'family parity did not automatically compare a newly selected shared fragment');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
      'agents/_shared/analyst.md', 'agents/_shared/executor.md', 'agents/_shared/oversight.md',
      'process/_shared/correct-execution-result.md', 'process/_shared/execute.md', 'process/_shared/stopped-recovery.md',
    ].sort();
    const expectedSecond = [
      'agents/_shared/analyst.md', 'agents/_shared/oversight.md', 'agents/_shared/specialist.md', 'fragments/_shared/specialist-piece.md',
      'process/_shared/correct-execution-result.md', 'process/_shared/second-execute.md', 'process/_shared/stopped-recovery.md',
    ].sort();
    assert(Object.isFrozen(minimalClosure), 'collected closure is not frozen');
    assert(minimalClosure.join('\n') === expectedMinimal.join('\n'), 'minimal template closure omitted a selected prompt');
    assert(secondClosure.join('\n') === expectedSecond.join('\n'), 'second template closure omitted a template-only prompt or direct fragment');
    assert(collectTemplatePromptClosure({ template: minimal }).join('\n') === minimalClosure.join('\n'), 'closure collection is not deterministic');

    const customTemplates = [minimal, second].map((template) => {
      const promptRoot = temporary(`saivage-template-${template.name}-`);
      for (const path of collectTemplatePromptClosure({ template })) {
        const destination = join(promptRoot, path);
        mkdirSync(dirname(destination), { recursive: true });
        cpSync(join(unionRoot, path), destination);
      }
      return { ...template, promptRoot };
    });
    const customDist = temporary('saivage-template-custom-dist-');
    copySystemTemplatePrompts({ templates: customTemplates, distRoot: customDist });
    for (const template of customTemplates) {
      assertTreesEqual(template.promptRoot, join(customDist, 'src', 'config', 'system-templates', template.name, 'prompts'));
    }

    const outside = temporary('saivage-template-outside-');
    const escapedRoot = temporary('saivage-template-escaped-');
    writeFixtureUnion(escapedRoot);
    writeFileSync(join(outside, 'analyst.md'), 'outside {{vocabularySnippet}}');
    const escaped = minimalSystemTemplate(escapedRoot);
    const escapedAnalyst = structuredClone(escaped.config.agents.analyst);
    escaped.config.agents = { ...structuredClone(escaped.config.agents), analyst: { ...escapedAnalyst, prompt: { reference: `../../../${basename(outside)}/analyst` } } };
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
    assertClassicFamilyPromptParity({ templates: SYSTEM_TEMPLATES });

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
  globalThis.test('enforces compiled classic-family membership and byte parity without equating typed workflows', runClassicFamilyPromptParityTest);
  globalThis.test('collects each template closure and copies exact per-template trees idempotently', runCopySystemTemplatePromptsTest);
} else {
  runClassicFamilyPromptParityTest();
  runCopySystemTemplatePromptsTest();
  console.log('copy-system-template-prompts test passed');
}
