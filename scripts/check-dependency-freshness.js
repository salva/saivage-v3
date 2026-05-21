#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_WAIVER_FILE = 'docs/runbook/dependency-hygiene-waivers.json';
const LOCKFILE_VERSION = 3;
const ECOSYSTEMS = [
  { name: 'root', packagePath: 'package.json', lockfilePath: 'package-lock.json' },
  { name: 'web', packagePath: 'web/package.json', lockfilePath: 'web/package-lock.json' },
];
const REQUIRED_WAIVER_FIELDS = ['package', 'ecosystem', 'advisory', 'severity', 'owner', 'created', 'expires', 'reason', 'compensating_control'];
const VALID_ECOSYSTEMS = new Set(ECOSYSTEMS.map((ecosystem) => ecosystem.name));
const VALID_SEVERITIES = new Set(['critical', 'high', 'moderate', 'low']);

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    requiredDirectRuntimeStaleness: false,
    waiverFile: DEFAULT_WAIVER_FILE,
    fixtures: {},
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      return value;
    };

    if (arg === '--root') {
      options.root = readValue();
    } else if (arg === '--root-outdated-fixture') {
      options.fixtures.root = readValue();
    } else if (arg === '--web-outdated-fixture') {
      options.fixtures.web = readValue();
    } else if (arg === '--offline-fixture-dir') {
      const fixtureDir = readValue();
      options.fixtures.root = path.join(fixtureDir, 'root-outdated.json');
      options.fixtures.web = path.join(fixtureDir, 'web-outdated.json');
    } else if (arg === '--waiver-file') {
      options.waiverFile = readValue();
    } else if (arg === '--required-direct-runtime-staleness') {
      options.requiredDirectRuntimeStaleness = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function readJson(root, relativePath) {
  return JSON.parse(readFileSync(path.resolve(root, relativePath), 'utf8'));
}

function maybeReadJson(root, relativePath) {
  const fullPath = path.resolve(root, relativePath);
  if (!existsSync(fullPath)) {
    return null;
  }
  return JSON.parse(readFileSync(fullPath, 'utf8'));
}

function normalizeOutdated(raw) {
  if (!raw || typeof raw !== 'object') {
    return {};
  }
  return raw;
}

function classifyOutdated(packageJson, outdated) {
  const runtimeDependencies = new Set(Object.keys(packageJson.dependencies ?? {}));
  const devDependencies = new Set(Object.keys(packageJson.devDependencies ?? {}));
  const directRuntime = [];
  const devOnly = [];
  const other = [];

  for (const [name, info] of Object.entries(normalizeOutdated(outdated))) {
    const entry = {
      name,
      current: info?.current ?? 'unknown',
      wanted: info?.wanted ?? 'unknown',
      latest: info?.latest ?? 'unknown',
      type: info?.type ?? (runtimeDependencies.has(name) ? 'dependencies' : devDependencies.has(name) ? 'devDependencies' : 'transitive'),
    };
    if (runtimeDependencies.has(name)) {
      directRuntime.push(entry);
    } else if (devDependencies.has(name)) {
      devOnly.push(entry);
    } else {
      other.push(entry);
    }
  }

  return { directRuntime, devOnly, other };
}

function validateWaiverDate(value, field, index, failures) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    failures.push(`waiver[${index}] field ${field} must be an ISO date string`);
    return null;
  }
  return new Date(value);
}

function validateWaivers(root, waiverFile, now = new Date()) {
  const failures = [];
  const warnings = [];
  const fullPath = path.resolve(root, waiverFile);
  if (!existsSync(fullPath)) {
    return { checked: false, waiverCount: 0, failures, warnings: [`no waiver metadata file found at ${waiverFile}; no waivers active`] };
  }

  const payload = JSON.parse(readFileSync(fullPath, 'utf8'));
  const waivers = Array.isArray(payload) ? payload : payload.waivers;
  if (!Array.isArray(waivers)) {
    failures.push(`${waiverFile} must contain an array or an object with a waivers array`);
    return { checked: true, waiverCount: 0, failures, warnings };
  }

  for (const [index, waiver] of waivers.entries()) {
    for (const field of REQUIRED_WAIVER_FIELDS) {
      if (!waiver || typeof waiver[field] !== 'string' || waiver[field].trim() === '') {
        failures.push(`waiver[${index}] missing required string field ${field}`);
      }
    }
    if (waiver?.ecosystem && !VALID_ECOSYSTEMS.has(waiver.ecosystem)) {
      failures.push(`waiver[${index}] ecosystem must be one of ${[...VALID_ECOSYSTEMS].join(', ')}`);
    }
    if (waiver?.severity && !VALID_SEVERITIES.has(waiver.severity)) {
      failures.push(`waiver[${index}] severity must be one of ${[...VALID_SEVERITIES].join(', ')}`);
    }
    validateWaiverDate(waiver?.created, 'created', index, failures);
    const expires = validateWaiverDate(waiver?.expires, 'expires', index, failures);
    if (expires && expires <= now) {
      failures.push(`waiver[${index}] for ${waiver.package ?? 'unknown package'} expired on ${waiver.expires}`);
    }
  }

  return { checked: true, waiverCount: waivers.length, failures, warnings };
}

