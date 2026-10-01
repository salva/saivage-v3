#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const root = process.cwd();
const SRC = path.join(root, 'src');
const PACKAGES = new Set(
  fs.readdirSync(SRC, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name),
);
const BASELINE_PATH = path.join(__dirname, 'import-boundary-baseline.json');
const CONTRACT_FORBIDDEN = new Set(['server', 'persistence', 'cards', 'notifications', 'runtime', 'tools', 'agents', 'mcp']);
const SCHEMA_FORBIDDEN = new Set(['events', 'server', 'persistence', 'cards', 'notifications', 'runtime', 'tools', 'agents', 'mcp']);
const ROOT_IMPORT_FORBIDDEN_PACKAGES = new Set(['agents', 'runtime', 'cards', 'mcp', 'server']);
const EXPLICIT_PUBLIC_ENTRYPOINT_RE = /^(?:config|session|analyst|execution|tool|state|control|process|store|lifecycle|artifact|manager|protocol|status|server|prompt)-api(?:\.js|\.ts)?$/;

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

function isExplicitPublicEntrypoint(parts) {
  if (parts.length !== 2) return false;
  if (normalizedParts(parts) === 'schemas/round-id-server.js') return true;
  if (parts[0] === 'runtime') return parts[1] === 'runtime-api.js';
  return EXPLICIT_PUBLIC_ENTRYPOINT_RE.test(parts[1]);
}

function isCrossPackageAllowed(fromPkg, parts) {
  if (parts[0] === fromPkg) return true;
  if (isExplicitPublicEntrypoint(parts)) return true;
  if (isPackageRootImport(parts)) return !ROOT_IMPORT_FORBIDDEN_PACKAGES.has(parts[0]);
  return false;
}

function normalizedParts(parts) { return parts.join('/').replace(/\.ts$/, '.js'); }

function violationDigest(violations) {
  const serializedIdentities = violations.map(({ identity }) => JSON.stringify(identity)).sort();
  return createHash('sha256').update(JSON.stringify(serializedIdentities), 'utf8').digest('hex');
}

function classifyImport(fromPkg, parts) {
  const toPkg = parts[0];
  if (fromPkg === 'contracts' && CONTRACT_FORBIDDEN.has(toPkg)) return 'contracts-declarative';
  if (fromPkg === 'schemas' && SCHEMA_FORBIDDEN.has(toPkg)) return 'schemas-bottom-layer';
  if (fromPkg === 'agents' && toPkg === 'runtime') return 'agents-runtime';
  if (fromPkg === 'runtime' && toPkg === 'agents') return 'runtime-agents';
  if (fromPkg === 'workspace' && toPkg === 'runtime') return 'workspace-runtime';
  if (fromPkg === 'server' && toPkg === 'boot') return 'server-boot';
  if (toPkg === 'server' && fromPkg !== 'server' && fromPkg !== 'boot') return 'server-import';
  if (!isCrossPackageAllowed(fromPkg, parts)) return 'cross-package-deep';
  return null;
}

