#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MARKDOWN_LINK_RE = /(?<!!)(?<!\\)\[([^\]\n]+)\]\(([^)\n]+)\)/g;
const REFERENCE_DEF_RE = /^\s*\[[^\]]+\]:\s*(\S+)/gm;
const IGNORED_DIRS = new Set([
  '.git',
  '.saivage',
  'node_modules',
  'dist',
  'coverage',
  '.vitepress/dist',
  'web/dist',
]);

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    selfTest: false,
    expectFailure: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      options.root = argv[++index];
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
  console.log(`Usage: node scripts/check-markdown-links.js [options]\n\nOptions:\n  --root <path>       Repository root to scan (default: cwd)\n  --self-test         Run a built-in positive and negative fixture test\n  --expect-failure    Negative-test mode: pass only if broken links are found\n`);
}

function isIgnoredDirectory(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (segments.includes('node_modules') || segments.includes('dist') || segments.includes('coverage')) {
    return true;
  }
  return Array.from(IGNORED_DIRS).some((ignored) => normalized === ignored || normalized.startsWith(`${ignored}/`));
}

function markdownFiles(root) {
  const files = [];

  function walk(dir, prefix = '') {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!isIgnoredDirectory(rel)) {
          walk(full, rel);
        }
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(rel);
      }
    }
  }

  walk(root);
  return files.sort((a, b) => a.localeCompare(b));
}

function removeFencedCodeBlocks(content) {
  return content.replace(/```[\s\S]*?```/g, '');
}

