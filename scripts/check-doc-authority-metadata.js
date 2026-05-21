#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NON_CURRENT_STATUSES = new Set(['stale', 'misleading', 'obsolete', 'historical', 'missing-coverage']);
const REQUIRED_METADATA_KEYS = ['status', 'disposition', 'owner', 'superseded_by', 'last_verified_against'];

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    inventory: 'docs/documentation-inventory.md',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      options.root = argv[++index];
    } else if (arg === '--inventory') {
      options.inventory = argv[++index];
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
  console.log(`Usage: node scripts/check-doc-authority-metadata.js [options]\n\nStrictly verifies that docs/documentation-inventory.md remains the authoritative ledger for page-local doc-authority metadata, non-current Authority status banners, and README/docs index authority-status surfaces.\n\nOptions:\n  --root <path>          Repository root (default: cwd)\n  --inventory <path>     Inventory file relative to root, or absolute path\n`);
}

function stripCellFormatting(value) {
  return value.trim().replace(/^`(.+)`$/, '$1').trim();
}

export function inventoryRowsFromContent(content) {
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

export function parseAuthorityMetadata(content) {
  const match = content.match(/<!--\s*doc-authority\s*\n([\s\S]*?)\n\s*-->/m);
  if (!match) {
    return null;
  }

  const fields = {};
  for (const rawLine of match[1].split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const fieldMatch = line.match(/^([a-z_]+):\s*(.*)$/);
    if (fieldMatch) {
      fields[fieldMatch[1]] = fieldMatch[2].trim();
    }
  }

  return { block: match[0], fields, index: match.index };
}

function markdownLinks(content) {
  const links = [];
  const regex = /\[[^\]]+\]\(([^)]+)\)/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const before = content.slice(0, match.index);
    const lineNumber = before.split('\n').length;
    const lineStart = before.lastIndexOf('\n') + 1;
    const lineEnd = content.indexOf('\n', match.index);
    const line = content.slice(lineStart, lineEnd === -1 ? content.length : lineEnd);
    links.push({ target: match[1].trim(), line, lineNumber });
  }
  return links;
}

