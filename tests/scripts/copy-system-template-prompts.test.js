#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { SYSTEM_TEMPLATES, resolveSystemTemplate } from '../../src/config/system-templates/registry.js';
import { minimalSystemTemplate, secondSystemTemplate } from '../fixtures/system-templates/minimal.js';
import { SYNTHETIC_GIT_PROVISIONING } from '../../scripts/system-template-fixtures.js';
import { assertPaadTypedConfigurationEquality, assertNewloopConfigurationEquality, collectTemplatePromptClosure, copySystemTemplatePrompts } from '../../scripts/copy-system-template-prompts.js';

function assert(condition, message) { if (!condition) throw new Error(message); }
function expectThrows(run, pattern) {
  try { run(); } catch (error) {
    if (pattern.test(error instanceof Error ? error.message : String(error))) return;
    throw error;
  }
  throw new Error(`Expected failure matching ${pattern}`);
}
function walkFiles(root, current = root) {
  return readdirSync(current, { withFileTypes: true }).flatMap(entry => {
    const path = join(current, entry.name);
    return entry.isDirectory() ? walkFiles(root, path) : [relative(root, path)];
  }).sort();
}
function write(root, path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}
function assertTreesEqual(sourceRoot, outputRoot) {
  const paths = walkFiles(sourceRoot);
  assert(paths.join('\n') === walkFiles(outputRoot).join('\n'), 'copied prompt file set differs');
  for (const path of paths) assert(readFileSync(join(sourceRoot, path)).equals(readFileSync(join(outputRoot, path))), `copied bytes differ: ${path}`);
}
function runCopySystemTemplatePromptsTest() {
  const root = mkdtempSync(join(tmpdir(), 'template-packaging-'));
  const output = join(root, 'dist');
  const copyTemplate = (name, label = name) => {
    const template = resolveSystemTemplate(name);
    const promptRoot = join(root, label);
    cpSync(template.promptRoot, promptRoot, { recursive: true });
    return { ...template, config: structuredClone(template.config), promptRoot };
  };
  try {
    assert(SYSTEM_TEMPLATES.map(template => template.name).join(',') === 'classic,classic-typed,paad-typed,classic-git,newloop,newloop2', 'registry order changed');
    const packaged = copySystemTemplatePrompts({ distRoot: output });
    for (const entry of packaged) {
      const template = resolveSystemTemplate(entry.name);
      assert(Object.isFrozen(collectTemplatePromptClosure({ template, provisioning: entry.name === 'classic-git' ? SYNTHETIC_GIT_PROVISIONING : undefined })), 'closure must be frozen');
      assertTreesEqual(template.promptRoot, entry.outputRoot);
    }
    const classicOutput = packaged.find(entry => entry.name === 'classic').outputRoot;
    write(classicOutput, 'stale.md', 'stale');
    copySystemTemplatePrompts({ distRoot: output });
    assert(!existsSync(join(classicOutput, 'stale.md')), 'stale output survived');
    assertTreesEqual(resolveSystemTemplate('classic').promptRoot, classicOutput);

    const union = join(root, 'union');
    for (const [path, text] of Object.entries({
      'agents/_shared/analyst.md': 'analyst {{vocabularySnippet}}',
      'agents/_shared/executor.md': 'executor {{contractDescription}}',
      'agents/_shared/oversight.md': 'oversight {{vocabularySnippet}}',
      'agents/_shared/specialist.md': 'specialist {{> specialist-piece}} {{contractDescription}}',
      'fragments/_shared/specialist-piece.md': 'SECOND TEMPLATE FRAGMENT',
      'process/_shared/execute.md': 'execute {{cardType}}',
      'process/_shared/second-execute.md': 'second execute {{cardType}}',
      'process/_shared/correct-execution-result.md': 'correct {{cardType}}',
      'process/_shared/stopped-recovery.md': 'recover {{cardType}}',
    })) write(union, path, text);
    const minimal = minimalSystemTemplate(union);
    const second = secondSystemTemplate(union);
    const minimalClosure = collectTemplatePromptClosure({ template: minimal });
    const secondClosure = collectTemplatePromptClosure({ template: second });
    assert(!minimalClosure.includes('agents/_shared/specialist.md'), 'minimal selected another template agent');
    assert(secondClosure.includes('fragments/_shared/specialist-piece.md'), 'direct fragment missing');
    assert(secondClosure.includes('process/_shared/second-execute.md'), 'second process missing');
    assert(minimalClosure.join('\n') === collectTemplatePromptClosure({ template: minimal }).join('\n'), 'closure is not deterministic');
    const custom = [minimal, second].map(template => {
      const promptRoot = join(root, template.name);
      for (const path of collectTemplatePromptClosure({ template })) write(promptRoot, path, readFileSync(join(union, path)));
      return { ...template, promptRoot };
    });
    for (const entry of copySystemTemplatePrompts({ templates: custom, distRoot: output })) {
      assertTreesEqual(custom.find(template => template.name === entry.name).promptRoot, entry.outputRoot);
    }
    const outside = join(root, 'outside');
    write(outside, 'analyst.md', 'outside {{vocabularySnippet}}');
    const escaped = minimalSystemTemplate(union);
    escaped.config.agents = structuredClone(escaped.config.agents);
    escaped.config.agents.analyst.prompt.reference = `../../../${basename(outside)}/analyst`;
    expectThrows(() => collectTemplatePromptClosure({ template: escaped }), /Invalid|outside the supplied prompt root/u);
    rmSync(join(union, 'fragments/_shared/specialist-piece.md'));
    expectThrows(() => collectTemplatePromptClosure({ template: second }), /ENOENT|specialist-piece\.md/u);

    const broken = copyTemplate('classic', 'broken');
    write(broken.promptRoot, 'extra.md', 'unselected');
    expectThrows(() => copySystemTemplatePrompts({ templates: [broken], distRoot: output }), /must contain exactly its compiled closure/u);
    rmSync(join(broken.promptRoot, 'extra.md'));
    const selected = join(broken.promptRoot, 'process/_shared/execute.md');
    const bytes = readFileSync(selected);
    rmSync(selected);
    expectThrows(() => copySystemTemplatePrompts({ templates: [broken], distRoot: output }), /ENOENT|execute\.md/u);
    writeFileSync(selected, '{{> missing-selected-include}}');
    expectThrows(() => collectTemplatePromptClosure({ template: broken }), /ENOENT|missing-selected-include/u);
    writeFileSync(selected, '{{#if broken}}');
    expectThrows(() => collectTemplatePromptClosure({ template: broken }), /template|Template|token|Token/u);
    writeFileSync(selected, bytes);
    broken.config.agents.executor.capabilities.grants = [];
    expectThrows(() => collectTemplatePromptClosure({ template: broken }), /capabilit|tool|grant|Too small/u);

    for (const [name, check] of [['paad-typed', assertPaadTypedConfigurationEquality], ['newloop', assertNewloopConfigurationEquality]]) {
      check();
      expectThrows(() => check({ templates: [] }), /requires system template/u);
      const changed = copyTemplate(name, `${name}-config-drift`);
      changed.config.agents.executor.capabilities.grants.reverse();
      expectThrows(() => check({ templates: [resolveSystemTemplate('classic-typed'), changed] }), /configuration differs/u);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runIndependentPromptEditsTest() {
  const root = mkdtempSync(join(tmpdir(), 'template-independent-'));
  try {
    // Both paths were formerly subject to cross-profile byte equality.
    for (const path of ['process/project/specialized-plan.md', 'agents/_shared/oversight.md']) {
      const templates = ['classic', 'classic-typed', 'paad-typed', 'newloop'].map(name => {
        const template = resolveSystemTemplate(name);
        const promptRoot = join(root, path.replaceAll('/', '-'), name);
        cpSync(template.promptRoot, promptRoot, { recursive: true });
        return { ...template, promptRoot };
      });
      const typed = templates.find(template => template.name === 'classic-typed');
      const target = join(typed.promptRoot, path);
      writeFileSync(target, `${readFileSync(target, 'utf8')}\n<!-- independent fixture annotation -->\n`);
      assertPaadTypedConfigurationEquality({ templates });
      assertNewloopConfigurationEquality({ templates });
      const output = copySystemTemplatePrompts({ templates, distRoot: join(root, 'dist') });
      for (const entry of output) {
        const template = templates.find(template => template.name === entry.name);
        assertTreesEqual(template.promptRoot, entry.outputRoot);
        const original = resolveSystemTemplate(entry.name).promptRoot;
        const changed = walkFiles(original).filter(file => !readFileSync(join(original, file)).equals(readFileSync(join(entry.outputRoot, file))));
        assert(changed.join('\n') === (entry.name === 'classic-typed' ? path : ''), `${entry.name} unexpectedly changed`);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (typeof globalThis.test === 'function') {
  globalThis.test('packages independently compiled exact closures and rejects invalid bindings and artifacts', runCopySystemTemplatePromptsTest);
  globalThis.test('allows one-sided typed host and shared-role changes with exact source/output fidelity', runIndependentPromptEditsTest);
} else {
  runCopySystemTemplatePromptsTest();
  runIndependentPromptEditsTest();
  console.log('copy-system-template-prompts test passed');
}
