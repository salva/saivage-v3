#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = join(repoRoot, 'src', 'prompts');
const outputDir = join(repoRoot, 'dist', 'prompts');
const requiredPromptFiles = ['planner.md', 'executor.md', 'reviewer.md'];

function listMarkdownFiles(directory) {
  if (!existsSync(directory)) {
    throw new Error(`Prompt asset source directory is missing: ${relative(repoRoot, directory)}`);
  }

  const entries = readdirSync(directory).sort();
  const files = entries.filter((entry) => {
    const path = join(directory, entry);
    return statSync(path).isFile() && extname(entry) === '.md';
  });

  if (files.length === 0) {
    throw new Error(`Prompt asset source directory has no markdown files: ${relative(repoRoot, directory)}`);
  }

  return files;
}

function copyPromptAssets() {
  const files = listMarkdownFiles(sourceDir);
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });

  for (const file of files) {
    copyFileSync(join(sourceDir, file), join(outputDir, basename(file)));
  }

  const missing = requiredPromptFiles.filter((file) => !existsSync(join(outputDir, file)));
  if (missing.length > 0) {
    throw new Error(`Prompt asset copy incomplete; missing required files: ${missing.join(', ')}`);
  }

  console.log(`Copied ${files.length} prompt asset(s) to ${relative(repoRoot, outputDir)}`);
}

try {
  copyPromptAssets();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