function verifyLockfile(root, ecosystem) {
  const fullPath = path.resolve(root, ecosystem.lockfilePath);
  if (!existsSync(fullPath)) {
    return [`${ecosystem.lockfilePath} is missing`];
  }
  const lockfile = JSON.parse(readFileSync(fullPath, 'utf8'));
  if (lockfile.lockfileVersion !== LOCKFILE_VERSION) {
    return [`${ecosystem.lockfilePath} must use package-lock v${LOCKFILE_VERSION}, found ${JSON.stringify(lockfile.lockfileVersion)}`];
  }
  return [];
}

export function checkDependencyFreshness(options = {}) {
  const root = options.root ?? process.cwd();
  const requiredDirectRuntimeStaleness = options.requiredDirectRuntimeStaleness ?? false;
  const waiverFile = options.waiverFile ?? DEFAULT_WAIVER_FILE;
  const fixtures = options.fixtures ?? {};
  const failures = [];
  const warnings = [];
  const ecosystems = [];

  for (const ecosystem of ECOSYSTEMS) {
    failures.push(...verifyLockfile(root, ecosystem));
    const packageJson = readJson(root, ecosystem.packagePath);
    const fixture = fixtures[ecosystem.name];
    const outdated = fixture ? maybeReadJson(root, fixture) ?? JSON.parse(readFileSync(path.resolve(fixture), 'utf8')) : {};
    const classified = classifyOutdated(packageJson, outdated);
    ecosystems.push({ name: ecosystem.name, directRuntimeDependencies: Object.keys(packageJson.dependencies ?? {}).sort(), ...classified });

    if (classified.directRuntime.length > 0) {
      const names = classified.directRuntime.map((entry) => `${entry.name} ${entry.current}->${entry.latest}`).join(', ');
      const message = `${ecosystem.name} direct runtime dependencies are stale: ${names}`;
      if (requiredDirectRuntimeStaleness) {
        failures.push(message);
      } else {
        warnings.push(`${message} (reporting-only during ARCH-029 calibration cycle)`);
      }
    }
    if (classified.devOnly.length > 0 || classified.other.length > 0) {
      warnings.push(`${ecosystem.name} has ${classified.devOnly.length} dev-only and ${classified.other.length} transitive/other outdated package(s); advisory only`);
    }
  }

  const waiverResult = validateWaivers(root, waiverFile, options.now ?? new Date());
  failures.push(...waiverResult.failures);
  warnings.push(...waiverResult.warnings);

  return {
    ok: failures.length === 0,
    failures,
    warnings,
    waiverFile,
    waiverFileChecked: waiverResult.checked,
    waiverCount: waiverResult.waiverCount,
    ecosystems,
  };
}

function printResult(result) {
  console.log('Dependency freshness check');
  for (const ecosystem of result.ecosystems) {
    console.log(`- ${ecosystem.name}: ${ecosystem.directRuntimeDependencies.length} direct runtime dependencies; ${ecosystem.directRuntime.length} direct runtime outdated; ${ecosystem.devOnly.length} dev-only outdated; ${ecosystem.other.length} transitive/other outdated`);
  }
  console.log(`- waiver file: ${result.waiverFileChecked ? `${result.waiverFile} (${result.waiverCount} waiver(s))` : 'not present'}`);
  for (const warning of result.warnings) {
    console.warn(`warning: ${warning}`);
  }
  for (const failure of result.failures) {
    console.error(`error: ${failure}`);
  }
}

function usage() {
  console.log(`Usage: node scripts/check-dependency-freshness.js [options]\n\nOptions:\n  --root <path>                         repository root (default: cwd)\n  --root-outdated-fixture <path>        synthetic npm outdated --json for root\n  --web-outdated-fixture <path>         synthetic npm outdated --json for web\n  --offline-fixture-dir <path>          reads root-outdated.json and web-outdated.json\n  --waiver-file <path>                  waiver metadata file (default: ${DEFAULT_WAIVER_FILE})\n  --required-direct-runtime-staleness   make direct runtime staleness fail instead of reporting-only\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      usage();
      process.exit(0);
    }
    const result = checkDependencyFreshness(options);
    printResult(result);
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
