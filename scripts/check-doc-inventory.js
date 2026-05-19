#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const VALID_CLASSIFICATIONS = new Set([
  'current',
  'stale',
  'misleading',
  'obsolete',
  'historical',
  'missing-coverage',
]);

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    inventory: 'docs/documentation-inventory.md',
    expectMissing: false,
    expectInvalid: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      options.root = argv[++index];
    } else if (arg === '--inventory') {
      options.inventory = argv[++index];
    } else if (arg === '--expect-missing') {
      options.expectMissing = true;
    } else if (arg === '--expect-invalid') {
      options.expectInvalid = true;
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
  console.log(`Usage: node scripts/check-doc-inventory.js [options]\n\nOptions:\n  --root <path>          Repository root (default: cwd)\n  --inventory <path>     Inventory file relative to root, or absolute path\n  --expect-missing       Negative test mode: pass only if a missing inventory entry is detected\n  --expect-invalid       Negative test mode: pass only if an invalid inventory path is detected\n`);
}

function trackedMarkdownFiles(root) {
  const rootEntries = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name);

  function walkDocs(dir, prefix) {
    if (!existsSync(dir)) {
      return [];
    }
    const entries = readdirSync(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const rel = `${prefix}/${entry.name}`;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...walkDocs(full, rel));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(rel);
      }
    }
    return files;
  }

  return [...rootEntries, ...walkDocs(path.join(root, 'docs'), 'docs')]
    .sort((a, b) => a.localeCompare(b));
}


function stripCellFormatting(value) {
  return value.trim().replace(/^`(.+)`$/, '$1').trim();
}

function inventoryRows(inventoryPath) {
  const content = readFileSync(inventoryPath, 'utf8');
  const rows = [];

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('|')) {
      continue;
    }
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length !== 5) {
      continue;
    }
    if (cells[0] === 'Path' || /^-+$/.test(cells[0])) {
      continue;
    }
    rows.push({
      path: stripCellFormatting(cells[0]),
      classification: stripCellFormatting(cells[1]),
      justification: stripCellFormatting(cells[2]),
      anchor: stripCellFormatting(cells[3]),
      disposition: stripCellFormatting(cells[4]),
    });
  }

  return rows;
}

function checkInventory({ root, inventory }) {
  const rootPath = path.resolve(root);
  const inventoryPath = path.isAbsolute(inventory) ? inventory : path.join(rootPath, inventory);
  const expected = trackedMarkdownFiles(rootPath);
  const rows = inventoryRows(inventoryPath);
  const inventoryPaths = rows.map((row) => row.path);
  const inventorySet = new Set(inventoryPaths);
  const errors = [];

  for (const file of expected) {
    if (!inventorySet.has(file)) {
      errors.push({ kind: 'missing', message: `Missing inventory entry for tracked Markdown file: ${file}` });
    }
  }

  for (const file of inventoryPaths) {
    if (!existsSync(path.join(rootPath, file))) {
      errors.push({ kind: 'invalid-path', message: `Inventory entry points to a non-existent file: ${file}` });
    }
  }

  const seen = new Set();
  for (const file of inventoryPaths) {
    if (seen.has(file)) {
      errors.push({ kind: 'duplicate', message: `Duplicate inventory entry: ${file}` });
    }
    seen.add(file);
  }

  for (const row of rows) {
    if (!VALID_CLASSIFICATIONS.has(row.classification)) {
      errors.push({ kind: 'classification', message: `Invalid classification for ${row.path}: ${row.classification}` });
    }
    if (!row.justification || !/[.!?]$/.test(row.justification)) {
      errors.push({ kind: 'justification', message: `Justification must be a one-sentence statement ending in punctuation for ${row.path}` });
    }
    if (!/^[^\s:|]+:\d+$/.test(row.anchor)) {
      errors.push({ kind: 'anchor', message: `Primary code anchor must use file:line format for ${row.path}: ${row.anchor}` });
    }
    if (!['keep', 'merge-into', 'move-to-docs/historical/', 'rewrite'].includes(row.disposition)) {
      errors.push({ kind: 'disposition', message: `Invalid disposition for ${row.path}: ${row.disposition}` });
    }
  }

  return { expected, rows, errors };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = checkInventory(options);
  const hasMissing = result.errors.some((error) => error.kind === 'missing');
  const hasInvalid = result.errors.some((error) => error.kind === 'invalid-path');

  if (options.expectMissing || options.expectInvalid) {
    const expectedFailureSeen =
      (!options.expectMissing || hasMissing) && (!options.expectInvalid || hasInvalid);
    if (expectedFailureSeen) {
      console.log(
        `✓ negative inventory check observed expected failure(s): ${result.errors
          .map((error) => error.kind)
          .join(', ')}`,
      );
      return;
    }
    console.error('✗ negative inventory check did not observe the expected failure kind');
    for (const error of result.errors) {
      console.error(`  - [${error.kind}] ${error.message}`);
    }
    process.exit(1);
  }

  if (result.errors.length > 0) {
    console.error('✗ documentation inventory check failed');
    for (const error of result.errors) {
      console.error(`  - [${error.kind}] ${error.message}`);
    }
    process.exit(1);
  }

  console.log(
    `✓ documentation inventory covers ${result.expected.length} root/docs Markdown file(s) with ${result.rows.length} inventory row(s)`,
  );
}

main();
