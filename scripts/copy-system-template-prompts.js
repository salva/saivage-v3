#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYSTEM_TEMPLATES } from '../src/config/system-templates/registry.js';
import { effectiveSaivageConfigSchema } from '../src/schemas/saivage-config.js';
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

function assertDirectory(root, templateName) {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`System template '${templateName}' prompt directory is missing: ${relative(repoRoot, root)}`);
  }
}

function relativeTemplatePath(artifact, promptRoot) {
  if (artifact.source !== 'bundled-card' && artifact.source !== 'bundled-shared') {
    throw new Error(`Template prompt closure cannot include non-bundled artifact '${artifact.path}' (${artifact.source}).`);
  }
  const path = relative(promptRoot, artifact.path);
  if (path.length === 0 || path === '..' || path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(path)) {
    throw new Error(`Template prompt artifact is outside the supplied prompt root: ${artifact.path}`);
  }
  return path;
}

/**
 * Compile one template's behavior standalone against the supplied prompt root and
 * observe its exact prompt closure. This function performs no publication, name
 * lookup, discovery, or output mutation; the closure is derived from compilation.
 */
export function collectTemplatePromptClosure({ template, promptRoot = template.promptRoot }) {
  const canonicalPromptRoot = resolve(promptRoot);
  const selected = new Set();
  const config = effectiveSaivageConfigSchema.parse(structuredClone(template.config));
  compileProjectWorkflows(config, {
    defaultPromptRoot: canonicalPromptRoot,
    artifactObserver: (artifact) => selected.add(relativeTemplatePath(artifact, canonicalPromptRoot)),
  });
  return Object.freeze([...selected].sort());
}

/** Compare the independently compiled classic family's selected shared artifacts. */
export function assertClassicFamilyPromptParity({ templates = SYSTEM_TEMPLATES } = {}) {
  const family = ['classic', 'classic-typed'].map((name) => {
    const template = templates.find((entry) => entry.name === name);
    if (!template) throw new Error(`Classic prompt family requires system template '${name}'.`);
    return { template, closure: collectTemplatePromptClosure({ template }) };
  });
  const [classic, typed] = family;
  const sharedGuidance = (path) => path.startsWith('agents/_shared/') || path.startsWith('fragments/_shared/');
  const classicGuidance = new Set(classic.closure.filter(sharedGuidance));
  const typedGuidance = new Set(typed.closure.filter(sharedGuidance));
  for (const [selected, other] of [[classic, typed], [typed, classic]]) {
    const otherGuidance = selected === classic ? typedGuidance : classicGuidance;
    for (const path of selected.closure.filter(sharedGuidance)) {
      if (!otherGuidance.has(path)) {
        throw new Error(`Classic prompt family membership differs: '${selected.template.name}' selects '${path}' but '${other.template.name}' does not.`);
      }
    }
  }
  const typedPaths = new Set(typed.closure);
  const comparedPaths = classic.closure.filter((path) => sharedGuidance(path)
    || (path.startsWith('process/_shared/') && typedPaths.has(path)));
  for (const path of comparedPaths) {
    if (!readFileSync(join(classic.template.promptRoot, path)).equals(readFileSync(join(typed.template.promptRoot, path)))) {
      throw new Error(`Classic prompt family bytes differ between '${classic.template.name}' and '${typed.template.name}': ${path}`);
    }
  }
}

function assertEqualPaths(actual, expected, message) {
  if (actual.length !== expected.length || actual.some((path, index) => path !== expected[index])) {
    throw new Error(`${message}: ${expected.join(', ')}`);
  }
}

function assertExactTree(root, closure, templateName) {
  assertDirectory(root, templateName);
  assertEqualPaths(walkFiles(root), closure, `System template '${templateName}' prompt tree must contain exactly its compiled closure`);
}

function copyTree(sourceRoot, outputRoot, closure, templateName) {
  rmSync(outputRoot, { recursive: true, force: true });
  for (const relativePath of closure) {
    const source = join(sourceRoot, relativePath);
    const destination = join(outputRoot, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
  assertDirectory(outputRoot, templateName);
}

/**
 * Validate and package every supplied registered template. Each template is compiled
 * standalone at its own source prompts root, its physical tree must equal the observed
 * closure exactly, the closure is copied to <distRoot>/src/config/system-templates/<name>/prompts/,
 * and the output root is recompiled and re-asserted before moving on.
 */
export function copySystemTemplatePrompts({ templates = SYSTEM_TEMPLATES, distRoot = join(repoRoot, 'dist') } = {}) {
  const packaged = [];
  for (const template of templates) {
    const closure = collectTemplatePromptClosure({ template });
    assertExactTree(template.promptRoot, closure, template.name);
    const outputRoot = join(distRoot, 'src', 'config', 'system-templates', template.name, 'prompts');
    copyTree(template.promptRoot, outputRoot, closure, template.name);
    const outputClosure = collectTemplatePromptClosure({ template, promptRoot: outputRoot });
    assertEqualPaths(outputClosure, closure, `Copied '${template.name}' prompt closure must equal its source closure`);
    assertExactTree(outputRoot, closure, template.name);
    packaged.push(Object.freeze({ name: template.name, count: closure.length, outputRoot }));
  }
  return Object.freeze(packaged);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    assertClassicFamilyPromptParity({ templates: SYSTEM_TEMPLATES });
    const packaged = copySystemTemplatePrompts();
    console.log(packaged.map((entry) => `Copied ${entry.count} '${entry.name}' prompt artifacts to ${relative(repoRoot, entry.outputRoot)}`).join('\n'));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
