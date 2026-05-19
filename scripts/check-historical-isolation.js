#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const INVENTORY_ROW_RE = /^\|\s*`([^`]+)`\s*\|\s*(current|stale)\s*\|/;
const HISTORICAL_REF_RE = /(?:docs\/historical|\.\.?\/historical|\/historical\/|\]\([^)]*historical\/|\]\([^)]*historical-artifacts)/i;
const PREFIX_RE = /See historical:/i;
const EXEMPT_DOCS = new Set(['docs/documentation-inventory.md']);

const DEFAULT_CURRENT_DOCS = [
  'README.md',
  'docs/index.md',
  'docs/install.md',
  'docs/configuration.md',
  'docs/operation.md',
  'docs/operator-runbook.md',
  'docs/troubleshooting.md',
  'docs/release-checklist.md',
  'docs/agents.md',
  'docs/analyst.md',
  'docs/goal-planning-runtime.md',
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
  console.log(`Usage: node scripts/check-historical-isolation.js [options]\n\nOptions:\n  --root <path>        Repository root (default: cwd)\n  --doc <path>         Current-doc path to scan; repeatable. Defaults to current/stale docs from inventory.\n  --expect-failure     Negative-test mode: pass only if an unprefixed historical reference is found.\n`);
}

function inventoryCurrentDocs(root) {
  const inventoryPath = path.join(root, 'docs/documentation-inventory.md');
  if (!existsSync(inventoryPath)) {
    return DEFAULT_CURRENT_DOCS.filter((docPath) => !EXEMPT_DOCS.has(docPath) && existsSync(path.join(root, docPath)));
  }
  const content = readFileSync(inventoryPath, 'utf8');
  const docs = [];
  for (const line of content.split('\n')) {
    const match = line.match(INVENTORY_ROW_RE);
    if (!match) continue;
    const docPath = match[1];
    if (
      docPath.endsWith('.md') &&
      !docPath.startsWith('docs/historical/') &&
      !EXEMPT_DOCS.has(docPath) &&
      existsSync(path.join(root, docPath))
    ) {
      docs.push(docPath);
    }
  }
  return Array.from(new Set(docs)).sort((a, b) => a.localeCompare(b));
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
  console.log(`✓ historical isolation holds for ${result.scanned.length} current/stale Markdown doc(s)`);
}

main();
