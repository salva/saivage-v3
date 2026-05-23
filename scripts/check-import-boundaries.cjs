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
const AGENT_FORBIDDEN = new Set(['runtime']);

const AGENT_RUNTIME_ALLOWLIST = new Set([
  'src/agents/agent-adapter.ts',
  'src/agents/analyst-handler.ts',
  'src/agents/analyst-stage6.ts',
  'src/agents/analyst-tools.ts',
  'src/agents/fake-agent.ts',
  'src/agents/planner-control-executor.ts',
]);

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
    if (fromPkg === 'agents' && AGENT_FORBIDDEN.has(toPkg) && !AGENT_RUNTIME_ALLOWLIST.has(relFile)) {
      errors.push(`${relFile}:${line}: agents must not import runtime internals (${spec}); use public tool/event surfaces or document an exception`);
    }
    if (toPkg !== fromPkg && parts.length > 2 && parts[1] !== 'index.js') {
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
