#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const designDir = path.join(root, 'docs', 'architecture');
const markdownLinkPattern = /(?<!!)(?<!\\)\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const errors = [];

function removeFencedCodeBlocks(content) {
  return content.replace(/```[\s\S]*?```/g, '');
}

function stripFragment(target) {
  const hashIndex = target.indexOf('#');
  return hashIndex === -1 ? target : target.slice(0, hashIndex);
}

function candidateFilesForAbsoluteDocsLink(target) {
  const withoutSlash = target.replace(/^\//, '');
  return [
    path.join(root, 'docs', `${withoutSlash}.md`),
    path.join(root, 'docs', withoutSlash, 'index.md'),
    path.join(root, 'docs', withoutSlash),
  ];
}

function candidateFilesForRelativeLink(fromFile, target) {
  const resolved = path.resolve(path.dirname(fromFile), target);
  if (path.extname(resolved)) {
    return [resolved];
  }
  return [`${resolved}.md`, path.join(resolved, 'index.md'), resolved];
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function checkLink(fromFile, rawTarget) {
  if (!rawTarget || rawTarget.startsWith('#')) {
    return;
  }
  if (rawTarget.startsWith('https://')) {
    return;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(rawTarget)) {
    errors.push(`${path.relative(root, fromFile)} links to unsupported non-HTTPS URI: ${rawTarget}`);
    return;
  }

  const target = stripFragment(decodeURIComponent(rawTarget));
  if (!target) {
    return;
  }

  const candidates = target.startsWith('/')
    ? candidateFilesForAbsoluteDocsLink(target)
    : candidateFilesForRelativeLink(fromFile, target);
  const existing = candidates.find((candidate) => existsSync(candidate));

  if (!existing) {
    errors.push(`${path.relative(root, fromFile)} links to missing Markdown target: ${rawTarget}`);
    return;
  }

  if (!isInside(existing, root)) {
    errors.push(`${path.relative(root, fromFile)} links outside the repository: ${rawTarget}`);
    return;
  }

  const docsRoot = path.join(root, 'docs');
  if (!isInside(existing, docsRoot) && path.dirname(existing) !== root) {
    errors.push(
      `${path.relative(root, fromFile)} links outside docs/ or the repository root: ${rawTarget}`,
    );
  }
}

if (!existsSync(designDir)) {
  console.error('✗ docs/architecture/ does not exist');
  process.exit(1);
}

const files = readdirSync(designDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
  .map((entry) => path.join(designDir, entry.name))
  .sort((a, b) => a.localeCompare(b));

if (files.length === 0) {
  console.error('✗ docs/architecture/ has no Markdown files');
  process.exit(1);
}

for (const file of files) {
  const content = removeFencedCodeBlocks(readFileSync(file, 'utf8'));
  for (const match of content.matchAll(markdownLinkPattern)) {
    checkLink(file, match[2]);
  }
}

if (errors.length > 0) {
  console.error('✗ architecture documentation link check failed');
  for (const error of errors) {
    console.error(`  - ${error}`);
  }
  process.exit(1);
}

console.log(`✓ architecture documentation link check passed for ${files.length} Markdown file(s)`);
