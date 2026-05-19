#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SOURCE_ANCHOR_RE = /(?<![A-Za-z0-9_./-])((?:(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:ts|tsx|js|cjs|mjs|vue|json|md|sh|css|html|yml|yaml)|package\.json|README\.md):(\d+)\b)/g;
const SYMBOL_ANCHOR_RE = /(?<![A-Za-z0-9_./-])((?:(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:ts|tsx|js|cjs|mjs|vue|json|md|sh|css|html|yml|yaml)|package\.json|README\.md)#symbol:[A-Za-z_$][A-Za-z0-9_.$-]*)\b/g;
const IGNORED_DIRS = new Set(['.git', '.saivage', 'node_modules', 'dist', 'coverage', 'web/dist', 'docs/.vitepress/dist']);

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    docs: [],
    selfTest: false,
    expectFailure: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      options.root = argv[++index];
    } else if (arg === '--doc') {
      options.docs.push(argv[++index]);
    } else if (arg === '--self-test') {
      options.selfTest = true;
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
  console.log(`Usage: node scripts/check-source-anchors.js [options]\n\nOptions:\n  --root <path>        Repository root to scan (default: cwd)\n  --doc <path>         Markdown file or directory to scan relative to root; repeatable. Defaults to README.md and docs/.\n  --self-test          Run built-in positive and negative fixture tests\n  --expect-failure     Negative-test mode: pass only if a stale source anchor is found\n\nRecognized anchors:\n  path/to/file.ext:123\n  path/to/file.ext#symbol:exportedName\n`);
}

function isIgnoredDirectory(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/');
  return Array.from(IGNORED_DIRS).some((ignored) => normalized === ignored || normalized.startsWith(`${ignored}/`));
}

function walkMarkdown(root, relativePath) {
  const fullPath = path.join(root, relativePath);
  if (!existsSync(fullPath)) return [];
  const stat = readdirSyncSafe(fullPath);
  if (stat === null) return relativePath.endsWith('.md') ? [relativePath] : [];
  const files = [];
  for (const entry of stat) {
    const rel = path.join(relativePath, entry.name).replace(/\\/g, '/');
    const full = path.join(root, rel);
    if (entry.isDirectory()) {
      if (!isIgnoredDirectory(rel)) files.push(...walkMarkdown(root, rel));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(rel);
    }
  }
  return files;
}

function readdirSyncSafe(fullPath) {
  try {
    return readdirSync(fullPath, { withFileTypes: true });
  } catch {
    return null;
  }
}

function markdownFiles(root, docs) {
  const targets = docs.length > 0 ? docs : ['README.md', 'docs'];
  return Array.from(new Set(targets.flatMap((target) => walkMarkdown(root, target)))).sort((a, b) => a.localeCompare(b));
}

function removeFencedCodeBlocks(content) {
  return content.replace(/```[\s\S]*?```/g, '');
}

function lineStartsFor(content) {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

function lineForIndex(starts, index) {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (starts[mid] <= index) low = mid + 1;
    else high = mid - 1;
  }
  return high + 1;
}

function validateFileLineAnchor(root, docPath, lineNumber, rawAnchor, filePath, lineRaw, failures) {
  const targetPath = path.join(root, filePath);
  if (!existsSync(targetPath)) {
    failures.push({ file: docPath, line: lineNumber, anchor: rawAnchor, message: `${docPath}:${lineNumber} source anchor points to missing file: ${rawAnchor}` });
    return;
  }
  const targetLines = readFileSync(targetPath, 'utf8').split('\n');
  const targetLine = Number(lineRaw);
  if (!Number.isInteger(targetLine) || targetLine < 1 || targetLine > targetLines.length) {
    failures.push({ file: docPath, line: lineNumber, anchor: rawAnchor, message: `${docPath}:${lineNumber} source anchor points past end of file: ${rawAnchor} (${targetLines.length} line(s))` });
  }
}

