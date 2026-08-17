#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { DEFAULT_SAIVAGE_CONFIG } from '../../src/agents/default-workflow-config.js';
import { MINIMAL_CARD_TYPE_SET } from '../fixtures/card-type-sets/minimal.js';
import { collectPromptPackageClosure, copyPromptDefaults } from '../../scripts/copy-prompt-defaults.js';
import { BUNDLED_CARD_TYPE_SETS } from '../../src/config/card-type-sets/registry.js';

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

function writeStandardTree(root) {
  for (const agent of ['analyst', 'planner', 'reviewer', 'executor']) {
    write(root, 'agents', '_shared', agent, agent === 'analyst' ? `${agent} {{vocabularySnippet}}` : `${agent} {{contractDescription}}`);
  }
  for (const id of ['plan', 'recover', 'review', 'correct-plan-result', 'correct-review-result', 'plan-to-review', 'review-to-plan', 'execute', 'correct-execution-result', 'stopped-recovery']) {
    write(root, 'process', '_shared', id, `${id} {{cardType}}`);
  }
}

function assertTreesEqual(sourceRoot, outputRoot) {
  const sourceFiles = walkFiles(sourceRoot);
  const outputFiles = walkFiles(outputRoot);
  assert(sourceFiles.join('\n') === outputFiles.join('\n'), 'copied prompt file set does not match source tree');
  for (const file of sourceFiles) {
    assert(readFileSync(join(sourceRoot, file), 'utf8') === readFileSync(join(outputRoot, file), 'utf8'), `copied prompt content does not match for ${file}`);
  }
}

function fixtureInputs() {
  const { card_types: _cardTypes, ...globals } = structuredClone(DEFAULT_SAIVAGE_CONFIG);
  globals.agents.specialist = { ...structuredClone(globals.agents.executor), prompt: 'specialist' };
  const secondCardTypes = structuredClone(MINIMAL_CARD_TYPE_SET.cardTypes);
  secondCardTypes.project.workflow.nodes.execute.agent = 'specialist';
  secondCardTypes.project.workflow.nodes.execute.prompt = 'second-execute';
  return {
    globals,
    setDefinitions: [
      MINIMAL_CARD_TYPE_SET,
      Object.freeze({ name: 'second', cardTypes: secondCardTypes }),
    ],
  };
}

function writeFixtureUnion(root) {
  write(root, 'agents', '_shared', 'analyst', 'analyst {{vocabularySnippet}}');
  write(root, 'agents', '_shared', 'executor', 'executor {{contractDescription}}');
  write(root, 'agents', '_shared', 'specialist', 'specialist {{> specialist-piece}} {{contractDescription}}');
  write(root, 'fragments', '_shared', 'specialist-piece', 'SECOND SET FRAGMENT');
  write(root, 'process', '_shared', 'execute', 'execute {{cardType}}');
  write(root, 'process', '_shared', 'second-execute', 'second execute {{cardType}}');
  write(root, 'process', '_shared', 'correct-execution-result', 'correct {{cardType}}');
  write(root, 'process', '_shared', 'stopped-recovery', 'recover {{cardType}}');
}

