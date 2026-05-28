#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROUTE_METHOD_RE = /fastify\.(get|post|patch|delete|put)\(\s*(['"`])([^'"`]+)\2/g;
const DOC_ROUTE_RE = /\b(GET|POST|PATCH|DELETE|PUT)\s+(?:https?:\/\/[^\s`)'"<>]+)?(\/(?:api\/[A-Za-z0-9_./:{}-]+|health)\b[^\s`)'"<>]*)/g;
const INVENTORY_ROW_RE = /^\|\s*`([^`]+)`\s*\|\s*current\s*\|/;
const CODE_LINE_ANCHOR_PATTERN = String.raw`[^\s:|]+:\d+(?:\s+"(?:\\.|[^"\\])*")?`;
const ROUTE_TABLE_ROW_RE = new RegExp('^\\|\\s*`(GET|POST|PATCH|DELETE|PUT)\\s+([^`]+)`\\s*\\|\\s*([^|]+?)\\s*\\|\\s*`(' + CODE_LINE_ANCHOR_PATTERN + ')`\\s*\\|');
const ROLE_TOOL_ROW_RE = /^\|\s*`(planner|executor|reviewer|analyst)`\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+:\d+)`\s*\|/;
const CONFIG_ROW_RE = /^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+:\d+)`\s*\|/;
const INTERNAL_DEBUG_ROUTES = new Set(['GET /api/debug/doctor', 'GET /api/debug/supervision']);
const INTERNAL_DEBUG_ROW_RE = new RegExp('^\|\s*`(GET\s+\/api\/debug\/(?:doctor|supervision))`\s*\|\s*([^|]+?)\s*\|\s*`(' + CODE_LINE_ANCHOR_PATTERN + ')`\s*\|');
const RUNTIME_CONTROL_ROW_RE = /^\|\s*`(POST\s+\/api\/runtime\/(?:pause|resume|freeze|resume-from-freeze))`\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+:\d+(?:\s+\"(?:\\\\.|[^\"\\\\])*\")?)`\s*\|/;

const DEFAULT_REMOVED_ROUTES = new Set(['POST /api/runtime/dispatch']);
const DEFAULT_OPERATOR_DOCS = new Set(['README.md','docs/index.md','docs/install.md','docs/configuration.md','docs/operation.md','docs/operator-runbook.md','docs/troubleshooting.md','docs/release-checklist.md']);
const SOURCE_FILES = ['src/server/server.ts', 'src/server/composition/fastify-app.ts', 'src/server/composition/route-composition.ts', 'src/server/routes', 'src/server/routes/operator-contracts.ts', 'src/server/contract-runtime.ts', 'src/contracts/operator-api.ts', 'src/contracts/operator-api-runtime-cards.ts', 'src/contracts/operator-api-agents.ts', 'src/contracts/operator-api-chats.ts', 'src/contracts/operator-api-files-debug.ts', 'src/contracts/operator-api-mcp.ts', 'src/contracts/operator-api-processes.ts', 'src/contracts/operator-api-events.ts', 'src/contracts/operator-api-config.ts', 'src/agents/agent-adapter.ts', 'src/agents/agent-tool-catalog.ts', 'src/agents/workspace-tools.ts', 'src/agents/config-schema.ts'];
const OPERATION_DOC = 'docs/operation.md';
const AGENTS_DOC = 'docs/agents.md';
const CONFIG_DOC = 'docs/configuration.md';
const CONFIG_DOCS = ['docs/configuration.md', 'docs/design/configuration.md'];

function listTsFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) return listTsFiles(fullPath);
    return entry.isFile() && entry.name.endsWith('.ts') ? [fullPath] : [];
  });
}

function markdownInventoryPath(docPath) { return docPath === 'README.md' || docPath.endsWith('.md'); }
function fallbackOperatorDocPaths(projectRoot) { return Array.from(DEFAULT_OPERATOR_DOCS).filter((docPath) => existsSync(join(projectRoot, docPath))); }

