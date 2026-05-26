#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const webSrc = path.join(root, 'web', 'src');
const components = path.join(webSrc, 'components');
const errors = [];

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && /\.(vue|ts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function rel(file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, `${base}.ts`, `${base}.vue`, path.join(base, 'index.ts')];
  const target = candidates.find((candidate) => fs.existsSync(candidate));
  return target ?? base;
}

const importRe = /import(?:\s+type)?[\s\S]*?from\s+['"]([^'"]+)['"]|export[\s\S]*?from\s+['"]([^'"]+)['"]/g;
for (const file of walk(components)) {
  const text = fs.readFileSync(file, 'utf8');
  const fileRel = rel(file);
  if (fileRel.includes('/components/code/')) {
    errors.push(`${fileRel}: components/code is retired; use components/content with no shim`);
  }
  let match;
  while ((match = importRe.exec(text))) {
    const spec = match[1] || match[2];
    const target = resolveImport(file, spec);
    if (!target) continue;
    const targetRel = rel(target);
    const line = lineOf(text, match.index);
    if (fileRel.includes('/components/ui/')) {
      if (targetRel.includes('/components/') && !targetRel.includes('/components/ui/')) {
        errors.push(`${fileRel}:${line}: ui primitives may import only ui components, not ${spec}`);
      }
      if (targetRel.includes('/stores/') || targetRel.includes('/api/')) {
        errors.push(`${fileRel}:${line}: ui primitives must not import stores/api (${spec})`);
      }
    }
    if (fileRel.includes('/components/content/')) {
      if (targetRel.includes('/components/') && !targetRel.includes('/components/content/') && !targetRel.includes('/components/ui/')) {
        errors.push(`${fileRel}:${line}: content components may import only content/ui components, not ${spec}`);
      }
      if (targetRel.includes('/stores/') || targetRel.includes('/api/')) {
        errors.push(`${fileRel}:${line}: content components must not import stores/api (${spec})`);
      }
    }
  }
}

for (const file of walk(webSrc)) {
  const text = fs.readFileSync(file, 'utf8');
  if (text.includes('components/code') || text.includes('../code/') || text.includes('./code/')) {
    errors.push(`${rel(file)}: imports retired components/code path`);
  }
}

if (fs.existsSync(path.join(components, 'conversation'))) {
  errors.push('web/src/components/conversation exists before the approved F03/F04/F05 conversation cycle');
}

if (errors.length) {
  console.error('Web component boundary violations:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log('Web component boundary check passed.');
