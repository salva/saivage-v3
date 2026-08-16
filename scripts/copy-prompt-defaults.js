#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SAIVAGE_CONFIG } from '../src/agents/default-workflow-config.js';
import { BUNDLED_CARD_TYPE_SETS, STANDARD_CARD_TYPE_SET } from '../src/config/config-api.js';
import { compileProjectWorkflows } from '../src/runtime/card-process/card-process-config.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HISTORICAL_STANDARD_PROCESS_REFERENCES = Object.freeze([
  'correct-execution-result', 'correct-plan-result', 'correct-review-result', 'execute', 'plan',
  'plan-to-review', 'recover', 'review', 'review-to-plan', 'stopped-recovery',
]);
const HISTORICAL_STANDARD_PROMPT_CLOSURE = Object.freeze([
  'agents/_shared/analyst.md',
  'agents/_shared/executor.md',
  'agents/_shared/planner.md',
  'agents/_shared/reviewer.md',
  ...HISTORICAL_STANDARD_PROCESS_REFERENCES.map((id) => `process/_shared/${id}.md`),
].sort());

function walkFiles(root, current = root) {
  const files = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(root, path));
    else if (entry.isFile()) files.push(relative(root, path));
  }
  return files.sort();
}

function assertDirectory(root) {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`Bundled prompt directory is missing: ${relative(repoRoot, root)}`);
  }
}

function relativeBundledPath(artifact, promptRoot) {
  if (artifact.source !== 'bundled-card' && artifact.source !== 'bundled-shared') {
    throw new Error(`Prompt package closure cannot include non-bundled artifact '${artifact.path}' (${artifact.source}).`);
  }
  const path = relative(promptRoot, artifact.path);
  if (path.length === 0 || path === '..' || path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(path)) {
    throw new Error(`Bundled prompt artifact is outside the supplied prompt root: ${artifact.path}`);
  }
  return path;
}

/**
 * Read and compile the supplied complete set definitions against one shared globals object.
 * This function performs no publication, registry lookup, discovery, or output mutation.
 */
export function collectPromptPackageClosure({ setDefinitions, globals, promptRoot }) {
  const canonicalPromptRoot = resolve(promptRoot);
  const selected = new Set();
  for (const definition of setDefinitions) {
    compileProjectWorkflows(
      { ...structuredClone(globals), card_types: structuredClone(definition.cardTypes) },
      {
        defaultPromptRoot: promptRoot,
        artifactObserver: (artifact) => selected.add(relativeBundledPath(artifact, canonicalPromptRoot)),
      },
    );
  }
  return Object.freeze([...selected].sort());
}

function standardProcessReferences() {
  const references = new Set();
  for (const cardType of Object.values(STANDARD_CARD_TYPE_SET.cardTypes)) {
    for (const entry of Object.values(cardType.workflow.entries)) if (entry.prompt !== undefined) references.add(entry.prompt);
    for (const node of Object.values(cardType.workflow.nodes)) {
      references.add(node.prompt);
      references.add(node.correction_prompt);
      for (const edge of Object.values(node.edges)) if (edge.prompt !== undefined) references.add(edge.prompt);
    }
  }
  return [...references].sort();
}

function assertEqualPaths(actual, expected, message) {
  if (actual.length !== expected.length || actual.some((path, index) => path !== expected[index])) {
    throw new Error(`${message}: ${expected.join(', ')}`);
  }
}

function assertExactTree(root, closure) {
  assertDirectory(root);
  assertEqualPaths(walkFiles(root), closure, 'Bundled prompt tree must contain exactly the registered-set union');
}

function copyTree(sourceRoot, outputRoot, closure) {
  rmSync(outputRoot, { recursive: true, force: true });
  for (const relativePath of closure) {
    const source = join(sourceRoot, relativePath);
    const destination = join(outputRoot, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
}

export function copyPromptDefaults({ sourceRoot = join(repoRoot, 'src', 'prompts'), outputRoot = join(repoRoot, 'dist', 'prompts') } = {}) {
  const { card_types: _cardTypes, ...defaultGlobals } = DEFAULT_SAIVAGE_CONFIG;
  const standardClosure = collectPromptPackageClosure({
    setDefinitions: [STANDARD_CARD_TYPE_SET],
    globals: defaultGlobals,
    promptRoot: sourceRoot,
  });
  assertEqualPaths(standardProcessReferences(), HISTORICAL_STANDARD_PROCESS_REFERENCES, 'Standard workflow process-prompt references must remain exactly');
  assertEqualPaths(standardClosure, HISTORICAL_STANDARD_PROMPT_CLOSURE, 'Standard prompt closure must remain the historical 14 files');

  const registeredClosure = collectPromptPackageClosure({
    setDefinitions: BUNDLED_CARD_TYPE_SETS,
    globals: defaultGlobals,
    promptRoot: sourceRoot,
  });
  assertExactTree(sourceRoot, registeredClosure);
  copyTree(sourceRoot, outputRoot, registeredClosure);
  const outputClosure = collectPromptPackageClosure({
    setDefinitions: BUNDLED_CARD_TYPE_SETS,
    globals: defaultGlobals,
    promptRoot: outputRoot,
  });
  assertEqualPaths(outputClosure, registeredClosure, 'Copied prompt closure must equal the registered-set union');
  assertExactTree(outputRoot, registeredClosure);
  return registeredClosure;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const copied = copyPromptDefaults();
    console.log(`Copied ${copied.length} bundled prompt artifacts to ${relative(repoRoot, join(repoRoot, 'dist', 'prompts'))}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