function runCopyPromptDefaultsTest() {
  const roots = [];
  const temporary = (prefix) => { const root = mkdtempSync(join(tmpdir(), prefix)); roots.push(root); return root; };
  try {
    const unionRoot = temporary('saivage-prompt-union-');
    writeFixtureUnion(unionRoot);
    const inputs = fixtureInputs();
    const closure = collectPromptPackageClosure({ ...inputs, promptRoot: unionRoot });
    const expectedUnion = [
      'agents/_shared/analyst.md', 'agents/_shared/executor.md', 'agents/_shared/specialist.md',
      'fragments/_shared/specialist-piece.md', 'process/_shared/correct-execution-result.md',
      'process/_shared/execute.md', 'process/_shared/second-execute.md', 'process/_shared/stopped-recovery.md',
    ].sort();
    assert(Object.isFrozen(closure), 'collected closure is not frozen');
    assert(closure.join('\n') === expectedUnion.join('\n'), 'two-set closure omitted a second-set-only prompt or direct fragment');
    assert(collectPromptPackageClosure({ ...inputs, promptRoot: unionRoot }).join('\n') === closure.join('\n'), 'closure collection is not deterministic');

    const outside = temporary('saivage-prompt-outside-');
    const escapedRoot = temporary('saivage-prompt-escaped-');
    writeFixtureUnion(escapedRoot);
    writeFileSync(join(outside, 'analyst.md'), 'outside {{vocabularySnippet}}');
    const escapedInputs = fixtureInputs();
    escapedInputs.globals.agents.analyst.prompt = `../../../${basename(outside)}/analyst`;
    expectThrows(
      () => collectPromptPackageClosure({ ...escapedInputs, promptRoot: escapedRoot }),
      /outside the supplied prompt root/u,
      'closure accepted a selected artifact outside the bundled root',
    );

    const productionRoot=resolve('src/prompts');
    const {card_types:_cardTypes,...productionGlobals}=structuredClone(DEFAULT_SAIVAGE_CONFIG);
    const specializedFiles=[
      ...['specialized-plan','specialized-review','specialized-recover','specialized-plan-to-review','specialized-review-to-plan'].map((id)=>`process/_shared/${id}.md`),
      ...['code-red','code-green','code-refactor','code-red-to-green','code-to-refactor','code-green-retry','code-regression-to-green'].map((id)=>`process/code/${id}.md`),
      ...['test-diagnose','test-add-coverage','test-repair','test-verify','test-to-add-coverage','test-to-repair','test-to-verify','test-repair-retry'].map((id)=>`process/test/${id}.md`),
      ...['research-explore','research-assess','research-report','research-to-assess','research-continue-exploration','research-supported-to-report','research-refuted-to-report','research-inconclusive-to-report'].map((id)=>`process/research/${id}.md`),
      ...['data-schema','data-validate','data-implement','data-to-validate','data-to-implement','data-revise-schema','data-implementation-retry'].map((id)=>`process/data/${id}.md`),
      ...['architecture-draft','architecture-component-review','architecture-system-review','architecture-to-component-review','architecture-to-system-review','architecture-component-revision','architecture-system-revision'].map((id)=>`process/architecture/${id}.md`),
    ];
    const historicalStandard=[...['analyst','executor','planner','reviewer'].map((id)=>`agents/_shared/${id}.md`),...['correct-execution-result','correct-plan-result','correct-review-result','execute','plan','plan-to-review','recover','review','review-to-plan','stopped-recovery'].map((id)=>`process/_shared/${id}.md`)].sort();
    const productionClosure=collectPromptPackageClosure({setDefinitions:BUNDLED_CARD_TYPE_SETS,globals:productionGlobals,promptRoot:productionRoot});
    assert(productionClosure.join('\n')===[...historicalStandard,...specializedFiles].sort().join('\n'),'production closure differs from the exact standard-plus-specialized inventory');
    assert(walkFiles(productionRoot).join('\n')===productionClosure.join('\n'),'production source tree contains an unselected or missing artifact');
    assert(!existsSync(join(productionRoot,'fragments')),'production prompt package unexpectedly contains fragments');

    const sourceRoot = temporary('saivage-copy-source-');
    const outputRoot = temporary('saivage-copy-output-');
    cpSync(productionRoot,sourceRoot,{recursive:true});
    writeFileSync(join(outputRoot, 'stale.md'), 'stale');
    copyPromptDefaults({ sourceRoot, outputRoot });
    assert(!existsSync(join(outputRoot, 'stale.md')), 'stale output file survived copy');
    assertTreesEqual(sourceRoot, outputRoot);
    copyPromptDefaults({ sourceRoot, outputRoot });
    assertTreesEqual(sourceRoot, outputRoot);

    writeFileSync(join(sourceRoot, 'extra.md'), 'unselected');
    expectThrows(() => copyPromptDefaults({ sourceRoot, outputRoot }), /registered-set union/u, 'copy accepted an extra unselected source artifact');
    rmSync(join(sourceRoot, 'extra.md'));
    const fragmentPath = join(unionRoot, 'fragments', '_shared', 'specialist-piece.md');
    rmSync(fragmentPath);
    expectThrows(
      () => collectPromptPackageClosure({ ...inputs, promptRoot: unionRoot }),
      /ENOENT|specialist-piece\.md/u,
      'closure accepted a missing selected direct fragment',
    );
    rmSync(join(sourceRoot, 'process', '_shared', 'execute.md'));
    expectThrows(() => copyPromptDefaults({ sourceRoot, outputRoot }), /ENOENT|execute\.md/u, 'copy accepted a missing selected source artifact');

    const emptyBundledRoot = temporary('saivage-copy-empty-');
    const overrideRoot = temporary('saivage-copy-override-');
    writeStandardTree(overrideRoot);
    expectThrows(
      () => copyPromptDefaults({ sourceRoot: emptyBundledRoot, outputRoot, overridePromptRoot: overrideRoot }),
      /ENOENT|analyst\.md/u,
      'production copy accepted non-bundled prompt injection',
    );
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
}

if (typeof globalThis.test === 'function') {
  globalThis.test('collects the registered union and copies its exact tree idempotently', runCopyPromptDefaultsTest);
} else {
  runCopyPromptDefaultsTest();
  console.log('copy-prompt-defaults test passed');
}
