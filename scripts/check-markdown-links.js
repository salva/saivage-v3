#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeHTML } from 'entities';

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
  'old-documents',
  'docs/working',
  'SPEC/v1/review-2026-05',
  'SPEC/v0.2/review-2026-05-agent-autonomy',
  'SPEC/review-2026-05',
  'SPEC/2026-05',
  'SPEC/analyst-as-control-surface',
  'proposals-for-review',
]);

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    selfTest: false,
    expectFailure: false,
    renderedDir: undefined,
    base: process.env.DOCS_BASE ?? '/docs/',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      options.root = argv[++index];
    } else if (arg === '--rendered-dir') {
      options.renderedDir = argv[++index];
    } else if (arg === '--base') {
      options.base = argv[++index];
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
  console.log(`Usage: node scripts/check-markdown-links.js [options]\n\nOptions:\n  --root <path>       Repository root (default: cwd)\n  --rendered-dir <path> Fresh VitePress output (default: <root>/docs/.vitepress/dist)\n  --base <prefix>     Built site prefix (default: DOCS_BASE or /docs/)\n  --self-test         Build real VitePress positive/negative fixtures\n  --expect-failure    Pass only if broken links are found\n\nPublished IDs/hrefs come only from HTML. Repository-only Markdown uses GitHub headings and explicit HTML anchors. Missing rendered output fails.\n`);
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
  try {
    return execFileSync('git', ['ls-files', '*.md'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .filter((file) => existsSync(path.join(root, file)))
      .filter((file) => !isIgnoredDirectory(path.dirname(file)))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    // Fixture/self-test roots are not git worktrees; fall back to walking them.
  }

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
  let fence;
  return content.split('\n').map((line) => {
    const match = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (match && match[1][0] === fence[0] && match[1].length >= fence.length) fence = undefined;
      return '';
    }
    if (match) { fence = match[1]; return ''; }
    return line;
  }).join('\n');
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
    /^(?:https?:)?\/\//i.test(target) ||
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
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

function anchorsForMarkdown(filePath) {
  const content = removeFencedCodeBlocks(readFileSync(filePath, 'utf8'));
  const anchors = new Set(['']);
  const counts = new Map();
  for (const line of content.split('\n')) {
    const match = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!match) continue;
    const base = slugifyHeading(match[1]);
    if (!base) continue;
    let count = counts.get(base) ?? 0;
    let id = base;
    while (anchors.has(id)) id = `${base}-${++count}`;
    counts.set(base, count);
    anchors.add(id);
  }
  for (const tag of htmlAttributes(content)) {
    if (tag.id !== undefined) anchors.add(tag.id);
    if (tag.tag === 'a' && tag.name !== undefined) anchors.add(tag.name);
  }
  return anchors;
}

// Bounded reader for generated start tags, not a DOM or network crawler. Skip raw
// script/style bodies and comments so quoted examples cannot invent IDs/links.
function htmlAttributes(html) {
  const tags = [];
  const content = html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  for (const match of content.matchAll(/<([a-z][\w:-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
    const attrs = { tag: match[1].toLowerCase() };
    for (const attr of match[2].matchAll(/\s([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      attrs[attr[1].toLowerCase()] = decodeHTML(attr[2] ?? attr[3] ?? attr[4]);
    }
    tags.push(attrs);
  }
  return tags;
}

function renderedSite(dir, base, errors) {
  if (!/^\/(?:[^?#]*\/)?$/.test(base)) throw new Error(`Invalid site base: ${base}`);
  if (!existsSync(path.join(dir, 'index.html'))) throw new Error(`Missing rendered site: ${dir}/index.html`);
  const pages = new Map();
  function walk(folder) {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.html')) {
        const tags = htmlAttributes(readFileSync(full, 'utf8'));
        pages.set(full, { ids: new Set(tags.flatMap((tag) => tag.id === undefined ? [] : [tag.id])), tags });
      }
    }
  }
  walk(dir);
  for (const [file, page] of pages) {
    const from = new URL(base + path.relative(dir, file).split(path.sep).join('/'), 'https://docs.invalid');
    for (const { href } of page.tags) {
      if (href === undefined) continue;
      const target = new URL(href, from);
      if (target.origin !== from.origin) continue;
      if (!target.pathname.startsWith(base)) {
        errors.push(`${file} links outside site prefix ${base}: ${href}`);
        continue;
      }
      const rel = decodeURIComponent(target.pathname.slice(base.length));
      const full = path.resolve(dir, rel);
      const candidates = target.pathname.endsWith('/') ? [path.join(full, 'index.html')] : [full, `${full}.html`, path.join(full, 'index.html')];
      const found = candidates.find((candidate) => pages.has(candidate) || (path.extname(candidate) && existsSync(candidate)));
      if (!isInside(full, dir) || !found) errors.push(`${file} links to missing rendered target: ${href}`);
      else if (target.hash && pages.has(found) && !pages.get(found).ids.has(decodeURIComponent(target.hash.slice(1)))) {
        errors.push(`${file} links to missing rendered anchor: ${href}`);
      }
    }
  }
  return pages;
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

function checkLinks(root, renderedDir = path.join(root, 'docs/.vitepress/dist'), base = '/docs/') {
  const rootPath = path.resolve(root);
  const files = markdownFiles(rootPath);
  const errors = [];
  const anchorCache = new Map();
  const dist = path.resolve(renderedDir);
  const pages = renderedSite(dist, base, errors);
  function anchorsFor(file) {
    if (anchorCache.has(file)) return anchorCache.get(file);
    const relative = path.relative(path.join(rootPath, 'docs'), file);
    let anchors;
    if (isInside(file, path.join(rootPath, 'docs'))) {
      const html = path.join(dist, relative.replace(/\.md$/, '.html'));
      if (!pages.has(html)) {
        errors.push(`Missing rendered page for ${file}: ${html}`);
        anchors = new Set();
      } else anchors = pages.get(html).ids;
    } else anchors = anchorsForMarkdown(file);
    anchorCache.set(file, anchors);
    return anchors;
  }

  function checkTarget(fromRel, rawTarget, lineNumber) {
    const { pathPart, fragment, normalizedTarget } = splitTarget(rawTarget);
    if (!normalizedTarget || normalizedTarget.startsWith('#')) {
      if (fragment) {
        const fromFull = path.join(rootPath, fromRel);
        const anchors = anchorsFor(fromFull);
        if (!anchors.has(decodeURIComponent(fragment))) {
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
    if (resolved.endsWith('.md')) {
      const anchors = anchorsFor(resolved);
      if (!fragment) return;
      let decodedFragment;
      try {
        decodedFragment = decodeURIComponent(fragment);
      } catch {
        decodedFragment = fragment;
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
  const checker = fileURLToPath(import.meta.url);
  const repoRoot = path.resolve(path.dirname(checker), '..');
  const scratch = process.env.TMPDIR ?? path.resolve(repoRoot, '../tmp');
  mkdirSync(scratch, { recursive: true });
  const tmp = mkdtempSync(path.join(scratch, 'saivage-md-links-'));
  try {
    symlinkSync(path.join(repoRoot, 'node_modules'), path.join(tmp, 'node_modules'), 'dir');
    const docsDir = path.join(tmp, 'docs');
    mkdirSync(path.join(docsDir, '.vitepress'), { recursive: true });
    mkdirSync(path.join(docsDir, 'nested'));
    writeFileSync(path.join(docsDir, '.vitepress/config.mjs'), 'export default { base: "/docs/", title: "Fixture" };\n');
    writeFileSync(path.join(docsDir, 'index.md'), '# Home\n\n[Other](nested/#stable)\n');
    const headings = '# Em — dash\n\n## Old → New\n\n## API/UI\n\n## Repeat\n\n## Repeat\n\n## Explicit {#stable}\n\n## Café 日本\n';
    writeFileSync(path.join(docsDir, 'nested/index.md'), headings + '\n[Home](../index.md#home)\n');
    const vitepress = path.resolve(path.dirname(checker), '../node_modules/vitepress/bin/vitepress.js');
    execFileSync(process.execPath, [vitepress, 'build', docsDir], { stdio: 'pipe', timeout: 120000 });
    const dist = path.join(docsDir, '.vitepress/dist');
    const target = path.join(dist, 'nested/index.html');
    const html = readFileSync(target, 'utf8');
    // Expectations are the real renderer's output, never checker-produced slugs.
    const ids = htmlAttributes(html).filter((tag) => /^h[1-6]$/.test(tag.tag)).map((tag) => tag.id);
    if (ids.length !== 7 || new Set(ids).size !== 7 || !ids.includes('stable')) throw new Error('Unexpected renderer fixture headings');
    const repo = '# Repo\n\n## Em — dash\n\n## API/UI\n\n## Repeat\n\n## Repeat\n\n<a id="CaseSensitive"></a>\n\n~~~md\n# Fake\n[Ignored](missing.md)\n~~~\n';
    writeFileSync(path.join(tmp, 'README.md'), repo + ids.map((id) => `[Published](docs/nested/index.md#${encodeURIComponent(id)})`).join('\n') + '\n[Dash](#em--dash)\n[API](#apiui)\n[Duplicate](#repeat-1)\n[Explicit](#CaseSensitive)\n[Remote](https://github.com/example/repo/blob/main/README.md#unvalidated)\n');
    writeFileSync(target, html.replace('</body>', ids.map((id) => `<a href="#${encodeURIComponent(id)}">same</a><a href="/docs/nested/#${encodeURIComponent(id)}">cross</a>`).join('') + '<a id="A&amp;B"></a><a href="#A%26B">entity</a></body>'));
    function invoke(args = [], expected = 0, diagnostic = '') {
      let status = 0;
      let output;
      try { output = execFileSync(process.execPath, [checker, '--root', tmp, '--base', '/docs/', ...args], { encoding: 'utf8', stdio: 'pipe', timeout: 30000 }); }
      catch (error) { status = error.status; output = String(error.stderr); }
      if (status !== expected || !output.includes(diagnostic)) throw new Error(`Fixture expected ${expected}/${diagnostic}, got ${status}: ${output}`);
    }
    invoke();
    invoke(['--base', '/wrong/'], 1, 'outside site prefix');
    invoke(['--rendered-dir', path.join(tmp, 'absent')], 1, 'Missing rendered site');
    for (const link of ['#fake', '#casesensitive', 'docs/nested/index.md#not-rendered', 'docs/missing.md']) {
      writeFileSync(path.join(tmp, 'broken.md'), `[Broken](${link.startsWith('#') ? `README.md${link}` : link})\n`);
      invoke([], 1, link);
    }
    rmSync(path.join(tmp, 'broken.md'));
    writeFileSync(target, html.replace('</body>', '<a href="/docs/absent.html">missing page</a></body>'));
    invoke([], 1, 'missing rendered target');
    writeFileSync(target, html.replace('</body>', '<a href="#absent">missing fragment</a></body>'));
    invoke([], 1, 'missing rendered anchor');
    rmSync(target);
    invoke([], 1, 'Missing rendered page');
    console.log('✓ markdown link checker real VitePress positive/negative self-test passed');
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

  const result = checkLinks(options.root, options.renderedDir, options.base);
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