function stripInlineCode(content) {
  return content.replace(/`[^`\n]+`/g, '');
}

function splitTarget(rawTarget) {
  const trimmed = rawTarget.trim().replace(/^<(.+)>$/, '$1');
  const withoutTitle = trimmed.match(/^([^\s]+)(?:\s+["'][\s\S]*["'])?$/)?.[1] ?? trimmed;
  const hashIndex = withoutTitle.indexOf('#');
  const queryIndex = withoutTitle.indexOf('?');
  const cutIndexes = [hashIndex, queryIndex].filter((index) => index >= 0);
  const cutIndex = cutIndexes.length > 0 ? Math.min(...cutIndexes) : -1;
  return {
    pathPart: cutIndex >= 0 ? withoutTitle.slice(0, cutIndex) : withoutTitle,
    fragment: hashIndex >= 0 ? withoutTitle.slice(hashIndex + 1).split('?')[0] : '',
    normalizedTarget: withoutTitle,
  };
}

function isExternalOrSpecial(target) {
  return (
    /^https?:\/\//i.test(target) ||
    /^mailto:/i.test(target) ||
    /^tel:/i.test(target) ||
    /^data:/i.test(target) ||
    /^javascript:/i.test(target)
  );
}

function slugifyHeading(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function anchorsForMarkdown(filePath) {
  const content = readFileSync(filePath, 'utf8');
  const anchors = new Set(['']);
  const counts = new Map();
  for (const line of content.split('\n')) {
    const match = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!match) continue;
    const base = slugifyHeading(match[1]);
    if (!base) continue;
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

function candidateFiles(root, fromFile, targetPath) {
  if (!targetPath) {
    return [fromFile];
  }

  let decoded;
  try {
    decoded = decodeURIComponent(targetPath);
  } catch {
    decoded = targetPath;
  }

  if (decoded.startsWith('/')) {
    const withoutSlash = decoded.replace(/^\/+/, '');
    return [
      path.join(root, 'docs', withoutSlash),
      path.join(root, 'docs', `${withoutSlash}.md`),
      path.join(root, 'docs', withoutSlash, 'index.md'),
      path.join(root, withoutSlash),
      path.join(root, `${withoutSlash}.md`),
      path.join(root, withoutSlash, 'index.md'),
    ];
  }

  const resolved = path.resolve(path.dirname(fromFile), decoded);
  const ext = path.extname(resolved);
  if (ext === '.html') {
    return [resolved.replace(/\.html$/, '.md'), path.join(resolved.replace(/\.html$/, ''), 'index.md')];
  }
  if (ext) {
    return [resolved];
  }
  return [resolved, `${resolved}.md`, path.join(resolved, 'index.md')];
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function checkLinks(root) {
  const rootPath = path.resolve(root);
  const files = markdownFiles(rootPath);
  const errors = [];
  const anchorCache = new Map();

  function checkTarget(fromRel, rawTarget, lineNumber) {
    const { pathPart, fragment, normalizedTarget } = splitTarget(rawTarget);
    if (!normalizedTarget || normalizedTarget.startsWith('#')) {
      if (fragment) {
        const fromFull = path.join(rootPath, fromRel);
        const anchors = anchorCache.get(fromFull) ?? anchorsForMarkdown(fromFull);
        anchorCache.set(fromFull, anchors);
        if (!anchors.has(decodeURIComponent(fragment).toLowerCase())) {
          errors.push(`${fromRel}:${lineNumber} has missing local anchor: ${rawTarget}`);
        }
      }
      return;
    }
    if (isExternalOrSpecial(normalizedTarget)) {
      return;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(normalizedTarget)) {
      errors.push(`${fromRel}:${lineNumber} uses unsupported URI scheme: ${rawTarget}`);
      return;
    }

    const fromFull = path.join(rootPath, fromRel);
    const candidates = candidateFiles(rootPath, fromFull, pathPart);
    const existing = candidates.find((candidate) => existsSync(candidate));
    if (!existing) {
      errors.push(`${fromRel}:${lineNumber} links to missing target: ${rawTarget}`);
      return;
    }
    const resolved = path.resolve(existing);
    if (!isInside(resolved, rootPath)) {
      errors.push(`${fromRel}:${lineNumber} links outside the repository: ${rawTarget}`);
      return;
    }
    if (fragment && resolved.endsWith('.md')) {
      const anchors = anchorCache.get(resolved) ?? anchorsForMarkdown(resolved);
      anchorCache.set(resolved, anchors);
      let decodedFragment;
      try {
        decodedFragment = decodeURIComponent(fragment).toLowerCase();
      } catch {
        decodedFragment = fragment.toLowerCase();
      }
      if (!anchors.has(decodedFragment)) {
        errors.push(`${fromRel}:${lineNumber} links to missing anchor: ${rawTarget}`);
      }
    }
  }

  for (const file of files) {
    const fullPath = path.join(rootPath, file);
    const raw = readFileSync(fullPath, 'utf8');
    const content = stripInlineCode(removeFencedCodeBlocks(raw));
    const lineStarts = [0];
    for (let index = 0; index < content.length; index += 1) {
      if (content[index] === '\n') lineStarts.push(index + 1);
    }
    const lineForIndex = (index) => {
      let low = 0;
      let high = lineStarts.length - 1;
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (lineStarts[mid] <= index) low = mid + 1;
        else high = mid - 1;
      }
      return high + 1;
    };

    for (const match of content.matchAll(MARKDOWN_LINK_RE)) {
      checkTarget(file, match[2], lineForIndex(match.index ?? 0));
    }
    for (const match of content.matchAll(REFERENCE_DEF_RE)) {
      checkTarget(file, match[1], lineForIndex(match.index ?? 0));
    }
  }

  return { files, errors };
}

function runSelfTest() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'saivage-md-links-'));
  try {
    writeFileSync(path.join(tmp, 'README.md'), '# Fixture\n\n[Docs](docs/index.md#home)\n');
    writeFileSync(path.join(tmp, 'broken.md'), '# Broken\n\n[Missing](docs/missing.md)\n');
    const docsDir = path.join(tmp, 'docs');
    writeFileSync(path.join(tmp, 'ok.md'), '# OK\n');
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(path.join(docsDir, 'index.md'), '# Home\n\n[Root](../ok.md)\n');
    const negative = checkLinks(tmp);
    if (!negative.errors.some((error) => error.includes('docs/missing.md'))) {
      throw new Error('self-test did not detect the intentionally missing link');
    }
    rmSync(path.join(tmp, 'broken.md'));
    const positive = checkLinks(tmp);
    if (positive.errors.length > 0) {
      throw new Error(`self-test positive fixture failed: ${positive.errors.join('; ')}`);
    }
    console.log('✓ markdown link checker self-test passed');
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

  const result = checkLinks(options.root);
  if (options.expectFailure) {
    if (result.errors.length > 0) {
      console.log(`✓ negative markdown link check observed ${result.errors.length} expected failure(s)`);
      return;
    }
    console.error('✗ negative markdown link check did not observe a broken internal link');
    process.exit(1);
  }

  if (result.errors.length > 0) {
    console.error('✗ markdown link check failed');
    for (const error of result.errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }

  console.log(`✓ markdown link check passed for ${result.files.length} Markdown file(s)`);
}

main();
