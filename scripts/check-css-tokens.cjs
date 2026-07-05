#!/usr/bin/env node

const { execSync } = require('node:child_process');
const path = require('node:path');

const root = process.cwd();
const targets = [
  path.join(root, 'web', 'src', 'components') + '/',
  path.join(root, 'web', 'src', 'views') + '/',
];

function git(args) {
  return execSync(args, { cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function isUnderTarget(file) {
  const rel = path.relative(root, file).split(path.sep).join('/') + '/';
  return targets.some((t) => rel.startsWith(path.relative(root, t).split(path.sep).join('/') + '/'));
}

const hexRe = /#[0-9a-fA-F]{3,8}\b/;
const pxRe = /\b\d+px\b/g;

function checkLine(line) {
  const violations = [];
  if (hexRe.test(line)) violations.push('raw hex color');
  const pxMatches = [...line.matchAll(pxRe)];
  for (const m of pxMatches) {
    if (line.includes('var(') && isInsideVarFallback(line, m.index)) continue;
    if (/\bborder/.test(line) && /(1px|2px|3px)/.test(m[0])) continue;
    violations.push(`px literal "${m[0]}"`);
  }
  return violations;
}

function isInsideVarFallback(line, index) {
  let i = index;
  while (i >= 0) {
    if (line[i] === '(') {
      const before = line.slice(0, i);
      if (before.endsWith('var')) return true;
    }
    i--;
  }
  return false;
}

let changedFiles;
try {
  const output = git('git diff --name-only --diff-filter=AM HEAD');
  changedFiles = output ? output.split('\n').filter(Boolean) : [];
} catch {
  changedFiles = [];
}

const vueFiles = changedFiles.filter((f) => f.endsWith('.vue') && isUnderTarget(path.join(root, f)));

const errors = [];

for (const file of vueFiles) {
  const fullPath = path.join(root, file);
  let diff;
  try {
    diff = git(`git diff --unified=0 HEAD -- ${file}`);
  } catch {
    continue;
  }
  for (const line of diff.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const violations = checkLine(line);
    if (violations.length > 0) {
      errors.push(`${file}: ${violations.join(', ')}\n  ${line.trimEnd()}`);
    }
  }
}

if (errors.length > 0) {
  console.error('CSS token lint: raw hex colors and px literals must use tokens.\n');
  for (const err of errors) console.error('  ' + err);
  console.error('\nUse var(--space-*), var(--font-size-*), or other semantic tokens instead.');
  process.exit(1);
}

console.log('CSS token lint passed.');
