#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { builtinModules } = require('node:module');

const root = path.resolve(__dirname, '..');
const webRoot = path.join(root, 'web');
const srcRoot = path.join(root, 'src');
const webSrcRoot = path.join(webRoot, 'src');

const forbiddenSrcPackages = new Set([
  'agents',
  'cards',
  'mcp',
  'persistence',
  'runtime',
  'server',
  'tools',
  'workspace',
]);

const builtinNames = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

const entries = [
  path.join(webSrcRoot, 'main.ts'),
  path.join(webSrcRoot, 'api', 'contracts.ts'),
];

const importRe = /import(?:\s+type)?[\s\S]*?from\s+['"]([^'"]+)['"]|export[\s\S]*?from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const visited = new Set();
const errors = [];

function rel(file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

function isWithin(file, dir) {
  const relative = path.relative(dir, file);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function sourceCandidates(base) {
  const parsed = path.parse(base);
  const candidates = [base];
  if (parsed.ext === '.js' || parsed.ext === '.mjs') candidates.push(path.join(parsed.dir, `${parsed.name}.ts`));
  if (!parsed.ext) candidates.push(`${base}.ts`, `${base}.vue`, path.join(base, 'index.ts'));
  return candidates;
}

function resolveImport(fromFile, spec) {
  if (spec.startsWith('@saivage/contracts')) {
    const suffix = spec.slice('@saivage/contracts'.length).replace(/^\//, '');
    return resolveSourcePath(path.join(srcRoot, 'contracts', suffix));
  }
  if (spec.startsWith('@saivage/schemas')) {
    const suffix = spec.slice('@saivage/schemas'.length).replace(/^\//, '');
    return resolveSourcePath(path.join(srcRoot, 'schemas', suffix));
  }
  if (spec.startsWith('@/')) return resolveSourcePath(path.join(webSrcRoot, spec.slice(2)));
  if (spec.startsWith('.')) return resolveSourcePath(path.resolve(path.dirname(fromFile), spec));
  return null;
}

function resolveSourcePath(base) {
  for (const candidate of sourceCandidates(base)) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function forbiddenPackageFor(file) {
  if (!isWithin(file, srcRoot)) return null;
  const [pkg] = path.relative(srcRoot, file).split(path.sep);
  return forbiddenSrcPackages.has(pkg) ? pkg : null;
}

function formatChain(chain, extra) {
  return [...chain.map(rel), extra].join(' -> ');
}

function visit(file, chain) {
  if (!file || visited.has(file)) return;
  visited.add(file);

  const forbiddenPackage = forbiddenPackageFor(file);
  if (forbiddenPackage) {
    errors.push(`browser import graph reached forbidden src/${forbiddenPackage} module: ${formatChain(chain, rel(file))}`);
    return;
  }

  if (!isWithin(file, webSrcRoot) && !isWithin(file, path.join(srcRoot, 'contracts')) && !isWithin(file, path.join(srcRoot, 'schemas'))) return;

  const text = fs.readFileSync(file, 'utf8');
  let match;
  importRe.lastIndex = 0;
  while ((match = importRe.exec(text))) {
    const spec = match[1] || match[2] || match[3];
    const line = lineOf(text, match.index);

    if (builtinNames.has(spec)) {
      errors.push(`${rel(file)}:${line}: imports Node builtin ${spec}; chain: ${formatChain(chain, rel(file))}`);
      continue;
    }

    const target = resolveImport(file, spec);
    if (!target) continue;
    visit(target, [...chain, file]);
  }
}

for (const entry of entries) visit(entry, []);

if (errors.length) {
  console.error('Browser import guard failed. Browser-reachable modules must stay within web/src, src/contracts, and src/schemas.');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Browser import guard passed (${visited.size} source files checked).`);
