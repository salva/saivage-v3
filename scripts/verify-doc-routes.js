#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HTTP_METHODS = ['GET', 'POST', 'PATCH', 'DELETE', 'PUT'];
const ROUTE_METHOD_RE = /fastify\.(get|post|patch|delete|put)\(\s*(['"`])([^'"`]+)\2/g;
const DOC_ROUTE_RE = /\b(GET|POST|PATCH|DELETE|PUT)\s+(?:https?:\/\/[^\s`)'"<>]+)?(\/(?:api\/[A-Za-z0-9_./:{}-]+|health)\b[^\s`)'"<>]*)/g;
const INVENTORY_ROW_RE = /^\|\s*`([^`]+)`\s*\|\s*current\s*\|/;

const DEFAULT_REMOVED_ROUTES = new Set(['POST /api/runtime/dispatch']);
const DEFAULT_OPERATOR_DOCS = new Set([
  'README.md',
  'docs/index.md',
  'docs/install.md',
  'docs/configuration.md',
  'docs/operation.md',
  'docs/operator-runbook.md',
  'docs/troubleshooting.md',
  'docs/release-checklist.md',
]);

function listTsFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) return listTsFiles(fullPath);
    return entry.isFile() && entry.name.endsWith('.ts') ? [fullPath] : [];
  });
}

function isMarkdownInventoryPath(docPath) {
  return docPath === 'README.md' || docPath.endsWith('.md');
}

function fallbackOperatorDocPaths(projectRoot) {
  return Array.from(DEFAULT_OPERATOR_DOCS).filter((docPath) => existsSync(join(projectRoot, docPath)));
}

export function normalizeRoutePath(routePath) {
  let normalized = routePath.trim();
  normalized = normalized.split(/[?#]/, 1)[0];
  normalized = normalized.replace(/[.,;:]+$/, '');
  normalized = normalized.replace(/\{([A-Za-z0-9_]+)\}/g, ':$1');
  normalized = normalized.replace(/\/+/g, '/');
  if (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  return normalized;
}

export function routeKey(method, routePath) {
  return `${method.toUpperCase()} ${normalizeRoutePath(routePath)}`;
}

export function extractImplementedRoutes(projectRoot = process.cwd()) {
  const routeFiles = [join(projectRoot, 'src/server/server.ts'), ...listTsFiles(join(projectRoot, 'src/server/routes'))];
  const routes = new Set();

  for (const file of routeFiles) {
    if (!existsSync(file)) continue;
    const content = readFileSync(file, 'utf-8');
    ROUTE_METHOD_RE.lastIndex = 0;
    for (const match of content.matchAll(ROUTE_METHOD_RE)) {
      const method = match[1].toUpperCase();
      const routePath = match[3];
      if (routePath.startsWith('/api/') || routePath === '/health') {
        routes.add(routeKey(method, routePath));
      }
    }
  }

  return routes;
}

export function activeOperatorDocPaths(projectRoot = process.cwd()) {
  const inventoryPath = join(projectRoot, 'docs/documentation-inventory.md');
  if (!existsSync(inventoryPath)) return fallbackOperatorDocPaths(projectRoot);

  const inventory = readFileSync(inventoryPath, 'utf-8');
  const activePaths = [];
  for (const line of inventory.split('\n')) {
    const match = line.match(INVENTORY_ROW_RE);
    if (!match) continue;
    const docPath = match[1];
    if (!isMarkdownInventoryPath(docPath)) continue;
    if (!existsSync(join(projectRoot, docPath))) continue;
    activePaths.push(docPath);
  }

  return activePaths.length > 0 ? Array.from(new Set(activePaths)) : fallbackOperatorDocPaths(projectRoot);
}

export function extractDocumentedRoutes(projectRoot = process.cwd(), docPaths = activeOperatorDocPaths(projectRoot)) {
  const mentions = [];

  for (const docPath of docPaths) {
    const absolutePath = join(projectRoot, docPath);
    if (!existsSync(absolutePath)) continue;
    const content = readFileSync(absolutePath, 'utf-8');
    DOC_ROUTE_RE.lastIndex = 0;
    for (const match of content.matchAll(DOC_ROUTE_RE)) {
      const method = match[1];
      const routePath = normalizeRoutePath(match[2]);
      mentions.push({
        key: routeKey(method, routePath),
        method,
        path: routePath,
        file: docPath,
        line: content.slice(0, match.index).split('\n').length,
      });
    }
  }

  return mentions;
}

export function verifyDocRoutes(options = {}) {
  const projectRoot = options.projectRoot ?? process.cwd();
  const docPaths = options.docPaths ?? activeOperatorDocPaths(projectRoot);
  const implementedRoutes = options.implementedRoutes ?? extractImplementedRoutes(projectRoot);
  const removedRoutes = options.removedRoutes ?? DEFAULT_REMOVED_ROUTES;
  const documentedRoutes = extractDocumentedRoutes(projectRoot, docPaths);
  const failures = [];

  for (const mention of documentedRoutes) {
    if (removedRoutes.has(mention.key)) {
      failures.push({
        type: 'removed-route',
        route: mention.key,
        file: mention.file,
        line: mention.line,
        message: `${mention.file}:${mention.line} mentions removed route ${mention.key}`,
      });
      continue;
    }
    if (!implementedRoutes.has(mention.key)) {
      failures.push({
        type: 'missing-route',
        route: mention.key,
        file: mention.file,
        line: mention.line,
        message: `${mention.file}:${mention.line} mentions ${mention.key}, but no matching Fastify route was found`,
      });
    }
  }

  return { ok: failures.length === 0, failures, documentedRoutes, implementedRoutes, checkedDocs: docPaths };
}

export function formatVerificationResult(result, projectRoot = process.cwd()) {
  const lines = [];
  lines.push(`==> Verifying operator-facing HTTP route docs against Fastify routes...`);
  lines.push(`  Checked ${result.checkedDocs.length} active operator doc(s):`);
  for (const doc of result.checkedDocs) lines.push(`    ${relative(projectRoot, join(projectRoot, doc)) || doc}`);
  lines.push(`  Found ${result.implementedRoutes.size} implemented operator route(s) and ${result.documentedRoutes.length} documented route mention(s).`);
  if (result.ok) {
    lines.push('  ✓ documented operator-facing HTTP routes are implemented and removed routes are absent');
  } else {
    lines.push('  ✗ route documentation drift detected:');
    for (const failure of result.failures) lines.push(`    - ${failure.message}`);
  }
  return lines.join('\n');
}

function main() {
  const projectRoot = process.cwd();
  const result = verifyDocRoutes({ projectRoot });
  console.log(formatVerificationResult(result, projectRoot));
  if (!result.ok) process.exit(1);
}

const invokedPath = process.argv[1] ? fileURLToPath(new URL(`file://${process.argv[1]}`)) : '';
if (invokedPath === fileURLToPath(import.meta.url)) main();
