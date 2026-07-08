#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as YAML from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceFile = join(repoRoot, 'src', 'utils', 'prompt-defaults.yaml');
const stalePromptDir = join(repoRoot, 'dist', 'prompts');
const outputDir = join(repoRoot, 'dist', 'src', 'utils');
const outputFile = join(outputDir, 'prompt-defaults.yaml');
const roleKeys = ['planner', 'executor', 'reviewer', 'analyst'];
const topLevelKeys = [...roleKeys, 'cardTypeGuidance'];

function isIdentifierStart(char) {
  if (char === undefined) return false;
  return /[A-Za-z_]/.test(char);
}

function isIdentifierPart(char) {
  if (char === undefined) return false;
  return /[A-Za-z0-9_]/.test(char);
}

function malformedToken(template, start) {
  return template.slice(start, Math.min(template.length, start + 32));
}

function assertGuidancePlaceholders(key, template) {
  let i = 0;
  while (i < template.length) {
    const c = template[i];
    if (c === '{' && template[i + 1] === '{') {
      let j = i + 2;
      while (template[j] === ' ' || template[j] === '\t') j++;
      const idStart = j;
      if (!isIdentifierStart(template[j])) throw new Error(`Prompt defaults cardTypeGuidance.${key} has malformed placeholder: ${malformedToken(template, i)}`);
      j++;
      while (isIdentifierPart(template[j])) j++;
      const placeholder = template.slice(idStart, j);
      if (placeholder !== 'cardType') throw new Error(`Prompt defaults cardTypeGuidance.${key} uses unsupported placeholder: ${placeholder}`);
      if (template[j] !== ' ' && template[j] !== '\t' && template[j] !== '}' && template[j] !== undefined) throw new Error(`Prompt defaults cardTypeGuidance.${key} has malformed placeholder: ${malformedToken(template, i)}`);
      while (template[j] === ' ' || template[j] === '\t') j++;
      if (template[j] !== '}' || template[j + 1] !== '}') throw new Error(`Prompt defaults cardTypeGuidance.${key} has unclosed placeholder: ${malformedToken(template, i)}`);
      i = j + 2;
      continue;
    }
    if (c === '}' && template[i + 1] === '}') throw new Error(`Prompt defaults cardTypeGuidance.${key} has stray '}}'.`);
    i++;
  }
}

function assertDefaultsFile(path) {
  if (!existsSync(path)) {
    throw new Error(`Prompt defaults file is missing: ${relative(repoRoot, path)}`);
  }

  const parsed = YAML.parse(readFileSync(path, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Prompt defaults file must contain a YAML mapping: ${relative(repoRoot, path)}`);
  }

  const keys = Object.keys(parsed).sort();
  const expected = [...topLevelKeys].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error(`Prompt defaults file must contain exactly these top-level keys: ${topLevelKeys.join(', ')}`);
  }

  for (const role of roleKeys) {
    if (typeof parsed[role] !== 'string' || parsed[role].length === 0) {
      throw new Error(`Prompt defaults file role must be a non-empty string: ${role}`);
    }
  }

  const guidance = parsed.cardTypeGuidance;
  if (guidance === null || typeof guidance !== 'object' || Array.isArray(guidance)) {
    throw new Error('Prompt defaults file cardTypeGuidance must be a mapping');
  }
  for (const [key, value] of Object.entries(guidance)) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`Prompt defaults file cardTypeGuidance.${key} must be a non-empty string`);
    }
    assertGuidancePlaceholders(key, value);
  }
  if (typeof guidance.default !== 'string' || guidance.default.length === 0) {
    throw new Error('Prompt defaults file cardTypeGuidance.default must be a non-empty string');
  }
}

function assertStalePromptDirRemoved() {
  if (!existsSync(stalePromptDir)) return;
  const entries = readdirSync(stalePromptDir);
  if (entries.length > 0) {
    throw new Error(`Obsolete prompt asset directory still contains files: ${relative(repoRoot, stalePromptDir)}`);
  }
  throw new Error(`Obsolete prompt asset directory still exists: ${relative(repoRoot, stalePromptDir)}`);
}

function copyPromptDefaults() {
  rmSync(stalePromptDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  copyFileSync(sourceFile, outputFile);

  assertDefaultsFile(outputFile);
  assertStalePromptDirRemoved();

  console.log(`Copied prompt defaults to ${relative(repoRoot, outputFile)}`);
}

try {
  copyPromptDefaults();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
