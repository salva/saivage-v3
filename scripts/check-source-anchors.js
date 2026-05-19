#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SOURCE_PATH_PATTERN = String.raw`(?:(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:ts|tsx|js|cjs|mjs|vue|json|md|sh|css|html|yml|yaml)|package\.json|README\.md)`;
const SOURCE_ANCHOR_RE = new RegExp(String.raw`(?<![A-Za-z0-9_./-])((${SOURCE_PATH_PATTERN}):(\d+)\b)(?:\s+"((?:\\.|[^"\\])*)")?`, 'g');
const SYMBOL_ANCHOR_RE = new RegExp(String.raw`(?<![A-Za-z0-9_./-])((${SOURCE_PATH_PATTERN})#symbol:([A-Za-z_$][A-Za-z0-9_.$-]*))\b`, 'g');
const IGNORED_DIRS = new Set(['.git', '.saivage', 'node_modules', 'dist', 'coverage', 'web/dist', 'docs/.vitepress/dist']);
const CONTEXT_WINDOW_LINES = 5;

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
  console.log(`Usage: node scripts/check-source-anchors.js [options]\n\nOptions:\n  --root <path>        Repository root to scan (default: cwd)\n  --doc <path>         Markdown file or directory to scan relative to root; repeatable. Defaults to README.md and docs/.\n  --self-test          Run built-in positive and negative fixture tests\n  --expect-failure     Negative-test mode: pass only if a stale source anchor is found\n\nRecognized anchors:\n  path/to/file.ext:123\n  path/to/file.ext:123 "nearby source text"\n  path/to/file.ext#symbol:exportedName\n`);
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

