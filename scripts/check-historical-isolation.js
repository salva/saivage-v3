#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const HISTORICAL_REF_RE = /(?:docs\/historical|\.\.?\/historical|\/historical\/|\]\([^)]*historical\/|\]\([^)]*historical-artifacts)/i;
const PREFIX_RE = /See historical:/i;

const DEFAULT_CURRENT_DOCS = [
  'README.md',
  'AGENTS.md',
  'docs/spec/index.md',
  'docs/spec/system-specification.md',
  'docs/spec/operator-ui.md',
  'docs/architecture/index.md',
  'docs/architecture/system-architecture.md',
];

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    docs: [],
    expectFailure: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      options.root = argv[++index];
    } else if (arg === '--doc') {
      options.docs.push(argv[++index]);
    } else if (arg === '--expect-failure') {
      options.expectFailure = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/check-historical-isolation.js [options]\n\nOptions:\n  --root <path>        Repository root (default: cwd)\n  --doc <path>         Current-doc path to scan; repeatable. Defaults to the canonical current docs.\n  --expect-failure     Negative-test mode: pass only if an unprefixed historical reference is found.\n`);
}

function inventoryCurrentDocs(root) {
  return DEFAULT_CURRENT_DOCS.filter((docPath) => existsSync(path.join(root, docPath)));
}

function directMarkdownDocs(root, relativePath) {
  const fullPath = path.join(root, relativePath);
  if (!existsSync(fullPath)) return [];
  const stat = readdirSafe(fullPath);
  if (stat === null) return [relativePath];
  return stat.flatMap((entry) => {
    const rel = path.join(relativePath, entry.name).replace(/\\/g, '/');
    const full = path.join(root, rel);
    if (entry.isDirectory()) return directMarkdownDocs(root, rel);
    return entry.isFile() && entry.name.endsWith('.md') ? [rel] : [];
  });
}

function readdirSafe(fullPath) {
  try {
    return readdirSync(fullPath, { withFileTypes: true });
  } catch {
    return null;
  }
}

function docsToScan(root, explicitDocs) {
  if (explicitDocs.length > 0) {
    return explicitDocs.flatMap((docPath) => directMarkdownDocs(root, docPath));
  }
  return inventoryCurrentDocs(root);
}

function lineHasAllowedPrefix(line, matchIndex) {
  const before = line.slice(0, matchIndex);
  const prefixWindow = before.slice(Math.max(0, before.length - 120));
  return PREFIX_RE.test(prefixWindow);
}

function checkHistoricalIsolation({ root, docs }) {
  const rootPath = path.resolve(root);
  const failures = [];
  const scanned = docsToScan(rootPath, docs);
  for (const docPath of scanned) {
    const fullPath = path.join(rootPath, docPath);
    if (!existsSync(fullPath)) {
      failures.push({ file: docPath, line: 0, message: `${docPath} does not exist` });
      continue;
    }
    const lines = readFileSync(fullPath, 'utf8').split('\n');
    lines.forEach((line, lineIndex) => {
      HISTORICAL_REF_RE.lastIndex = 0;
      const match = HISTORICAL_REF_RE.exec(line);
      if (!match) return;
      if (!lineHasAllowedPrefix(line, match.index)) {
        failures.push({
          file: docPath,
          line: lineIndex + 1,
          message: `${docPath}:${lineIndex + 1} references historical docs without a 'See historical:' prefix`,
        });
      }
    });
  }
  return { ok: failures.length === 0, failures, scanned };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = checkHistoricalIsolation(options);
  if (options.expectFailure) {
    if (!result.ok) {
      console.log(`✓ negative historical-isolation check observed ${result.failures.length} expected failure(s)`);
      return;
    }
    console.error('✗ negative historical-isolation check did not observe an unprefixed historical reference');
    process.exit(1);
  }
  if (!result.ok) {
    console.error('✗ historical isolation check failed');
    for (const failure of result.failures) {
      console.error(`  - ${failure.message}`);
    }
    process.exit(1);
  }
  console.log(`✓ historical isolation holds for ${result.scanned.length} current canonical Markdown doc(s)`);
}

main();