function validateSymbolAnchor(root, docPath, lineNumber, rawAnchor, filePath, failures) {
  const targetPath = path.join(root, filePath);
  if (!existsSync(targetPath)) {
    failures.push({ file: docPath, line: lineNumber, anchor: rawAnchor, message: `${docPath}:${lineNumber} symbol source anchor points to missing file: ${rawAnchor}` });
  }
}

function checkSourceAnchors({ root, docs }) {
  const rootPath = path.resolve(root);
  const files = markdownFiles(rootPath, docs);
  const failures = [];
  let anchorsChecked = 0;

  for (const docPath of files) {
    const fullPath = path.join(rootPath, docPath);
    const content = removeFencedCodeBlocks(readFileSync(fullPath, 'utf8'));
    const lineStarts = lineStartsFor(content);
    const acceptedSymbolRanges = [];

    SYMBOL_ANCHOR_RE.lastIndex = 0;
    for (const match of content.matchAll(SYMBOL_ANCHOR_RE)) {
      const rawAnchor = match[1];
      const filePath = rawAnchor.split('#symbol:', 1)[0];
      acceptedSymbolRanges.push([match.index ?? 0, (match.index ?? 0) + rawAnchor.length]);
      anchorsChecked += 1;
      validateSymbolAnchor(rootPath, docPath, lineForIndex(lineStarts, match.index ?? 0), rawAnchor, filePath, failures);
    }

    SOURCE_ANCHOR_RE.lastIndex = 0;
    for (const match of content.matchAll(SOURCE_ANCHOR_RE)) {
      const start = match.index ?? 0;
      const insideSymbolAnchor = acceptedSymbolRanges.some(([rangeStart, rangeEnd]) => start >= rangeStart && start < rangeEnd);
      if (insideSymbolAnchor) continue;
      const rawAnchor = match[1];
      const [filePath, lineRaw] = rawAnchor.split(':');
      anchorsChecked += 1;
      validateFileLineAnchor(rootPath, docPath, lineForIndex(lineStarts, start), rawAnchor, filePath, lineRaw, failures);
    }
  }

  return { files, anchorsChecked, failures };
}

function runSelfTest() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'saivage-source-anchors-'));
  try {
    mkdirSync(path.join(tmp, 'docs'), { recursive: true });
    mkdirSync(path.join(tmp, 'src'), { recursive: true });
    writeFileSync(path.join(tmp, 'README.md'), '# Fixture\n\nAnchor: src/index.ts:2 and symbol src/index.ts#symbol:main\n');
    writeFileSync(path.join(tmp, 'docs', 'broken.md'), '# Broken\n\nStale: src/index.ts:99\n');
    writeFileSync(path.join(tmp, 'src', 'index.ts'), 'export const main = 1;\nexport const other = 2;\n');

    const negative = checkSourceAnchors({ root: tmp, docs: [] });
    if (!negative.failures.some((failure) => failure.anchor === 'src/index.ts:99')) {
      throw new Error('self-test did not detect the intentionally stale source anchor');
    }
    rmSync(path.join(tmp, 'docs', 'broken.md'));
    const positive = checkSourceAnchors({ root: tmp, docs: [] });
    if (positive.failures.length > 0) {
      throw new Error(`self-test positive fixture failed: ${positive.failures.map((failure) => failure.message).join('; ')}`);
    }
    console.log('✓ source anchor checker self-test passed');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) {
    runSelfTest();
    return;
  }

  const result = checkSourceAnchors(options);
  if (options.expectFailure) {
    if (result.failures.length > 0) {
      console.log(`✓ negative source-anchor check observed ${result.failures.length} expected failure(s)`);
      return;
    }
    console.error('✗ negative source-anchor check did not observe a stale source anchor');
    process.exit(1);
  }

  if (result.failures.length > 0) {
    console.error('✗ source anchor check failed');
    for (const failure of result.failures) {
      console.error(`  - ${failure.message}`);
    }
    process.exit(1);
  }

  console.log(`✓ source anchor check passed for ${result.anchorsChecked} anchor(s) across ${result.files.length} Markdown file(s)`);
}

main();