function unescapeQuotedContext(value) {
  if (!value) return undefined;
  return value.replace(/\\(["\\nrt])/g, (_match, escaped) => {
    if (escaped === 'n') return '\n';
    if (escaped === 'r') return '\r';
    if (escaped === 't') return '\t';
    return escaped;
  });
}

function normalizeSnippet(value) {
  return value.trim().replace(/\s+/g, ' ');
}

function pushFailure(failures, docPath, lineNumber, rawAnchor, message) {
  failures.push({ file: docPath, line: lineNumber, anchor: rawAnchor, message });
}

function validateFileLineAnchor(root, docPath, lineNumber, rawAnchor, filePath, lineRaw, contextRaw, failures) {
  const targetPath = path.join(root, filePath);
  if (!existsSync(targetPath)) {
    pushFailure(failures, docPath, lineNumber, rawAnchor, `${docPath}:${lineNumber} source anchor points to missing file: ${rawAnchor}`);
    return;
  }
  const targetLines = readFileSync(targetPath, 'utf8').split('\n');
  const targetLine = Number(lineRaw);
  if (!Number.isInteger(targetLine) || targetLine < 1 || targetLine > targetLines.length) {
    pushFailure(failures, docPath, lineNumber, rawAnchor, `${docPath}:${lineNumber} source anchor points past end of file: ${rawAnchor} (${targetLines.length} line(s))`);
    return;
  }

  const context = normalizeSnippet(unescapeQuotedContext(contextRaw) ?? '');
  if (!context) return;

  const start = Math.max(0, targetLine - 1 - CONTEXT_WINDOW_LINES);
  const end = Math.min(targetLines.length, targetLine + CONTEXT_WINDOW_LINES);
  const nearby = normalizeSnippet(targetLines.slice(start, end).join('\n'));
  if (!nearby.includes(context)) {
    pushFailure(
      failures,
      docPath,
      lineNumber,
      rawAnchor,
      `${docPath}:${lineNumber} source anchor context was not found within ${CONTEXT_WINDOW_LINES} line(s) of ${filePath}:${targetLine}: ${JSON.stringify(context)}`,
    );
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function symbolPatterns(symbol) {
  const parts = symbol.split('.').filter(Boolean);
  const leaf = parts.at(-1) ?? symbol;
  const escapedLeaf = escapeRegExp(leaf);
  const escapedFull = escapeRegExp(symbol);
  const identifierBoundary = String.raw`(?<![A-Za-z0-9_$])${escapedLeaf}(?![A-Za-z0-9_$])`;
  return [
    new RegExp(String.raw`\b(?:export\s+)?(?:async\s+)?function\s+${escapedLeaf}\b`),
    new RegExp(String.raw`\b(?:export\s+)?(?:const|let|var|class|interface|type|enum)\s+${escapedLeaf}\b`),
    new RegExp(String.raw`\b${escapedLeaf}\s*[:=]\s*`),
    new RegExp(identifierBoundary),
    new RegExp(escapedFull),
  ];
}

function validateSymbolAnchor(root, docPath, lineNumber, rawAnchor, filePath, symbol, failures) {
  const targetPath = path.join(root, filePath);
  if (!existsSync(targetPath)) {
    pushFailure(failures, docPath, lineNumber, rawAnchor, `${docPath}:${lineNumber} symbol source anchor points to missing file: ${rawAnchor}`);
    return;
  }
  const content = readFileSync(targetPath, 'utf8');
  if (!symbolPatterns(symbol).some((pattern) => pattern.test(content))) {
    pushFailure(failures, docPath, lineNumber, rawAnchor, `${docPath}:${lineNumber} symbol source anchor was not found in ${filePath}: ${rawAnchor}`);
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
      const filePath = match[2];
      const symbol = match[3];
      acceptedSymbolRanges.push([match.index ?? 0, (match.index ?? 0) + rawAnchor.length]);
      anchorsChecked += 1;
      validateSymbolAnchor(rootPath, docPath, lineForIndex(lineStarts, match.index ?? 0), rawAnchor, filePath, symbol, failures);
    }

    SOURCE_ANCHOR_RE.lastIndex = 0;
    for (const match of content.matchAll(SOURCE_ANCHOR_RE)) {
      const start = match.index ?? 0;
      const insideSymbolAnchor = acceptedSymbolRanges.some(([rangeStart, rangeEnd]) => start >= rangeStart && start < rangeEnd);
      if (insideSymbolAnchor) continue;
      const rawAnchor = match[1];
      const filePath = match[2];
      const lineRaw = match[3];
      const contextRaw = match[4];
      anchorsChecked += 1;
      validateFileLineAnchor(rootPath, docPath, lineForIndex(lineStarts, start), rawAnchor, filePath, lineRaw, contextRaw, failures);
    }
  }

  return { files, anchorsChecked, failures };
}

function assertSelfTestCase(name, result, predicate) {
  if (!predicate(result)) {
    const details = result.failures.map((failure) => failure.message).join('; ');
    throw new Error(`self-test case failed (${name}): ${details || 'unexpected success/failure state'}`);
  }
}

function writeFixtureFile(root, relativePath, content) {
  const fullPath = path.join(root, relativePath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
}

function runSelfTest() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'saivage-source-anchors-'));
  try {
    writeFixtureFile(
      tmp,
      'src/index.ts',
      [
        'export const main = 1;',
        'export function shiftedThing() {',
        '  return true;',
        '}',
        'export class FixtureClass {}',
        'export const trailing = 2;',
      ].join('\n'),
    );

    writeFixtureFile(
      tmp,
      'docs/valid-exact.md',
      '# Valid exact\n\nAnchor: src/index.ts:1\n',
    );
    assertSelfTestCase('valid exact line anchor', checkSourceAnchors({ root: tmp, docs: ['docs/valid-exact.md'] }), (result) => result.failures.length === 0 && result.anchorsChecked === 1);

    writeFixtureFile(
      tmp,
      'docs/valid-symbol-context.md',
      '# Valid symbol and context\n\nSymbol: src/index.ts#symbol:shiftedThing\n\nContext after line shift: src/index.ts:1 "return true"\n',
    );
    assertSelfTestCase('valid symbol and shifted context anchors', checkSourceAnchors({ root: tmp, docs: ['docs/valid-symbol-context.md'] }), (result) => result.failures.length === 0 && result.anchorsChecked === 2);

    writeFixtureFile(
      tmp,
      'docs/stale-file.md',
      '# Stale file\n\nAnchor: src/missing.ts:1\n',
    );
    assertSelfTestCase('stale file failure', checkSourceAnchors({ root: tmp, docs: ['docs/stale-file.md'] }), (result) => result.failures.some((failure) => failure.anchor === 'src/missing.ts:1'));

    writeFixtureFile(
      tmp,
      'docs/stale-line-context.md',
      '# Stale line and context\n\nPast EOF: src/index.ts:99\n\nBad context: src/index.ts:2 "does not exist"\n\nMissing symbol: src/index.ts#symbol:notHere\n',
    );
    const staleLineContext = checkSourceAnchors({ root: tmp, docs: ['docs/stale-line-context.md'] });
    assertSelfTestCase(
      'stale line/context/symbol failure',
      staleLineContext,
      (result) =>
        result.failures.some((failure) => failure.anchor === 'src/index.ts:99') &&
        result.failures.some((failure) => failure.anchor === 'src/index.ts:2') &&
        result.failures.some((failure) => failure.anchor === 'src/index.ts#symbol:notHere'),
    );

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