export function normalizeRoutePath(routePath) {
  let normalized = routePath.trim();
  normalized = normalized.split(/[?#]/, 1)[0];
  normalized = normalized.replace(/[.,;:]+$/, '');
  normalized = normalized.replace(/\{([A-Za-z0-9_]+)\}/g, ':$1');
  normalized = normalized.replace(/\/+/g, '/');
  if (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  return normalized;
}
export function routeKey(method, routePath) { return `${method.toUpperCase()} ${normalizeRoutePath(routePath)}`; }

function extractContractRoutes(projectRoot) {
  const contractPaths = ['src/contracts/operator-api.ts', 'src/contracts/operator-api-runtime-cards.ts', 'src/contracts/operator-api-agents.ts', 'src/contracts/operator-api-chats.ts', 'src/contracts/operator-api-files-debug.ts', 'src/contracts/operator-api-mcp.ts', 'src/contracts/operator-api-processes.ts', 'src/contracts/operator-api-events.ts', 'src/contracts/operator-api-config.ts'].map((relPath) => join(projectRoot, relPath));
  const routes = new Set();
  const contractRe = /method:\s*['"`](GET|POST|PATCH|DELETE|PUT)['"`][\s\S]*?path:\s*['"`]([^'"`]+)['"`]/g;
  for (const contractPath of contractPaths) {
    if (!existsSync(contractPath)) continue;
    const content = readFileSync(contractPath, 'utf-8');
    for (const match of content.matchAll(contractRe)) {
      const method = match[1].toUpperCase();
      const routePath = match[2];
      if (routePath.startsWith('/api/') || routePath === '/health' || routePath === '/health/ready') routes.add(routeKey(method, routePath));
    }
  }
  return routes;
}

export function extractImplementedRoutes(projectRoot = process.cwd()) {
  const routeFiles = [join(projectRoot, 'src/server/server.ts'), ...listTsFiles(join(projectRoot, 'src/server/routes'))];
  const routes = extractContractRoutes(projectRoot);
  for (const file of routeFiles) {
    if (!existsSync(file)) continue;
    const content = readFileSync(file, 'utf-8');
    ROUTE_METHOD_RE.lastIndex = 0;
    for (const match of content.matchAll(ROUTE_METHOD_RE)) {
      const method = match[1].toUpperCase();
      const routePath = match[3];
      if (routePath.startsWith('/api/') || routePath === '/health' || routePath === '/health/ready') routes.add(routeKey(method, routePath));
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
    if (!markdownInventoryPath(docPath)) continue;
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
      mentions.push({ key: routeKey(method, routePath), method, path: routePath, file: docPath, line: content.slice(0, match.index).split('\n').length });
    }
  }
  return mentions;
}

function extractMarkedBlock(content, name) {
  const start = `<!-- saivage:${name}:start -->`;
  const end = `<!-- saivage:${name}:end -->`;
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) return null;
  return content.slice(startIndex + start.length, endIndex);
}

function parseRouteInventory(projectRoot, docPath = OPERATION_DOC) {
  const fullPath = join(projectRoot, docPath);
  const rows = [];
  if (!existsSync(fullPath)) return rows;
  const content = readFileSync(fullPath, 'utf-8');
  const block = extractMarkedBlock(content, 'operator-routes') ?? '';
  for (const [index, line] of block.split('\n').entries()) {
    const match = line.match(ROUTE_TABLE_ROW_RE);
    if (!match) continue;
    rows.push({ key: routeKey(match[1], match[2]), method: match[1], path: normalizeRoutePath(match[2]), purpose: match[3].trim(), anchor: match[4], file: docPath, line: content.slice(0, content.indexOf(block)).split('\n').length + index + 1 });
  }
  return rows;
}

function parseInternalDebugInventory(projectRoot, docPath = OPERATION_DOC) {
  const fullPath = join(projectRoot, docPath);
  const rows = [];
  if (!existsSync(fullPath)) return rows;
  const content = readFileSync(fullPath, 'utf-8');
  const block = extractMarkedBlock(content, 'internal-debug-routes') ?? '';
  for (const [index, line] of block.split('\n').entries()) {
    const match = line.match(ROUTE_TABLE_ROW_RE);
    if (!match) continue;
    rows.push({ key: routeKey(match[1], match[2]), method: match[1], path: normalizeRoutePath(match[2]), purpose: match[3].trim(), anchor: match[4], file: docPath, line: content.slice(0, content.indexOf(block)).split('\n').length + index + 1 });
  }
  return rows;
}

function parseRoleToolTable(projectRoot, docPath = AGENTS_DOC) {
  const fullPath = join(projectRoot, docPath);
  const rows = new Map();
  if (!existsSync(fullPath)) return rows;
  const block = extractMarkedBlock(readFileSync(fullPath, 'utf-8'), 'agent-tools') ?? '';
  for (const line of block.split('\n')) {
    const match = line.match(ROLE_TOOL_ROW_RE);
    if (!match) continue;
    rows.set(match[1], { tools: match[2].split(',').map((tool) => tool.trim()).filter(Boolean).sort(), anchor: match[3] });
  }
  return rows;
}

function parseConfigTable(projectRoot, docPath = CONFIG_DOC) {
  const fullPath = join(projectRoot, docPath);
  const rows = new Map();
  if (!existsSync(fullPath)) return rows;
  const block = extractMarkedBlock(readFileSync(fullPath, 'utf-8'), 'config-schema') ?? '';
  for (const line of block.split('\n')) {
    const match = line.match(CONFIG_ROW_RE);
    if (!match || match[1] === 'section') continue;
    rows.set(match[1], { fields: match[2].split(',').map((field) => field.trim()).filter(Boolean).sort(), anchor: match[3] });
  }
  return rows;
}

function parseRuntimeControlTable(projectRoot, docPath = OPERATION_DOC) {
  const fullPath = join(projectRoot, docPath);
  const rows = new Map();
  if (!existsSync(fullPath)) return rows;
  const block = extractMarkedBlock(readFileSync(fullPath, 'utf-8'), 'runtime-controls') ?? '';
  for (const line of block.split('\n')) {
    const match = line.match(RUNTIME_CONTROL_ROW_RE);
    if (!match) continue;
    rows.set(match[1], { request: match[2], response: match[3], anchor: match[4] });
  }
  return rows;
}

function readSource(projectRoot, relPath) { return readFileSync(join(projectRoot, relPath), 'utf-8'); }
function extractArrayLiteral(content, name) {
  const match = content.match(new RegExp(`${name}[^=]*=\\s*(?:new Set\\()?\\s*\\[([\\s\\S]*?)\\]`));
  if (!match) return [];
  return Array.from(match[1].matchAll(/'([^']+)'/g)).map((m) => m[1]);
}
function extractObjectArray(content, role) {
  const match = content.match(new RegExp(`${role}:\\s*\\[([^\\]]*)\\]`));
  if (!match) return [];
  return Array.from(match[1].matchAll(/'([^']+)'/g)).map((m) => m[1]);
}
function uniqueSorted(values) { return Array.from(new Set(values)).sort(); }

function extractToolDefinitionNames(content, _constName) {
  return Array.from(content.matchAll(/tool\(\s*['"]([^'"]+)['"]/g)).map((m) => m[1]);
}

function extractImplementedAgentTools(projectRoot) {
  const catalog = readSource(projectRoot, 'src/agents/agent-tool-catalog.ts');
  const analystSchemas = readSource(projectRoot, 'src/agents/analyst-tool-schemas.ts');
  const catalogAnalystTools = extractObjectArray(catalog, 'analyst');
  return new Map([
    ['planner', uniqueSorted(extractObjectArray(catalog, 'planner'))],
    ['executor', uniqueSorted(extractObjectArray(catalog, 'executor'))],
    ['reviewer', uniqueSorted(extractObjectArray(catalog, 'reviewer'))],
    ['analyst', uniqueSorted(catalogAnalystTools.length > 0 ? catalogAnalystTools : extractToolDefinitionNames(analystSchemas, 'ANALYST_TOOL_DEFINITIONS'))],
  ]);
}

function objectFields(content, constName) {
  const startRe = new RegExp(`(?:export\\s+)?const\\s+${constName}\\s*=\\s*z\\.object\\(\\{`);
  const start = content.search(startRe);
  if (start === -1) return [];
  const bodyStart = content.indexOf('{', start) + 1;
  let depth = 1;
  let i = bodyStart;
  for (; i < content.length; i++) {
    const ch = content[i];
    if (ch === '{') depth += 1;
    if (ch === '}') depth -= 1;
    if (depth === 0) break;
  }
  const body = content.slice(bodyStart, i);
  const fields = [];
  for (const line of body.split('\n')) {
    const match = line.match(/^\s{2}([A-Za-z_][A-Za-z0-9_]*):/);
    if (match) fields.push(match[1]);
  }
  return uniqueSorted(fields);
}

function extractConfigSchema(projectRoot) {
  const content = readSource(projectRoot, 'src/agents/config-schema.ts');
  return new Map([
    ['top-level', objectFields(content, 'saivageConfigSchema')],
    ['models', objectFields(content, 'modelsSectionSchema')],
    ['providers.entry', objectFields(content, 'providerEntrySchema')],
    ['providers.account', objectFields(content, 'providerAccountSchema')],
    ['server', objectFields(content, 'serverSectionSchema')],
    ['runtime', objectFields(content, 'runtimeSectionSchema')],
    ['runtime.process_timeouts', objectFields(content, 'processTimeoutsPersistedSchema')],
    ['security', objectFields(content, 'securitySectionSchema')],
    ['supervisor', objectFields(content, 'supervisorSectionSchema')],
    ['telegram', objectFields(content, 'telegramSectionSchema')],
    ['notifications', objectFields(content, 'notificationsSectionSchema')],
    ['mcpServers.entry', objectFields(content, 'mcpServerEntrySchema')],
  ]);
}

const CONTEXT_WINDOW_LINES = 5;

function unescapeQuotedContext(value) {
  if (!value) return undefined;
  return value.replace(/\\(["\\nrt])/g, (_match, escaped) => {
    if (escaped === 'n') return '\n';
    if (escaped === 'r') return '\r';
    if (escaped === 't') return '\t';
    return escaped;
  });
}

function normalizeAnchorSnippet(value) {
  return value.trim().replace(/\s+/g, ' ');
}

function parseLineAnchor(anchor) {
  const match = anchor.match(/^([^\s:|]+):(\d+)(?:\s+"((?:\\.|[^"\\])*)")?$/);
  if (!match) return null;
  return { file: match[1], line: Number(match[2]), context: unescapeQuotedContext(match[3]) };
}

function anchorLine(projectRoot, anchor) {
  const parsed = parseLineAnchor(anchor);
  if (!parsed || !Number.isInteger(parsed.line) || parsed.line < 1 || !existsSync(join(projectRoot, parsed.file))) return null;
  const lines = readFileSync(join(projectRoot, parsed.file), 'utf-8').split('\n');
  if (parsed.line > lines.length) return null;
  return lines[parsed.line - 1];
}

function verifyAnchor(projectRoot, anchor, failures, context) {
  const parsed = parseLineAnchor(anchor);
  const line = anchorLine(projectRoot, anchor);
  if (line === null) {
    if (!parsed || !Number.isInteger(parsed.line) || parsed.line < 1 || !existsSync(join(projectRoot, parsed.file))) failures.push({ type: 'bad-anchor', message: `${context} has invalid code anchor ${anchor}` });
    else failures.push({ type: 'bad-anchor', message: `${context} points past end of ${anchor}` });
    return;
  }

  const expectedContext = normalizeAnchorSnippet(parsed.context ?? '');
  if (!expectedContext) return;

  const lines = readFileSync(join(projectRoot, parsed.file), 'utf-8').split('\n');
  const start = Math.max(0, parsed.line - 1 - CONTEXT_WINDOW_LINES);
  const end = Math.min(lines.length, parsed.line + CONTEXT_WINDOW_LINES);
  const nearby = normalizeAnchorSnippet(lines.slice(start, end).join('\n'));
  if (!nearby.includes(expectedContext)) {
    failures.push({
      type: 'anchor-source-mismatch',
      message: `${context} anchor ${anchor} context was not found within ${CONTEXT_WINDOW_LINES} line(s) of ${parsed.file}:${parsed.line}`,
    });
  }
}

function verifyAnchorLineContains(projectRoot, anchor, requiredFragments, failures, context) {
  const line = anchorLine(projectRoot, anchor);
  if (line === null) return;
  for (const fragment of requiredFragments) {
    if (!line.includes(fragment)) failures.push({ type: 'anchor-source-mismatch', message: `${context} anchor ${anchor} does not contain expected source fragment ${JSON.stringify(fragment)}` });
  }
}

function sourceContains(projectRoot, relPath, fragments) {
  const fullPath = join(projectRoot, relPath);
  if (!existsSync(fullPath)) return false;
  const content = readFileSync(fullPath, 'utf-8');
  return fragments.every((fragment) => content.includes(fragment));
}
function sameArray(a, b) { return a.length === b.length && a.every((value, index) => value === b[index]); }

export function verifyDocRoutes(options = {}) {
  const projectRoot = options.projectRoot ?? process.cwd();
  const docPaths = options.docPaths ?? activeOperatorDocPaths(projectRoot);
  const implementedRoutes = options.implementedRoutes ?? extractImplementedRoutes(projectRoot);
  const removedRoutes = options.removedRoutes ?? DEFAULT_REMOVED_ROUTES;
  const documentedRoutes = extractDocumentedRoutes(projectRoot, docPaths);
  const failures = [];

  for (const mention of documentedRoutes) {
    if (removedRoutes.has(mention.key)) failures.push({ type: 'removed-route', route: mention.key, file: mention.file, line: mention.line, message: `${mention.file}:${mention.line} mentions removed route ${mention.key}` });
    else if (!implementedRoutes.has(mention.key)) failures.push({ type: 'missing-route', route: mention.key, file: mention.file, line: mention.line, message: `${mention.file}:${mention.line} mentions ${mention.key}, but no matching Fastify or contract route was found` });
  }

  const inventoryRows = options.routeInventoryRows ?? parseRouteInventory(projectRoot);
  const internalDebugRows = options.internalDebugRows ?? parseInternalDebugInventory(projectRoot);
  const inventoryCounts = new Map();
  for (const row of inventoryRows) {
    inventoryCounts.set(row.key, (inventoryCounts.get(row.key) ?? 0) + 1);
    verifyAnchor(projectRoot, row.anchor, failures, `route inventory ${row.key}`);
    if (INTERNAL_DEBUG_ROUTES.has(row.key)) failures.push({ type: 'internal-debug-in-operator-inventory', route: row.key, message: `${OPERATION_DOC} must document ${row.key} in the internal debug inventory, not the operator route inventory` });
  }
  const internalDebugCounts = new Map();
  for (const row of internalDebugRows) {
    internalDebugCounts.set(row.key, (internalDebugCounts.get(row.key) ?? 0) + 1);
    verifyAnchor(projectRoot, row.anchor, failures, `internal debug route ${row.key}`);
  }
  for (const route of implementedRoutes) {
    const count = INTERNAL_DEBUG_ROUTES.has(route) ? (internalDebugCounts.get(route) ?? 0) : (inventoryCounts.get(route) ?? 0);
    if (count !== 1) {
      const block = INTERNAL_DEBUG_ROUTES.has(route) ? 'internal debug inventory' : 'operator route inventory';
      failures.push({ type: 'route-inventory-count', route, message: `${OPERATION_DOC} must document implemented route ${route} exactly once in the ${block}; found ${count}` });
    }
  }
  for (const [route, count] of inventoryCounts) {
    if (!implementedRoutes.has(route)) failures.push({ type: 'route-inventory-missing', route, message: `${OPERATION_DOC} route inventory lists ${route}, but no matching Fastify or contract route was found` });
    if (count > 1) failures.push({ type: 'route-inventory-count', route, message: `${OPERATION_DOC} route inventory lists ${route} ${count} times` });
  }
  for (const [route, count] of internalDebugCounts) {
    if (!INTERNAL_DEBUG_ROUTES.has(route)) failures.push({ type: 'unexpected-internal-debug-route', route, message: `${OPERATION_DOC} internal debug inventory lists unclassified route ${route}` });
    if (!implementedRoutes.has(route)) failures.push({ type: 'route-inventory-missing', route, message: `${OPERATION_DOC} internal debug inventory lists ${route}, but no matching Fastify route was found` });
    if (count > 1) failures.push({ type: 'route-inventory-count', route, message: `${OPERATION_DOC} internal debug inventory lists ${route} ${count} times` });
  }

  return { ok: failures.length === 0, failures, documentedRoutes, implementedRoutes, checkedDocs: docPaths, routeInventoryRows: inventoryRows, internalDebugRows };
}

export function verifyAgentToolDocs(options = {}) {
  const projectRoot = options.projectRoot ?? process.cwd();
  const expected = options.expectedTools ?? extractImplementedAgentTools(projectRoot);
  const documented = options.documentedTools ?? parseRoleToolTable(projectRoot);
  const failures = [];
  for (const [role, tools] of expected) {
    const row = documented.get(role);
    if (!row) { failures.push({ type: 'missing-agent-role', message: `${AGENTS_DOC} is missing agent-tool row for ${role}` }); continue; }
    verifyAnchor(projectRoot, row.anchor, failures, `agent tool row ${role}`);
    if (!sameArray(row.tools, tools)) failures.push({ type: 'agent-tool-parity', role, message: `${AGENTS_DOC} tools for ${role} do not match src/agents/agent-tool-catalog.ts (doc=${row.tools.join(',')} source=${tools.join(',')})` });
  }
  return { ok: failures.length === 0, failures, expected, documented };
}

export function verifyRuntimeControlDocs(options = {}) {
  const projectRoot = options.projectRoot ?? process.cwd();
  const rows = options.rows ?? parseRuntimeControlTable(projectRoot);
  const verifySource = options.verifySource ?? true;
  const failures = [];
  const expected = new Map();
  for (const [route, shape] of expected) {
    const row = rows.get(route);
    if (!row) { failures.push({ type: 'missing-runtime-control', message: `${OPERATION_DOC} is missing runtime-control shape row for ${route}` }); continue; }
    verifyAnchor(projectRoot, row.anchor, failures, `runtime control ${route}`);
    if (verifySource) verifyAnchorLineContains(projectRoot, row.anchor, shape.sourceFragments, failures, `runtime control ${route}`);
    if (row.request !== shape.request || row.response !== shape.response) failures.push({ type: 'runtime-control-shape', route, message: `${OPERATION_DOC} documents ${route} as ${row.request} -> ${row.response}, expected ${shape.request} -> ${shape.response}` });
  }
  return { ok: failures.length === 0, failures, expected, documented: rows };
}

export function verifyConfigDocs(options = {}) {
  const projectRoot = options.projectRoot ?? process.cwd();
  const expected = options.expectedConfig ?? extractConfigSchema(projectRoot);
  const docPaths = options.configDocPaths ?? CONFIG_DOCS;
  const documentedByPath = new Map();
  const failures = [];

  for (const docPath of docPaths) {
    const documented = options.documentedConfig ?? parseConfigTable(projectRoot, docPath);
    documentedByPath.set(docPath, documented);
    for (const [section, fields] of expected) {
      const row = documented.get(section);
      if (!row) { failures.push({ type: 'missing-config-section', section, message: `${docPath} is missing config schema row for ${section}` }); continue; }
      verifyAnchor(projectRoot, row.anchor, failures, `config schema ${docPath} ${section}`);
      if (!sameArray(row.fields, fields)) failures.push({ type: 'config-schema-parity', section, message: `${docPath} fields for ${section} do not match src/agents/config-schema.ts (doc=${row.fields.join(',')} source=${fields.join(',')})` });
    }
  }

  return { ok: failures.length === 0, failures, expected, documented: documentedByPath, checkedDocs: docPaths };
}

export function verifyDocSourceContracts(options = {}) {
  const projectRoot = options.projectRoot ?? process.cwd();
  const routeResult = verifyDocRoutes({ ...options, projectRoot });
  const toolResult = verifyAgentToolDocs({ projectRoot });
  const runtimeControlResult = verifyRuntimeControlDocs({ projectRoot });
  const configResult = verifyConfigDocs({ projectRoot });
  const failures = [...routeResult.failures, ...toolResult.failures, ...runtimeControlResult.failures, ...configResult.failures];
  return { ok: failures.length === 0, failures, routeResult, toolResult, runtimeControlResult, configResult };
}

export function formatVerificationResult(result, projectRoot = process.cwd()) {
  const lines = [];
  lines.push('==> Verifying active docs against source contracts...');
  lines.push(`  Checked ${result.routeResult.checkedDocs.length} active doc(s), ${result.routeResult.implementedRoutes.size} implemented operator route(s), ${result.routeResult.routeInventoryRows.length} inventory row(s).`);
  lines.push(`  Checked agent tool parity, runtime-control shapes, configuration schema fields in ${result.configResult.checkedDocs.length} config doc(s), and code anchors.`);
  if (result.ok) lines.push('  ✓ current docs match Fastify/contract routes, agent tools, runtime controls, config schema, and anchors');
  else {
    lines.push('  ✗ documentation/source drift detected:');
    for (const failure of result.failures) lines.push(`    - ${failure.message}`);
  }
  lines.push(`  Source files: ${SOURCE_FILES.map((p) => relative(projectRoot, join(projectRoot, p))).join(', ')}`);
  return lines.join('\n');
}

function main() {
  const projectRoot = process.cwd();
  const result = verifyDocSourceContracts({ projectRoot });
  console.log(formatVerificationResult(result, projectRoot));
  if (!result.ok) process.exit(1);
}

const invokedPath = process.argv[1] ? fileURLToPath(new URL(`file://${process.argv[1]}`)) : '';
if (invokedPath === fileURLToPath(import.meta.url)) main();