function normalizeLinkTarget(sourceFile, target) {
  const withoutHash = target.split('#')[0];
  if (!withoutHash || /^(https?:|mailto:|#)/.test(withoutHash)) {
    return null;
  }

  let normalized = withoutHash;
  if (normalized.startsWith('/')) {
    normalized = `docs${normalized}`;
  } else {
    normalized = path.posix.normalize(path.posix.join(path.posix.dirname(sourceFile), normalized));
  }

  normalized = normalized.replace(/^\.\//, '');
  if (!normalized.endsWith('.md')) {
    normalized = `${normalized}.md`;
  }
  return normalized;
}

function expectedStatusPhrase(status) {
  if (status === 'current') {
    return 'current authority';
  }
  if (status === 'historical') {
    return 'historical provenance';
  }
  return `${status} context`;
}

function validateEntryPointSurface(file, content, rowsByPath) {
  const errors = [];
  const statusBlock = content.match(/<!--\s*doc-authority-status:start\s*-->[\s\S]*?<!--\s*doc-authority-status:end\s*-->/m);
  if (!statusBlock) {
    errors.push({ kind: 'status-surface', message: `${file}: missing doc-authority-status delimited surface for prominent documentation links` });
  }

  for (const link of markdownLinks(content)) {
    const target = normalizeLinkTarget(file, link.target);
    if (!target || !rowsByPath.has(target)) {
      continue;
    }
    const row = rowsByPath.get(target);
    const line = link.line.toLowerCase();
    if (row.classification === 'current') {
      continue;
    }
    const expected = expectedStatusPhrase(row.classification);
    const hasExpected = line.includes(expected) || line.includes(`authority status: ${row.classification}`) || line.includes(`see historical:`);
    if (!hasExpected) {
      errors.push({
        kind: 'unlabeled-link',
        message: `${file}:${link.lineNumber}: link to non-current ${target} must include status label "${expected}" or explicit Authority status/See historical wording`,
      });
    }
  }

  if (statusBlock) {
    const block = statusBlock[0].toLowerCase();
    const statusBlockLinks = markdownLinks(statusBlock[0]);
    for (const link of statusBlockLinks) {
      const target = normalizeLinkTarget(file, link.target);
      if (!target || !rowsByPath.has(target)) {
        continue;
      }
      const row = rowsByPath.get(target);
      const expected = expectedStatusPhrase(row.classification);
      if (!block.includes(expected)) {
        errors.push({ kind: 'status-surface', message: `${file}: status surface link to ${target} must include "${expected}"` });
      }
    }
  }

  return errors;
}

export function verifyDocAuthorityMetadata({ root = process.cwd(), inventory = 'docs/documentation-inventory.md' } = {}) {
  const rootPath = path.resolve(root);
  const inventoryPath = path.isAbsolute(inventory) ? inventory : path.join(rootPath, inventory);
  const inventoryContent = readFileSync(inventoryPath, 'utf8');
  const rows = inventoryRowsFromContent(inventoryContent);
  const rowsByPath = new Map(rows.map((row) => [row.path, row]));
  const errors = [];

  for (const row of rows) {
    const filePath = path.join(rootPath, row.path);
    if (!existsSync(filePath)) {
      errors.push({ kind: 'missing-file', message: `${row.path}: inventory row points to a missing file` });
      continue;
    }

    const content = readFileSync(filePath, 'utf8');
    const metadata = parseAuthorityMetadata(content);
    if (!metadata) {
      errors.push({ kind: 'missing-metadata', message: `${row.path}: missing <!-- doc-authority --> metadata block` });
      continue;
    }

    for (const key of REQUIRED_METADATA_KEYS) {
      if (!metadata.fields[key]) {
        errors.push({ kind: 'metadata-field', message: `${row.path}: doc-authority metadata missing required field "${key}"` });
      }
    }

    if (metadata.fields.status && metadata.fields.status !== row.classification) {
      errors.push({
        kind: 'status-mismatch',
        message: `${row.path}: metadata status "${metadata.fields.status}" must match inventory classification "${row.classification}"`,
      });
    }
    if (metadata.fields.disposition && metadata.fields.disposition !== row.disposition) {
      errors.push({
        kind: 'disposition-mismatch',
        message: `${row.path}: metadata disposition "${metadata.fields.disposition}" must match inventory disposition "${row.disposition}"`,
      });
    }
    if (metadata.fields.owner && metadata.fields.owner.trim().length === 0) {
      errors.push({ kind: 'metadata-field', message: `${row.path}: doc-authority metadata owner must be non-empty` });
    }

    if (NON_CURRENT_STATUSES.has(row.classification)) {
      if (!metadata.fields.superseded_by) {
        errors.push({ kind: 'metadata-field', message: `${row.path}: non-current metadata must include superseded_by; use "none" only with explicit no-replacement banner language` });
      }
      const topLines = content.split('\n').slice(0, 35).join('\n');
      const bannerMatch = topLines.match(/>\s*\*\*Authority status:\s*([^*.]+)\.\*\*/i);
      if (!bannerMatch) {
        errors.push({ kind: 'missing-banner', message: `${row.path}: non-current page must include a visible "Authority status:" banner within the first 35 lines` });
      } else {
        const bannerStatus = bannerMatch[1].trim().toLowerCase();
        if (bannerStatus !== row.classification) {
          errors.push({ kind: 'banner-mismatch', message: `${row.path}: Authority status banner "${bannerStatus}" must match inventory classification "${row.classification}"` });
        }
        const lowerBanner = topLines.toLowerCase();
        if (metadata.fields.superseded_by === 'none') {
          if (!lowerBanner.includes('no current replacement') && !lowerBanner.includes('no authoritative replacement')) {
            errors.push({ kind: 'banner-guidance', message: `${row.path}: superseded_by none requires banner language that no current/authoritative replacement exists yet` });
          }
        } else if (metadata.fields.superseded_by && !lowerBanner.includes(metadata.fields.superseded_by.toLowerCase())) {
          errors.push({ kind: 'banner-guidance', message: `${row.path}: Authority status banner must mention superseded_by target "${metadata.fields.superseded_by}"` });
        }
      }
    }

    if (row.path === 'README.md' || row.path === 'docs/index.md') {
      errors.push(...validateEntryPointSurface(row.path, content, rowsByPath));
    }
  }

  return { ok: errors.length === 0, errors, rowsChecked: rows.length };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = verifyDocAuthorityMetadata(options);
  if (!result.ok) {
    console.error('✗ documentation authority metadata check failed');
    for (const error of result.errors) {
      console.error(`  - [${error.kind}] ${error.message}`);
    }
    process.exit(1);
  }
  console.log(`✓ documentation authority metadata verified for ${result.rowsChecked} inventory-tracked Markdown file(s)`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main();
}
