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
const SCHEMA_FORBIDDEN = new Set(['events', 'server', 'persistence', 'cards', 'notifications', 'runtime', 'tools', 'agents', 'mcp']);
const RUNTIME_AGENT_IMPORT_EXCEPTIONS = new Set(['agents/default-agent-execution.js', 'agents/analyst-stage6.js', 'agents/session-persistence.js', 'agents/system-prompt.js', 'agents/skills-engine.js', 'agents/agent-adapter.js', 'agents/config-schema.js']);
const AGENT_RUNTIME_IMPORT_EXCEPTIONS = new Set(['src/agents/analyst-tools.ts', 'src/agents/analyst-stage6.ts', 'src/agents/analyst-handler.ts']);
const PREEXISTING_DEEP_IMPORT_EXCEPTIONS = new Set([
  'src/agents/agent-adapter.ts->notifications/notification-delivery.js',
  'src/agents/analyst-secret-classifier.ts->workspace/secret-paths.js',
  'src/tools/agent-tools.ts->agents/analyst-tool-schemas.js',
  'src/tools/agent-tools.ts->agents/analyst-tools.js',
]);
const PREEXISTING_SERVER_IMPORT_EXCEPTIONS = new Set(['src/runtime/active-runtime.ts']);

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

function isCrossPackageAllowed(fromPkg, parts) {
  return parts[0] === fromPkg || isPackageRootImport(parts);
}

function normalizedParts(parts) { return parts.join('/').replace(/\.ts$/, '.js'); }

function isAgentRuntimeAllowed(fromPkg, parts, fromRel = '') {
  if (fromPkg !== 'agents' || parts[0] !== 'runtime') return true;
  if (AGENT_RUNTIME_IMPORT_EXCEPTIONS.has(fromRel)) return true;
  return false;
}

function isPreexistingDeepImportException(fromRel, parts) { return PREEXISTING_DEEP_IMPORT_EXCEPTIONS.has(`${fromRel}->${normalizedParts(parts)}`); }

function isRuntimeAgentAllowed(fromPkg, parts, fromRel = '') {
  if (fromPkg !== 'runtime' || parts[0] !== 'agents') return true;
  return RUNTIME_AGENT_IMPORT_EXCEPTIONS.has(normalizedParts(parts));
}

function isSchemaImportAllowed(fromPkg, parts) {
  return fromPkg !== 'schemas' || !SCHEMA_FORBIDDEN.has(parts[0]);
}

function isEventSchemaCatalogAllowed(fromPkg, parts) {
  return fromPkg === 'events' && normalizedParts(parts) === 'schemas/event-catalog.js';
}

function runSelfTest() {
  const cases = [
    { fromPkg: 'agents', parts: ['cards'], ok: true, label: '@saivage/cards root' },
    { fromPkg: 'agents', parts: ['cards', 'index.js'], ok: true, label: '../cards/index.js root' },
    { fromPkg: 'agents', parts: ['cards', 'card-store.js'], ok: false, label: '../cards/card-store.js two-part deep' },
    { fromPkg: 'agents', parts: ['cards', 'card-store'], ok: false, label: '@saivage/cards/card-store two-part deep' },
    { fromPkg: 'cards', parts: ['cards', 'card-store.js'], ok: true, label: 'same-package deep' },
    { fromPkg: 'runtime', parts: ['agents', 'nested', 'module.js'], ok: false, label: 'runtime must not import agent internals' },
    { fromPkg: 'runtime', parts: ['agents', 'index.js'], ok: false, label: 'runtime must not import agents index' },
    { fromPkg: 'runtime', parts: ['agents', 'default-agent-execution.js'], ok: true, label: 'runtime may use exact default execution factory' },
    { fromPkg: 'agents', parts: ['runtime'], ok: false, label: 'agents must not use runtime package root' },
    { fromPkg: 'agents', parts: ['runtime', 'index.js'], ok: false, label: 'agents must not use runtime index' },
    { fromPkg: 'agents', parts: ['runtime', 'state.js'], ok: false, label: 'agents must not deep-import runtime state' },
    { fromPkg: 'schemas', parts: ['events', 'index.js'], ok: false, label: 'schemas must not import events' },
    { fromPkg: 'events', parts: ['schemas', 'event-catalog.js'], ok: true, label: 'events may import schema catalog owner' },
    { fromPkg: null, parts: ['agents', 'index.js'], ok: true, label: 'root entrypoint may import agents index' },
    { fromPkg: null, parts: ['agents', 'authz.js'], ok: false, label: 'root entrypoint must not deep-import agents authz' },
  ];
  const failures = [];
  for (const testCase of cases) {
    const allowed = (isCrossPackageAllowed(testCase.fromPkg, testCase.parts) || (testCase.fromPkg === 'runtime' && isRuntimeAgentAllowed(testCase.fromPkg, testCase.parts)) || isEventSchemaCatalogAllowed(testCase.fromPkg, testCase.parts)) && isAgentRuntimeAllowed(testCase.fromPkg, testCase.parts) && isRuntimeAgentAllowed(testCase.fromPkg, testCase.parts) && isSchemaImportAllowed(testCase.fromPkg, testCase.parts);
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
  const text = fs.readFileSync(file, 'utf8');
  let match;
  while ((match = importRe.exec(text))) {
    const spec = match[1] || match[2];
    const parts = resolveImport(file, spec);
    if (!parts) continue;
    const toPkg = parts[0];
    const relFile = path.relative(root, file);
    const line = text.slice(0, match.index).split('\n').length;
    if (DOMAIN_PACKAGES.has(fromPkg) && toPkg === 'server' && !PREEXISTING_SERVER_IMPORT_EXCEPTIONS.has(relFile)) {
      errors.push(`${relFile}:${line}: ${fromPkg} must not import server (${spec})`);
    }
    if (fromPkg === 'contracts' && CONTRACT_FORBIDDEN.has(toPkg)) {
      errors.push(`${relFile}:${line}: contracts must stay declarative and must not import ${toPkg} (${spec})`);
    }
    if (fromPkg === 'schemas' && SCHEMA_FORBIDDEN.has(toPkg)) {
      errors.push(`${relFile}:${line}: schemas must stay a bottom-layer contract package and must not import ${toPkg} (${spec})`);
    }
    if (fromPkg === 'agents' && AGENT_RUNTIME_RESTRICTED.has(toPkg) && !isAgentRuntimeAllowed(fromPkg, parts, relFile)) {
      errors.push(`${relFile}:${line}: agents must not import runtime (${spec}); inject runtime-owned state/ledger ports instead`);
    }
    if (fromPkg === 'runtime' && toPkg === 'agents' && !isRuntimeAgentAllowed(fromPkg, parts, relFile)) {
      errors.push(`${relFile}:${line}: runtime must not import agents package internals (${spec}); depend on contracts or exact composition factory only`);
    }
    if (!isCrossPackageAllowed(fromPkg, parts) && !(fromPkg === 'runtime' && isRuntimeAgentAllowed(fromPkg, parts, relFile)) && !isEventSchemaCatalogAllowed(fromPkg, parts) && !isPreexistingDeepImportException(relFile, parts)) {
      const consumer = fromPkg === null ? 'root entrypoint' : `cross-package import into ${toPkg}`;
      errors.push(`${relFile}:${line}: deep ${consumer} is forbidden (${spec}); import from the package index or move within the owning package`);
    }
  }
}
if (errors.length) {
  console.error('Import boundary violations:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log('Import boundary check passed.');
