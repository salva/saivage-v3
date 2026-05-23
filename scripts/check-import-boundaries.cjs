#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const SRC = path.join(root, 'src');
const PACKAGES = new Set([
  'agents', 'auth', 'boot', 'cards', 'config', 'contracts', 'events', 'lifecycle',
  'mcp', 'notifications', 'observability', 'permissions', 'persistence', 'projections',
  'redaction', 'runtime', 'schemas', 'server', 'telegram', 'tools', 'utils', 'workspace'
]);
const DOMAIN_PACKAGES = new Set([
  'agents', 'cards', 'contracts', 'events', 'lifecycle', 'mcp', 'notifications',
  'observability', 'permissions', 'persistence', 'projections', 'redaction', 'runtime',
  'schemas', 'telegram', 'tools', 'utils', 'workspace'
]);
const CONTRACT_FORBIDDEN = new Set(['server', 'persistence', 'cards', 'notifications', 'runtime', 'tools', 'agents', 'mcp']);
const AGENT_RUNTIME_RESTRICTED = new Set(['runtime']);

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && full.endsWith('.ts')) out.push(full);
  }
  return out;
}

function pkgOf(file) {
  const rel = path.relative(SRC, file).split(path.sep);
  if (rel.length === 1) return null;
  return PACKAGES.has(rel[0]) ? rel[0] : null;
}

function resolveImport(fromFile, spec) {
  if (spec.startsWith('@saivage/')) {
    const parts = spec.slice('@saivage/'.length).split('/');
    return parts;
  }
  if (!spec.startsWith('.')) return null;
  const abs = path.resolve(path.dirname(fromFile), spec);
  const rel = path.relative(SRC, abs).split(path.sep);
  if (rel[0] === '..' || path.isAbsolute(rel[0])) return null;
  if (!PACKAGES.has(rel[0])) return null;
  return rel;
}

function isPackageRootImport(parts) {
  return parts.length === 1 || (parts.length === 2 && /^index(?:\.[cm]?js|\.ts)?$/.test(parts[1]));
}

function runSelfTest() {
  const cases = [
    { fromPkg: 'agents', parts: ['cards'], ok: true, label: '@saivage/cards root' },
    { fromPkg: 'agents', parts: ['cards', 'index.js'], ok: true, label: '../cards/index.js root' },
    { fromPkg: 'agents', parts: ['cards', 'card-store.js'], ok: false, label: '../cards/card-store.js two-part deep' },
    { fromPkg: 'agents', parts: ['cards', 'card-store'], ok: false, label: '@saivage/cards/card-store two-part deep' },
    { fromPkg: 'cards', parts: ['cards', 'card-store.js'], ok: true, label: 'same-package deep' },
    { fromPkg: 'runtime', parts: ['agents', 'nested', 'module.js'], ok: false, label: 'multi-part deep' },
    { fromPkg: 'agents', parts: ['runtime'], ok: true, label: 'agents may use runtime package root' },
    { fromPkg: 'agents', parts: ['runtime', 'index.js'], ok: true, label: 'agents may use runtime index' },
    { fromPkg: 'agents', parts: ['runtime', 'state.js'], ok: false, label: 'agents must not deep-import runtime state' },
  ];
  const failures = [];
  for (const testCase of cases) {
    const crossPackageAllowed = testCase.parts[0] === testCase.fromPkg || isPackageRootImport(testCase.parts);
    const agentRuntimeAllowed = testCase.fromPkg !== 'agents' || testCase.parts[0] !== 'runtime' || isPackageRootImport(testCase.parts);
    const allowed = crossPackageAllowed && agentRuntimeAllowed;
    if (allowed !== testCase.ok) {
      failures.push(`${testCase.label}: expected ${testCase.ok ? 'allowed' : 'rejected'}, got ${allowed ? 'allowed' : 'rejected'}`);
    }
  }
  if (failures.length) {
    console.error('Import boundary self-test failed:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log('Import boundary self-test passed.');
}

if (process.argv.includes('--self-test')) {
  runSelfTest();
  process.exit(0);
}

const importRe = /import(?:\s+type)?[\s\S]*?from\s+['"]([^'"]+)['"]|export[\s\S]*?from\s+['"]([^'"]+)['"]/g;
const errors = [];
for (const file of walk(SRC)) {
  const fromPkg = pkgOf(file);
  if (!fromPkg) continue;
  const text = fs.readFileSync(file, 'utf8');
  let match;
  while ((match = importRe.exec(text))) {
    const spec = match[1] || match[2];
    const parts = resolveImport(file, spec);
    if (!parts) continue;
    const toPkg = parts[0];
    const relFile = path.relative(root, file);
    const line = text.slice(0, match.index).split('\n').length;
    if (DOMAIN_PACKAGES.has(fromPkg) && toPkg === 'server') {
      errors.push(`${relFile}:${line}: ${fromPkg} must not import server (${spec})`);
    }
    if (fromPkg === 'contracts' && CONTRACT_FORBIDDEN.has(toPkg)) {
      errors.push(`${relFile}:${line}: contracts must stay declarative and must not import ${toPkg} (${spec})`);
    }
    if (fromPkg === 'agents' && AGENT_RUNTIME_RESTRICTED.has(toPkg) && !isPackageRootImport(parts)) {
      errors.push(`${relFile}:${line}: agents must not import runtime internals (${spec}); use the runtime package index or move ownership to tool/event surfaces`);
    }
    if (toPkg !== fromPkg && !isPackageRootImport(parts)) {
      errors.push(`${relFile}:${line}: deep cross-package import into ${toPkg} is forbidden (${spec}); import from the package index or move within the owning package`);
    }
  }
}
if (errors.length) {
  console.error('Import boundary violations:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log('Import boundary check passed.');