function runSelfTest() {
  const cases = [
    { fromPkg: 'workspace', parts: ['runtime'], rule: 'workspace-runtime', label: 'workspace runtime root' },
    { fromPkg: 'workspace', parts: ['runtime', 'index.js'], rule: 'workspace-runtime', label: 'workspace runtime index' },
    { fromPkg: 'workspace', parts: ['runtime', 'runtime-api.js'], rule: 'workspace-runtime', label: 'workspace runtime public API' },
    { fromPkg: 'workspace', parts: ['runtime', 'command-policy.js'], rule: 'workspace-runtime', label: 'workspace runtime leaf overlap' },
    { fromPkg: 'server', parts: ['boot'], rule: 'server-boot', label: 'server boot root' },
    { fromPkg: 'server', parts: ['boot', 'index.js'], rule: 'server-boot', label: 'server boot index' },
    { fromPkg: 'server', parts: ['boot', 'app.js'], rule: 'server-boot', label: 'server boot leaf overlap' },
    { fromPkg: 'workspace', parts: ['redaction', 'index.js'], rule: null, label: 'workspace primitive redaction root' },
    { fromPkg: 'workspace', parts: ['redaction'], rule: null, label: 'workspace primitive redaction alias root' },
    { fromPkg: 'server', parts: ['contracts', 'index.js'], rule: null, label: 'server contracts root' },
    { fromPkg: 'server', parts: ['contracts'], rule: null, label: 'server contracts alias root' },
    { fromPkg: 'agents', parts: ['cards'], rule: 'cross-package-deep', label: 'cards alias root' },
    { fromPkg: 'agents', parts: ['cards', 'index.js'], rule: 'cross-package-deep', label: 'cards index' },
    { fromPkg: 'agents', parts: ['cards', 'store-api.js'], rule: null, label: 'cards explicit public API' },
    { fromPkg: 'agents', parts: ['cards', 'card-store.js'], rule: 'cross-package-deep', label: 'cards two-part deep' },
    { fromPkg: 'agents', parts: ['cards', 'card-store'], rule: 'cross-package-deep', label: 'extensionless cards deep' },
    { fromPkg: 'cards', parts: ['cards', 'card-store.js'], rule: null, label: 'same-package deep' },
    { fromPkg: 'runtime', parts: ['runtime', 'actors', 'llm-actor.js'], rule: null, label: 'runtime same-package deep' },
    { fromPkg: 'runtime', parts: ['persistence', 'conversation-file.js'], rule: 'cross-package-deep', label: 'runtime persistence leaf' },
    { fromPkg: 'runtime', parts: ['persistence', 'session-api.js'], rule: null, label: 'runtime persistence session API' },
    { fromPkg: 'runtime', parts: ['persistence', 'index.js'], rule: null, label: 'runtime persistence root' },
    { fromPkg: 'runtime', parts: ['contracts', 'tool-result.js'], rule: 'cross-package-deep', label: 'runtime contracts leaf' },
    { fromPkg: 'runtime', parts: ['contracts', 'index.js'], rule: null, label: 'runtime contracts root' },
    { fromPkg: 'runtime', parts: ['schemas', 'card-id.js'], rule: 'cross-package-deep', label: 'runtime schemas leaf' },
    { fromPkg: 'runtime', parts: ['schemas', 'index.js'], rule: null, label: 'runtime browser-safe schemas root' },
    { fromPkg: 'runtime', parts: ['sanitization', 'analyst-sanitization.js'], rule: 'cross-package-deep', label: 'runtime sanitization leaf' },
    { fromPkg: 'runtime', parts: ['sanitization', 'index.js'], rule: null, label: 'runtime sanitization root' },
    { fromPkg: 'runtime', parts: ['tools', 'invocation.js'], rule: 'cross-package-deep', label: 'runtime invocation leaf' },
    { fromPkg: 'runtime', parts: ['tools', 'tool-api.js'], rule: null, label: 'runtime tool API' },
    { fromPkg: 'runtime', parts: ['agents', 'execution-api.js'], rule: 'runtime-agents', label: 'runtime agents public API' },
    { fromPkg: 'agents', parts: ['runtime', 'runtime-api.js'], rule: 'agents-runtime', label: 'agents runtime public API' },
    { fromPkg: 'runtime', parts: ['schemas', 'round-id-server.js'], rule: null, label: 'runtime exact server-only round API' },
    { fromPkg: 'tools', parts: ['schemas', 'round-id-server.js'], rule: null, label: 'another backend exact server-only round API' },
    { fromPkg: 'runtime', parts: ['schemas', 'round-id-server.ts'], rule: null, label: 'normalized TypeScript round API' },
    { fromPkg: 'tools', parts: ['schemas', 'round-id-server.ts'], rule: null, label: 'another backend normalized round API' },
    { fromPkg: 'runtime', parts: ['schemas', 'round-id.js'], rule: 'cross-package-deep', label: 'neighboring round grammar leaf' },
    { fromPkg: 'runtime', parts: ['schemas', 'nested', 'round-id-server.js'], rule: 'cross-package-deep', label: 'nested server-named leaf' },
    { fromPkg: 'runtime', parts: ['schemas', 'other-server.js'], rule: 'cross-package-deep', label: 'arbitrary schemas server-named leaf' },
    { fromPkg: 'runtime', parts: ['tools', 'round-id-server.js'], rule: 'cross-package-deep', label: 'exact server API belongs only to schemas' },
    { fromPkg: 'runtime', parts: ['agents', 'nested', 'module.js'], rule: 'runtime-agents', label: 'runtime agent internals' },
    { fromPkg: 'runtime', parts: ['agents', 'index.js'], rule: 'runtime-agents', label: 'runtime agents index' },
    { fromPkg: 'runtime', parts: ['agents'], rule: 'runtime-agents', label: 'runtime agents alias root' },
    { fromPkg: 'server', parts: ['runtime', 'runtime-api.js'], rule: null, label: 'canonical runtime API' },
    { fromPkg: 'server', parts: ['runtime', 'control-api.js'], rule: 'cross-package-deep', label: 'deleted runtime control API' },
    { fromPkg: 'server', parts: ['runtime', 'state-api.js'], rule: 'cross-package-deep', label: 'unrelated runtime deep API' },
    { fromPkg: 'server', parts: ['runtime'], rule: 'cross-package-deep', label: 'runtime root' },
    { fromPkg: 'agents', parts: ['runtime'], rule: 'agents-runtime', label: 'agents runtime alias root' },
    { fromPkg: 'agents', parts: ['runtime', 'index.js'], rule: 'agents-runtime', label: 'agents runtime index' },
    { fromPkg: 'agents', parts: ['runtime', 'state.js'], rule: 'agents-runtime', label: 'agents runtime leaf' },
    { fromPkg: 'schemas', parts: ['events', 'index.js'], rule: 'schemas-bottom-layer', label: 'schemas events' },
    { fromPkg: 'contracts', parts: ['server', 'internal.js'], rule: 'contracts-declarative', label: 'contracts server leaf overlap' },
    { fromPkg: 'contracts', parts: ['server', 'server-api.js'], rule: 'contracts-declarative', label: 'contracts server public API' },
    { fromPkg: 'schemas', parts: ['server', 'internal.js'], rule: 'schemas-bottom-layer', label: 'schemas server leaf overlap' },
    { fromPkg: 'schemas', parts: ['server', 'server-api.js'], rule: 'schemas-bottom-layer', label: 'schemas server public API' },
    { fromPkg: 'tools', parts: ['server', 'internal.js'], rule: 'server-import', label: 'other server leaf overlap' },
    { fromPkg: null, parts: ['server', 'server-api.js'], rule: 'server-import', label: 'root server public API' },
    { fromPkg: 'boot', parts: ['server', 'server-api.js'], rule: null, label: 'boot server public API' },
    { fromPkg: 'boot', parts: ['server', 'internal.js'], rule: 'cross-package-deep', label: 'boot server leaf' },
    { fromPkg: 'boot', parts: ['server', 'index.js'], rule: 'cross-package-deep', label: 'boot server forbidden root' },
    { fromPkg: 'server', parts: ['server', 'internal.js'], rule: null, label: 'server same-package leaf' },
    { fromPkg: null, parts: ['agents', 'index.js'], rule: 'cross-package-deep', label: 'root central package index' },
    { fromPkg: null, parts: ['agents', 'authz.js'], rule: 'cross-package-deep', label: 'root agents deep' },
  ];
  const failures = [];
  for (const testCase of cases) {
    const rule = classifyImport(testCase.fromPkg, testCase.parts);
    if (rule !== testCase.rule) {
      failures.push(`${testCase.label}: expected ${JSON.stringify(testCase.rule)}, got ${JSON.stringify(rule)}`);
    }
  }
  const base = { identity: ['src/agents/consumer.ts', 'cross-package-deep', 'cards/internal.js'], diagnostic: 'src/agents/consumer.ts:1: first wording' };
  const other = { identity: ['src/runtime/consumer.ts', 'runtime-agents', 'agents/internal.js'], diagnostic: 'src/runtime/consumer.ts:2: second wording' };
  const baseDigest = violationDigest([base, other]);
  const digestCases = [
    { ok: violationDigest([other, base]) === baseDigest, label: 'digest must be traversal-order independent' },
    { ok: violationDigest([base, base, other]) !== baseDigest, label: 'digest must preserve duplicate identities' },
    { ok: violationDigest([{ ...base, identity: ['src/agents/other.ts', base.identity[1], base.identity[2]] }, other]) !== baseDigest, label: 'digest must distinguish files' },
    { ok: violationDigest([{ ...base, identity: [base.identity[0], 'agents-runtime', base.identity[2]] }, other]) !== baseDigest, label: 'digest must distinguish rules' },
    { ok: violationDigest([{ ...base, identity: [base.identity[0], base.identity[1], 'cards/other.js'] }, other]) !== baseDigest, label: 'digest must distinguish targets' },
    { ok: violationDigest([{ ...base, diagnostic: 'src/agents/consumer.ts:99: changed wording' }, other]) === baseDigest, label: 'digest must exclude diagnostics and line numbers' },
  ];
  for (const testCase of digestCases) {
    if (!testCase.ok) failures.push(testCase.label);
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
const violations = [];
for (const file of walk(SRC)) {
  const fromPkg = pkgOf(file);
  const text = fs.readFileSync(file, 'utf8');
  let match;
  while ((match = importRe.exec(text))) {
    const spec = match[1] || match[2];
    const parts = resolveImport(file, spec);
    if (!parts) continue;
    const rule = classifyImport(fromPkg, parts);
    if (rule === null) continue;
    const toPkg = parts[0];
    const relFile = path.relative(root, file);
    const identityFile = relFile.split(path.sep).join('/');
    const target = normalizedParts(parts);
    const line = text.slice(0, match.index).split('\n').length;
    let message;
    switch (rule) {
      case 'contracts-declarative':
        message = `contracts must stay declarative and must not import ${toPkg} (${spec})`;
        break;
      case 'schemas-bottom-layer':
        message = `schemas must stay a bottom-layer contract package and must not import ${toPkg} (${spec})`;
        break;
      case 'agents-runtime':
        message = `agents must not import runtime (${spec}); inject runtime-owned state/ledger ports instead`;
        break;
      case 'runtime-agents':
        message = `runtime must not import agents (${spec}); depend on contracts instead`;
        break;
      case 'workspace-runtime':
        message = `workspace must not import runtime (${spec}); depend on primitive owners instead`;
        break;
      case 'server-boot':
        message = `server must not import boot (${spec}); depend on contracts instead`;
        break;
      case 'server-import':
        message = `${fromPkg === null ? 'root entrypoint' : fromPkg} must not import server (${spec})`;
        break;
      case 'cross-package-deep':
        message = `deep ${fromPkg === null ? 'root entrypoint' : `cross-package import into ${toPkg}`} is forbidden (${spec}); import from a permitted owner public surface or move within the owning package`;
        break;
      default:
        throw new Error(`Unknown import-boundary rule: ${rule}`);
    }
    violations.push({ identity: [identityFile, rule, target], diagnostic: `${relFile}:${line}: ${message}` });
  }
}
let baseline;
try {
  baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
} catch (error) {
  console.error(`Import boundary baseline ${BASELINE_PATH} is missing or unparseable: ${error.message}`);
  process.exit(1);
}
if (baseline === null || typeof baseline !== 'object' || Array.isArray(baseline)) {
  console.error(`Import boundary baseline ${BASELINE_PATH} must be an object with totalViolations and violationDigest.`);
  process.exit(1);
}
if (typeof baseline.totalViolations !== 'number' || !Number.isInteger(baseline.totalViolations) || baseline.totalViolations < 0) {
  console.error(`Import boundary baseline ${BASELINE_PATH} must contain a non-negative integer totalViolations.`);
  process.exit(1);
}
if (typeof baseline.violationDigest !== 'string' || !/^[0-9a-f]{64}$/.test(baseline.violationDigest)) {
  console.error(`Import boundary baseline ${BASELINE_PATH} must contain a violationDigest of exactly 64 lowercase hexadecimal characters.`);
  process.exit(1);
}
const count = violations.length;
const digest = violationDigest(violations);
if (count !== baseline.totalViolations || digest !== baseline.violationDigest) {
  console.error('Import boundary violations:');
  for (const violation of violations) console.error(`- ${violation.diagnostic}`);
  console.error(`Actual: ${JSON.stringify({ totalViolations: count, violationDigest: digest })}`);
  console.error(`Expected: ${JSON.stringify({ totalViolations: baseline.totalViolations, violationDigest: baseline.violationDigest })}`);
  if (count < baseline.totalViolations) {
    console.error('Import-boundary violations decreased; verify the removal introduced no substitutions, then ratchet down both totalViolations and violationDigest in scripts/import-boundary-baseline.json in the same commit. Admitting any new identity weakens the guard and requires an explicit owner decision.');
  } else {
    console.error('Import-boundary identities changed or increased; fix the new violations instead of blindly rebaselining. Admitting any new identity weakens the guard and requires an explicit owner decision.');
  }
  process.exit(1);
}
console.log(`Import boundary check passed: ${count} violations and digest ${digest} match the baseline.`);
