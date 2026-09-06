#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROUTE_METHOD_RE = /fastify\.(get|post|patch|delete|put)\(\s*(['"`])([^'"`]+)\2/g;
const DOC_ROUTE_RE = /\b(GET|POST|PATCH|DELETE|PUT)\s+(?:https?:\/\/[^\s`)'"<>]+)?(\/(?:api\/[A-Za-z0-9_./:{}-]+|health)\b[^\s`)'"<>]*)/g;
const INVENTORY_ROW_RE = /^\|\s*`([^`]+)`\s*\|\s*current\s*\|/;
const CODE_LINE_ANCHOR_PATTERN = String.raw`[^\s:|]+:\d+(?:\s+"(?:\\.|[^"\\])*")?`;
const ROUTE_TABLE_ROW_RE = new RegExp('^\\|\\s*`(GET|POST|PATCH|DELETE|PUT)\\s+([^`]+)`\\s*\\|\\s*([^|]+?)\\s*\\|\\s*`(' + CODE_LINE_ANCHOR_PATTERN + ')`\\s*\\|');
const AGENT_TOOL_ROW_RE = /^\|\s*`([^`]+)`\s*\|\s*`([^`]*)`\s*\|\s*`([^`]+:\d+)`\s*\|\s*$/;
const CONFIG_ROW_RE = /^\|\s*`([^`]+)`\s*\|\s*`([^`]*)`\s*\|\s*`([^`]+:\d+)`\s*\|\s*$/;

const DEFAULT_REMOVED_ROUTES = new Set(['POST /api/runtime/dispatch']);
const DEFAULT_OPERATOR_DOCS = new Set(['docs/spec/system-specification.md', 'docs/spec/operator-ui.md', 'docs/architecture/system-architecture.md', 'docs/runbook/index.md']);
const STATIC_SOURCE_FILES = ['src/server/server.ts', 'src/server/composition/fastify-app.ts', 'src/server/composition/route-composition.ts', 'src/server/routes', 'src/server/routes/operator-contracts.ts', 'src/server/contract-runtime.ts', 'src/schemas/saivage-config.ts'];
const OPERATION_DOC = 'docs/architecture/system-architecture.md';
const AGENTS_DOC = 'docs/architecture/system-architecture.md';
const CONFIG_DOC = 'docs/architecture/system-architecture.md';
const CONFIG_DOCS = ['docs/architecture/system-architecture.md'];
const CONTRACT_ROUTE_RE = /method:\s*['"`](GET|POST|PATCH|DELETE|PUT)['"`][\s\S]*?path:\s*['"`]([^'"`]+)['"`]/g;

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

function isInternalDebugRoute(routeKey) {
  const spaceIndex = routeKey.indexOf(' ');
  const routePath = spaceIndex === -1 ? routeKey : routeKey.slice(spaceIndex + 1);
  return routePath.startsWith('/api/debug/');
}

export function discoverOperatorContractSourceFiles(projectRoot = process.cwd()) {
  const contractsDirectory = join(projectRoot, 'src/contracts');
  if (!existsSync(contractsDirectory)) return [];
  return readdirSync(contractsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^operator-api.*\.ts$/.test(entry.name))
    .map((entry) => relative(projectRoot, join(contractsDirectory, entry.name)))
    .sort();
}

function extractContractRoutesFromSource(projectRoot, relPath) {
  const contractPath = join(projectRoot, relPath);
  const routes = new Set();
  if (!existsSync(contractPath)) return routes;
  const content = readFileSync(contractPath, 'utf-8');
  CONTRACT_ROUTE_RE.lastIndex = 0;
  for (const match of content.matchAll(CONTRACT_ROUTE_RE)) {
    const method = match[1].toUpperCase();
    const routePath = match[2];
    if (routePath.startsWith('/api/') || routePath === '/health' || routePath === '/health/ready') routes.add(routeKey(method, routePath));
  }
  return routes;
}

export function discoverOperatorContractRouteSources(projectRoot = process.cwd()) {
  return discoverOperatorContractSourceFiles(projectRoot).filter((relPath) => extractContractRoutesFromSource(projectRoot, relPath).size > 0);
}

function extractContractRoutes(projectRoot) {
  const routes = new Set();
  for (const relPath of discoverOperatorContractRouteSources(projectRoot)) {
    for (const route of extractContractRoutesFromSource(projectRoot, relPath)) routes.add(route);
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
  return fallbackOperatorDocPaths(projectRoot);
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

function markedBlockLines(content, name) {
  const block = extractMarkedBlock(content, name) ?? '';
  const firstLine = content.slice(0, content.indexOf(block)).split('\n').length;
  return block.split('\n').map((text, index) => ({ text, line: firstLine + index }));
}

function isMarkdownTableScaffolding(line, firstHeading) {
  const trimmed = line.trim();
  return trimmed === '' || trimmed.startsWith(`| ${firstHeading} |`) || /^\|\s*:?-+:?\s*\|/.test(trimmed);
}

function parseAgentToolTable(projectRoot, docPath = AGENTS_DOC) {
  const fullPath = join(projectRoot, docPath);
  const rows = [];
  const failures = [];
  if (!existsSync(fullPath)) return { rows, failures };
  const content = readFileSync(fullPath, 'utf-8');
  for (const { text, line } of markedBlockLines(content, 'agent-tools')) {
    const match = text.match(AGENT_TOOL_ROW_RE);
    if (match) {
      rows.push({ key: match[1], tools: match[2].split(',').map((tool) => tool.trim()).filter(Boolean).sort(), anchor: match[3], file: docPath, line });
      continue;
    }
    if (text.trim().startsWith('|') && !isMarkdownTableScaffolding(text, 'Agent')) failures.push({ type: 'malformed-agent-tool-row', file: docPath, line, message: `${docPath}:${line} has a malformed Agent tools data row` });
  }
  return { rows, failures };
}

function parseConfigTable(projectRoot, docPath = CONFIG_DOC) {
  const fullPath = join(projectRoot, docPath);
  const rows = [];
  const failures = [];
  if (!existsSync(fullPath)) return { rows, failures };
  const content = readFileSync(fullPath, 'utf-8');
  for (const { text, line } of markedBlockLines(content, 'config-schema')) {
    const match = text.match(CONFIG_ROW_RE);
    if (match && match[1] !== 'section') {
      rows.push({ key: match[1], fields: match[2].split(',').map((field) => field.trim()).filter(Boolean).sort(), anchor: match[3], file: docPath, line });
      continue;
    }
    if (text.trim().startsWith('|') && !isMarkdownTableScaffolding(text, 'Section')) failures.push({ type: 'malformed-config-row', file: docPath, line, message: `${docPath}:${line} has a malformed Config schema data row` });
  }
  return { rows, failures };
}

function readSource(projectRoot, relPath) { return readFileSync(join(projectRoot, relPath), 'utf-8'); }
function uniqueSorted(values) { return Array.from(new Set(values)).sort(); }

function sourceAst(projectRoot, relPath) {
  const content = readSource(projectRoot, relPath);
  const ast = ts.createSourceFile(relPath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (ast.parseDiagnostics.length > 0) throw new Error(`${relPath} does not parse: ${ts.flattenDiagnosticMessageText(ast.parseDiagnostics[0].messageText, ' ')}`);
  return { content, ast };
}

function unwrapExpression(node) {
  while (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
  return node;
}

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  throw new Error(`Unsupported computed property at ${node.getSourceFile().fileName}:${node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
}

function constInitializers(ast) {
  const values = new Map();
  for (const statement of ast.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) values.set(declaration.name.text, declaration.initializer);
    }
  }
  return values;
}

function requiredInitializer(initializers, name, source) {
  const value = initializers.get(name);
  if (!value) throw new Error(`Unable to resolve ${name} in ${source}`);
  return unwrapExpression(value);
}

function stringArray(node, context) {
  const value = unwrapExpression(node);
  if (!ts.isArrayLiteralExpression(value)) throw new Error(`${context} must be an array literal`);
  return value.elements.map((element) => {
    const unwrapped = unwrapExpression(element);
    if (!ts.isStringLiteral(unwrapped)) throw new Error(`${context} contains a non-string entry`);
    return unwrapped.text;
  });
}

const AGENTS_SOURCE = 'src/config/system-templates/classic/template.ts';
const AGENTS_CONSTANT = 'CLASSIC_AGENTS';

function extractImplementedAgentTools(projectRoot) {
  const source = sourceAst(projectRoot, AGENTS_SOURCE);
  const initial = requiredInitializer(constInitializers(source.ast), AGENTS_CONSTANT, source.ast.fileName);
  if (!ts.isCallExpression(initial) || !ts.isPropertyAccessExpression(initial.expression)
    || !ts.isIdentifier(initial.expression.expression) || initial.expression.expression.text !== 'Object'
    || initial.expression.name.text !== 'freeze' || initial.arguments.length !== 1) {
    throw new Error(`${AGENTS_CONSTANT} must be one Object.freeze call`);
  }
  const catalog = unwrapExpression(initial.arguments[0]);
  if (!ts.isObjectLiteralExpression(catalog)) throw new Error(`${AGENTS_CONSTANT} must freeze an object literal`);
  const result = new Map();
  for (const property of catalog.properties) {
    if (!ts.isPropertyAssignment(property)) throw new Error(`${AGENTS_CONSTANT} contains an unsupported member`);
    const agentName = propertyName(property.name);
    const frozenAgent = unwrapExpression(property.initializer);
    if (!ts.isCallExpression(frozenAgent) || frozenAgent.arguments.length !== 1) throw new Error(`${AGENTS_CONSTANT}.${agentName} must be frozen`);
    const agent = unwrapExpression(frozenAgent.arguments[0]);
    if (!ts.isObjectLiteralExpression(agent)) throw new Error(`${AGENTS_CONSTANT}.${agentName} must be an object literal`);
    const toolsProperty = agent.properties.find((member) => ts.isPropertyAssignment(member) && propertyName(member.name) === 'tools');
    if (!toolsProperty || !ts.isPropertyAssignment(toolsProperty)) throw new Error(`${AGENTS_CONSTANT}.${agentName} has no tools`);
    const frozenTools = unwrapExpression(toolsProperty.initializer);
    if (!ts.isCallExpression(frozenTools) || frozenTools.arguments.length !== 1) throw new Error(`${AGENTS_CONSTANT}.${agentName}.tools must be frozen`);
    const names = stringArray(frozenTools.arguments[0], `${AGENTS_CONSTANT}.${agentName}.tools`);
    if (new Set(names).size !== names.length) throw new Error(`${AGENTS_CONSTANT}.${agentName}.tools contains duplicates`);
    result.set(agentName, uniqueSorted(names));
  }
  if (result.size === 0) throw new Error(`${AGENTS_CONSTANT} must not be empty`);
  return result;
}

const SCHEMA_WRAPPERS = new Set(['optional', 'default', 'strict', 'passthrough', 'superRefine', 'transform', 'pipe']);
const SCALAR_CHAINS = new Set(['min', 'max', 'int', 'positive', 'nonnegative', 'safe', 'refine', 'regex']);
const SCALAR_FACTORIES = new Set(['string', 'number', 'boolean', 'enum', 'unknown', 'literal', 'any']);

function extractConfigSchema(projectRoot) {
  const relPath = 'src/schemas/saivage-config.ts';
  const { ast } = sourceAst(projectRoot, relPath);
  const initializers = constInitializers(ast);
  const importedIdentifiers = new Set(ast.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) return [];
    const names = [];
    if (statement.importClause.name) names.push(statement.importClause.name.text);
    const bindings = statement.importClause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) names.push(element.name.text);
    if (bindings && ts.isNamespaceImport(bindings)) names.push(bindings.name.text);
    return names;
  }));
  const rows = new Map();
  const stack = [];

  function emit(path, object) {
    const fields = object.properties.map((property) => {
      if (!ts.isPropertyAssignment(property)) throw new Error(`Unsupported config object member at ${relPath}:${ast.getLineAndCharacterOfPosition(property.getStart()).line + 1}`);
      return propertyName(property.name);
    }).sort();
    if (rows.has(path)) throw new Error(`Conflicting duplicate config occurrence path ${path}`);
    rows.set(path, fields);
    for (const property of object.properties) traverse(property.initializer, path === 'top-level' ? propertyName(property.name) : `${path}.${propertyName(property.name)}`);
  }

  function traverse(rawNode, path) {
    const node = unwrapExpression(rawNode);
    if (ts.isIdentifier(node)) {
      if (!initializers.has(node.text)) {
        if (importedIdentifiers.has(node.text)) return;
        throw new Error(`Unable to resolve ${node.text}`);
      }
      if (stack.includes(node.text)) throw new Error(`Recursive config schema reference ${[...stack, node.text].join(' -> ')}`);
      stack.push(node.text);
      traverse(requiredInitializer(initializers, node.text, relPath), path);
      stack.pop();
      return;
    }
    if (!ts.isCallExpression(node)) throw new Error(`Unsupported reachable config schema expression at ${relPath}:${ast.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
    const callee = node.expression;
    if (!ts.isPropertyAccessExpression(callee)) throw new Error(`Unsupported reachable config schema call at ${relPath}:${ast.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
    const method = callee.name.text;
    const receiver = unwrapExpression(callee.expression);
    if (SCHEMA_WRAPPERS.has(method) || SCALAR_CHAINS.has(method)) { traverse(receiver, path); return; }
    if (ts.isIdentifier(receiver) && receiver.text === 'z') {
      if (method === 'object') {
        const shape = node.arguments[0] && unwrapExpression(node.arguments[0]);
        if (!shape || !ts.isObjectLiteralExpression(shape)) throw new Error(`z.object at ${path} must use an object literal`);
        emit(path, shape);
        return;
      }
      if (method === 'record') {
        if (node.arguments.length < 1 || node.arguments.length > 2) throw new Error(`Unsupported z.record at ${path}`);
        traverse(node.arguments[node.arguments.length - 1], `${path}.entry`);
        return;
      }
      if (method === 'preprocess') {
        if (node.arguments.length !== 2) throw new Error(`Unsupported z.preprocess at ${path}`);
        traverse(node.arguments[1], path);
        return;
      }
      if (method === 'array') {
        if (node.arguments.length !== 1) throw new Error(`Unsupported z.array at ${path}`);
        traverse(node.arguments[0], `${path}.item`);
        return;
      }
      if (method === 'union') {
        const operands = node.arguments[0] && unwrapExpression(node.arguments[0]);
        if (!operands || !ts.isArrayLiteralExpression(operands)) throw new Error(`Unsupported z.union at ${path}`);
        operands.elements.forEach((operand, index) => traverse(operand, `${path}.variant${index + 1}`));
        return;
      }
      if (method === 'discriminatedUnion') {
        const discriminator = node.arguments[0] && unwrapExpression(node.arguments[0]);
        const operands = node.arguments[1] && unwrapExpression(node.arguments[1]);
        if (!discriminator || !ts.isStringLiteral(discriminator) || !operands || !ts.isArrayLiteralExpression(operands)) throw new Error(`Unsupported z.discriminatedUnion at ${path}`);
        operands.elements.forEach((operand, index) => traverse(operand, `${path}.variant${index + 1}`));
        return;
      }
      if (SCALAR_FACTORIES.has(method)) return;
      throw new Error(`Unsupported reachable z.${method} at ${path}`);
    }
    throw new Error(`Unsupported reachable schema combinator .${method} at ${path}`);
  }
  stack.push('saivageConfigSchema');
  traverse(requiredInitializer(initializers, 'saivageConfigSchema', relPath), 'top-level');
  stack.pop();
  return rows;
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

function sourceContains(projectRoot, relPath, fragments) {
  const fullPath = join(projectRoot, relPath);
  if (!existsSync(fullPath)) return false;
  const content = readFileSync(fullPath, 'utf-8');
  return fragments.every((fragment) => content.includes(fragment));
}
function sameArray(a, b) { return a.length === b.length && a.every((value, index) => value === b[index]); }

const VALUE_CONTRACT_DOCS = [
  'README.md',
  'docs/architecture/system-architecture.md',
  'docs/spec/operator-ui.md',
  'docs/spec/system-specification.md',
];

function asciiCompare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function asciiSorted(values) { return [...values].sort(asciiCompare); }
function exactKeys(value, keys, context) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !sameArray(asciiSorted(Object.keys(value)), asciiSorted(keys))) {
    throw new Error(`${context} must have exactly ${keys.join(', ')}`);
  }
}
function canonicalValue(value, context = 'value') {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    if (typeof value === 'string' && /[\r\n]/.test(value)) throw new Error(`${context} contains a newline`);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`${context} must be a finite safe integer`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalValue(item, `${context}[${index}]`));
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(asciiSorted(Object.keys(value)).map((key) => [key, canonicalValue(value[key], `${context}.${key}`)]));
  throw new Error(`${context} is not JSON-compatible`);
}
function canonicalJson(value) { return JSON.stringify(canonicalValue(value)); }
function claimObject(value, keys, context) {
  if (value === null || Array.isArray(value) || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${context} must be a plain object`);
  exactKeys(value, keys, context);
  return value;
}
function claimString(value, context) { if (typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error(`${context} must be a single-line string`); return value; }
function claimBoolean(value, context) { if (typeof value !== 'boolean') throw new Error(`${context} must be a boolean`); return value; }
function claimInteger(value, context) { if (!Number.isSafeInteger(value)) throw new Error(`${context} must be a finite safe integer`); return value; }
function claimLiteral(value, expected, context) { if (value !== expected) throw new Error(`${context} must be ${JSON.stringify(expected)}`); return value; }
function claimArray(value, context) { if (!Array.isArray(value)) throw new Error(`${context} must be an array`); return value; }
function claimStrings(value, context, set = false) {
  const strings = claimArray(value, context).map((item, index) => claimString(item, `${context}[${index}]`));
  return set ? mathematicalSet(strings, context) : strings;
}
function normalizeRegex(value, context) {
  const object = claimObject(value, ['source', 'flags', 'anchored'], context);
  return { source: claimString(object.source, `${context}.source`), flags: claimString(object.flags, `${context}.flags`), anchored: claimBoolean(object.anchored, `${context}.anchored`) };
}
function normalizeErrorClaim(value, context) {
  const object = claimObject(value, ['strict', 'variants'], context);
  claimLiteral(object.strict, true, `${context}.strict`);
  const variants = claimArray(object.variants, `${context}.variants`).map((variant, variantIndex) => {
    const variantContext = `${context}.variants[${variantIndex}]`;
    const candidate = claimObject(variant, ['strict', 'fields'], variantContext);
    claimLiteral(candidate.strict, true, `${variantContext}.strict`);
    const fields = candidate.fields;
    if (fields === null || Array.isArray(fields) || typeof fields !== 'object' || Object.getPrototypeOf(fields) !== Object.prototype || Object.keys(fields).length === 0) throw new Error(`${variantContext}.fields must be a non-empty plain object`);
    const normalized = {};
    for (const key of asciiSorted(Object.keys(fields))) {
      const fieldContext = `${variantContext}.fields.${key}`;
      const field = fields[key];
      if (field?.kind === 'literal') {
        claimObject(field, ['kind', 'value'], fieldContext);
        normalized[key] = { kind: 'literal', value: canonicalValue(field.value, `${fieldContext}.value`) };
      } else if (field?.kind === 'schema') {
        claimObject(field, ['kind', 'name'], fieldContext);
        normalized[key] = { kind: 'schema', name: claimString(field.name, `${fieldContext}.name`) };
      } else if (field?.kind === 'type') {
        claimObject(field, ['kind', 'name'], fieldContext);
        if (!['string', 'number', 'boolean'].includes(field.name)) throw new Error(`${fieldContext}.name has unsupported type`);
        normalized[key] = { kind: 'type', name: field.name };
      } else throw new Error(`${fieldContext} has unsupported discriminator`);
    }
    return { strict: true, fields: normalized };
  });
  return { strict: true, variants: mathematicalSet(variants, `${context}.variants`) };
}
function normalizeToolClaim(key, value) {
  if (key === 'tools.shipped-role-inventories') {
    const object = claimObject(value, ['templates', 'agents'], key);
    const agents = claimArray(object.agents, `${key}.agents`).map((agent, index) => {
      const candidate = claimObject(agent, ['name', 'tools'], `${key}.agents[${index}]`);
      return { name: claimString(candidate.name, `${key}.agents[${index}].name`), tools: claimStrings(candidate.tools, `${key}.agents[${index}].tools`) };
    });
    if (new Set(agents.map((agent) => agent.name)).size !== agents.length) throw new Error(`${key}.agents contains duplicate names`);
    return { templates: claimStrings(object.templates, `${key}.templates`, true), agents: mathematicalSet(agents, `${key}.agents`) };
  }
  if (key === 'tools.projector-presenter-equality') {
    const object = claimObject(value, ['names', 'sources', 'gates'], key);
    return { names: claimStrings(object.names, `${key}.names`, true), sources: claimStrings(object.sources, `${key}.sources`, true), gates: claimStrings(object.gates, `${key}.gates`, true) };
  }
  const object = claimObject(value, ['analystPresenterOnly', 'plannerOnly'], key);
  return { analystPresenterOnly: claimStrings(object.analystPresenterOnly, `${key}.analystPresenterOnly`, true), plannerOnly: claimStrings(object.plannerOnly, `${key}.plannerOnly`, true) };
}
function normalizeCardIdentity(value) {
  const key = 'identity.card';
  const object = claimObject(value, ['alternatives', 'pattern', 'segment', 'stem', 'separator', 'minimumSegments', 'maximumSegments'], key);
  const alternatives = claimArray(object.alternatives, `${key}.alternatives`).map((alternative, index) => {
    const context = `${key}.alternatives[${index}]`;
    if (alternative?.kind === 'literal') { const candidate = claimObject(alternative, ['kind', 'value'], context); return { kind: 'literal', value: claimString(candidate.value, `${context}.value`) }; }
    if (alternative?.kind === 'pattern') { const candidate = claimObject(alternative, ['kind', 'source'], context); return { kind: 'pattern', source: claimString(candidate.source, `${context}.source`) }; }
    throw new Error(`${context} has unsupported discriminator`);
  });
  return { alternatives, pattern: normalizeRegex(object.pattern, `${key}.pattern`), segment: normalizeRegex(object.segment, `${key}.segment`), stem: claimString(object.stem, `${key}.stem`), separator: claimString(object.separator, `${key}.separator`), minimumSegments: claimInteger(object.minimumSegments, `${key}.minimumSegments`), maximumSegments: claimInteger(object.maximumSegments, `${key}.maximumSegments`) };
}
function normalizeSessionIdentity(value) {
  const key = 'identity.conversation-session';
  const object = claimObject(value, ['inputGuard', 'pattern', 'captures', 'nullTest', 'agentParser', 'scopeAlternatives', 'constructors', 'identityParser', 'operators', 'grouping'], key);
  const captures = claimArray(object.captures, `${key}.captures`).map((capture, index) => { const candidate = claimObject(capture, ['index', 'meaning'], `${key}.captures[${index}]`); return { index: claimInteger(candidate.index, `${key}.captures[${index}].index`), meaning: claimString(candidate.meaning, `${key}.captures[${index}].meaning`) }; });
  const constructors = claimArray(object.constructors, `${key}.constructors`).map((constructor, index) => { const candidate = claimObject(constructor, ['name', 'template'], `${key}.constructors[${index}]`); return { name: claimString(candidate.name, `${key}.constructors[${index}].name`), template: claimString(candidate.template, `${key}.constructors[${index}].template`) }; });
  return { inputGuard: claimLiteral(object.inputGuard, 'string', `${key}.inputGuard`), pattern: normalizeRegex(object.pattern, `${key}.pattern`), captures, nullTest: claimString(object.nullTest, `${key}.nullTest`), agentParser: claimString(object.agentParser, `${key}.agentParser`), scopeAlternatives: claimStrings(object.scopeAlternatives, `${key}.scopeAlternatives`), constructors, identityParser: claimString(object.identityParser, `${key}.identityParser`), operators: claimStrings(object.operators, `${key}.operators`), grouping: claimString(object.grouping, `${key}.grouping`) };
}
function normalizeBackendPivot(key, value) {
  const from = key === 'pivot.cards-diff-from';
  const keys = from ? ['field', 'presence', 'variants', 'mapping', 'regex', 'refinement', 'transform'] : ['field', 'presence', 'variants', 'mapping', 'regex', 'refinement', 'transform', 'meanings'];
  const object = claimObject(value, keys, key);
  const variants = claimArray(object.variants, `${key}.variants`).map((variant, index) => {
    const context = `${key}.variants[${index}]`;
    if (variant?.kind === 'canonical-positive-safe-integer') { claimObject(variant, ['kind'], context); return { kind: 'canonical-positive-safe-integer' }; }
    if (variant?.kind === 'literal') { const candidate = claimObject(variant, ['kind', 'value'], context); return { kind: 'literal', value: claimLiteral(candidate.value, 'current', `${context}.value`) }; }
    throw new Error(`${context} has unsupported discriminator`);
  });
  const normalized = { field: claimLiteral(object.field, from ? 'from' : 'to', `${key}.field`), presence: claimLiteral(object.presence, from ? 'required' : 'optional', `${key}.presence`), variants, mapping: claimLiteral(object.mapping, from ? 'fromVersion' : 'toVersion', `${key}.mapping`), regex: claimString(object.regex, `${key}.regex`), refinement: claimString(object.refinement, `${key}.refinement`), transform: claimLiteral(object.transform, 'Number', `${key}.transform`) };
  if (!from) {
    const meanings = claimObject(object.meanings, ['numeric', 'omitted', 'current'], `${key}.meanings`);
    normalized.meanings = {
      numeric: claimLiteral(meanings.numeric, 'historical-version', `${key}.meanings.numeric`),
      omitted: claimLiteral(meanings.omitted, 'current-artifact', `${key}.meanings.omitted`),
      current: claimLiteral(meanings.current, 'current-artifact', `${key}.meanings.current`),
    };
  }
  return normalized;
}
function normalizeUiPivot(value) {
  const key = 'pivot.ui-cards-diff-current-request';
  const object = claimObject(value, ['key', 'selection', 'request', 'currentness', 'reuse'], key);
  const fields = claimArray(object.key, `${key}.key`).map((field, index) => { const candidate = claimObject(field, ['name', 'type'], `${key}.key[${index}]`); return { name: claimString(candidate.name, `${key}.key[${index}].name`), type: claimString(candidate.type, `${key}.key[${index}].type`) }; });
  const selection = claimObject(object.selection, ['construction', 'frozen', 'startArgument'], `${key}.selection`);
  const construction = claimObject(selection.construction, ['cardId', 'fromSeq', 'to'], `${key}.selection.construction`);
  const request = claimObject(object.request, ['operation', 'params', 'query', 'signal'], `${key}.request`);
  const params = claimObject(request.params, ['id'], `${key}.request.params`);
  const query = claimObject(request.query, ['from', 'to'], `${key}.request.query`);
  const currentness = claimObject(object.currentness, ['abortPreviousOwner', 'freshOwner', 'fences', 'selectionGuards', 'acceptedSideCondition', 'retainedKey'], `${key}.currentness`);
  const reuse = claimObject(object.reuse, ['refresh', 'retry', 'invalidationGates', 'reconnectGates'], `${key}.reuse`);
  return {
    key: fields,
    selection: { construction: { cardId: claimString(construction.cardId, `${key}.selection.construction.cardId`), fromSeq: claimString(construction.fromSeq, `${key}.selection.construction.fromSeq`), to: claimLiteral(construction.to, 'current', `${key}.selection.construction.to`) }, frozen: claimLiteral(selection.frozen, true, `${key}.selection.frozen`), startArgument: claimString(selection.startArgument, `${key}.selection.startArgument`) },
    request: { operation: claimLiteral(request.operation, 'cards.diff', `${key}.request.operation`), params: { id: claimString(params.id, `${key}.request.params.id`) }, query: { from: claimString(query.from, `${key}.request.query.from`), to: claimString(query.to, `${key}.request.query.to`) }, signal: claimLiteral(request.signal, 'forwarded', `${key}.request.signal`) },
    currentness: { abortPreviousOwner: claimLiteral(currentness.abortPreviousOwner, true, `${key}.currentness.abortPreviousOwner`), freshOwner: claimStrings(currentness.freshOwner, `${key}.currentness.freshOwner`), fences: claimStrings(currentness.fences, `${key}.currentness.fences`), selectionGuards: claimStrings(currentness.selectionGuards, `${key}.currentness.selectionGuards`), acceptedSideCondition: claimStrings(currentness.acceptedSideCondition, `${key}.currentness.acceptedSideCondition`), retainedKey: claimString(currentness.retainedKey, `${key}.currentness.retainedKey`) },
    reuse: { refresh: claimString(reuse.refresh, `${key}.reuse.refresh`), retry: claimString(reuse.retry, `${key}.reuse.retry`), invalidationGates: claimStrings(reuse.invalidationGates, `${key}.reuse.invalidationGates`), reconnectGates: claimStrings(reuse.reconnectGates, `${key}.reuse.reconnectGates`) },
  };
}
function normalizeClaimValue(key, value) {
  if (!Object.prototype.hasOwnProperty.call(VALUE_CONTRACT_CLAIMS, key)) throw new Error(`Unknown value-contract claim ${key}`);
  if (key.startsWith('error.')) return normalizeErrorClaim(value, key);
  if (key.startsWith('vocabulary.')) { const object = claimObject(value, ['members'], key); return { members: claimStrings(object.members, `${key}.members`, true) }; }
  if (key.startsWith('constant.')) { const object = claimObject(value, ['unit', 'value'], key); if (!['bytes', 'characters', 'milliseconds', 'segments', 'tokens'].includes(object.unit)) throw new Error(`${key}.unit is unsupported`); return { unit: object.unit, value: claimInteger(object.value, `${key}.value`) }; }
  if (key.startsWith('tools.')) return normalizeToolClaim(key, value);
  if (key === 'identity.card') return normalizeCardIdentity(value);
  if (key === 'identity.conversation-session') return normalizeSessionIdentity(value);
  if (key === 'pivot.cards-diff-from' || key === 'pivot.cards-diff-to') return normalizeBackendPivot(key, value);
  if (key === 'pivot.ui-cards-diff-current-request') return normalizeUiPivot(value);
  throw new Error(`Value-contract claim ${key} has no semantic validator`);
}
export function serializeValueContractClaim(key, value) { return canonicalJson(normalizeClaimValue(key, value)); }
function mathematicalSet(values, context) {
  const serialized = values.map((value, index) => canonicalJson(canonicalValue(value, `${context}[${index}]`)));
  if (new Set(serialized).size !== serialized.length) throw new Error(`${context} contains duplicates`);
  return serialized.sort(asciiCompare).map((value) => JSON.parse(value));
}
function numberInitializer(projectRoot, path, name) {
  const { ast } = sourceAst(projectRoot, path);
  const node = requiredInitializer(constInitializers(ast), name, path);
  if (!ts.isNumericLiteral(node)) throw new Error(`${path} ${name} must be a numeric literal`);
  const value = Number(node.text);
  if (!Number.isSafeInteger(value)) throw new Error(`${path} ${name} must be a safe integer`);
  return value;
}
function identifierText(node, context) {
  const value = unwrapExpression(node);
  if (!ts.isIdentifier(value)) throw new Error(`${context} must be an identifier`);
  return value.text;
}
function stringLiteralText(node, context) {
  const value = unwrapExpression(node);
  if (!ts.isStringLiteral(value) && !ts.isNoSubstitutionTemplateLiteral(value)) throw new Error(`${context} must be a string literal`);
  return value.text;
}
function callNamed(node, receiver, method) {
  const value = unwrapExpression(node);
  return ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression)
    && ts.isIdentifier(value.expression.expression) && value.expression.expression.text === receiver
    && value.expression.name.text === method ? value : null;
}
function chainedCall(node, method) {
  const value = unwrapExpression(node);
  return ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression) && value.expression.name.text === method ? value : null;
}
function zodObject(node, context) {
  let value = unwrapExpression(node);
  let strict = false;
  for (;;) {
    const strictCall = chainedCall(value, 'strict');
    if (strictCall) { strict = true; value = unwrapExpression(strictCall.expression.expression); continue; }
    const typedWrapper = chainedCall(value, 'superRefine');
    if (typedWrapper) { value = unwrapExpression(typedWrapper.expression.expression); continue; }
    break;
  }
  const call = callNamed(value, 'z', 'object');
  if (!call || call.arguments.length !== 1) throw new Error(`${context} must be a z.object call`);
  const shape = unwrapExpression(call.arguments[0]);
  if (!ts.isObjectLiteralExpression(shape)) throw new Error(`${context} must use an object literal shape`);
  return { strict, shape };
}
function zodLiteralDescriptor(node, context) {
  const value = unwrapExpression(node);
  const literal = callNamed(value, 'z', 'literal');
  if (literal && literal.arguments.length === 1) {
    const argument = unwrapExpression(literal.arguments[0]);
    if (ts.isStringLiteral(argument) || ts.isNumericLiteral(argument)) return { kind: 'literal', value: ts.isNumericLiteral(argument) ? Number(argument.text) : argument.text };
    if (argument.kind === ts.SyntaxKind.TrueKeyword || argument.kind === ts.SyntaxKind.FalseKeyword) return { kind: 'literal', value: argument.kind === ts.SyntaxKind.TrueKeyword };
    throw new Error(`${context} has unsupported z.literal value`);
  }
  if (ts.isIdentifier(value)) return { kind: 'schema', name: value.text };
  const factory = ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression) && ts.isIdentifier(value.expression.expression) && value.expression.expression.text === 'z'
    ? value.expression.name.text : null;
  if (factory && ['string', 'number', 'boolean'].includes(factory)) return { kind: 'type', name: factory };
  throw new Error(`${context} has unsupported field schema`);
}
function strictObjectVariant(projectRoot, path, name) {
  const { ast } = sourceAst(projectRoot, path);
  const object = zodObject(requiredInitializer(constInitializers(ast), name, path), `${path} ${name}`);
  if (!object.strict) throw new Error(`${path} ${name} must be strict`);
  const fields = {};
  for (const member of object.shape.properties) {
    if (!ts.isPropertyAssignment(member)) throw new Error(`${path} ${name} has unsupported object member`);
    fields[propertyName(member.name)] = zodLiteralDescriptor(member.initializer, `${path} ${name}.${propertyName(member.name)}`);
  }
  return { strict: true, fields: canonicalValue(fields) };
}
function zodEnumMembers(projectRoot, path, name) {
  const { ast } = sourceAst(projectRoot, path);
  const call = callNamed(requiredInitializer(constInitializers(ast), name, path), 'z', 'enum');
  if (!call || call.arguments.length !== 1) throw new Error(`${path} ${name} must be z.enum`);
  return mathematicalSet(stringArray(call.arguments[0], `${path} ${name}`), `${path} ${name}`);
}
function constStringArray(projectRoot, path, name) {
  const { ast } = sourceAst(projectRoot, path);
  return stringArray(requiredInitializer(constInitializers(ast), name, path), `${path} ${name}`);
}
function requireSourceFragments(projectRoot, path, fragments, edge) {
  const source = readSource(projectRoot, path);
  for (const fragment of fragments) if (!source.includes(fragment)) throw new Error(`${edge}: ${path} is missing ${JSON.stringify(fragment)}`);
}
function occurrences(source, token) { return source.split(token).length - 1; }
function sourcePathSet(paths) {
  if (new Set(paths).size !== paths.length || !sameArray(paths, asciiSorted(paths))) throw new Error('Claim sourcePaths must be duplicate-free and ASCII-sorted');
  return Object.freeze(paths);
}

const PATHS = Object.freeze({
  cardErrors: sourcePathSet(['src/application/read-models/cards-read-model.ts', 'src/cards/card-service.ts', 'src/contracts/historical-version-not-found.ts', 'src/contracts/operator-api-runtime-cards.ts', 'src/server/routes/operator-runtime-card-handlers.ts']),
  backendPivots: sourcePathSet(['src/application/read-models/cards-read-model.ts', 'src/cards/card-service.ts', 'src/contracts/operator-api-runtime-cards.ts', 'src/server/routes/operator-runtime-card-handlers.ts']),
  analystBusy: sourcePathSet(['src/contracts/operator-api-chats.ts', 'src/contracts/operator-events.ts', 'src/server/analyst-ws-handler.ts', 'src/server/routes/operator-chat-handlers.ts']),
  unexpected: sourcePathSet(['src/contracts/operator-api-core.ts', 'src/server/contract-runtime.ts']),
  unauthorized: sourcePathSet(['src/contracts/operator-api-core.ts']),
  lifecycle: sourcePathSet(['src/contracts/builtin-tool-inputs.ts', 'src/contracts/operator-api-runtime-cards.ts', 'src/schemas/lifecycle.ts', 'src/schemas/types.ts', 'src/schemas/validators.ts']),
  cardChange: sourcePathSet(['src/schemas/card-version-change.ts']),
  availability: sourcePathSet(['src/contracts/operator-api-availability.ts']),
  appLog: sourcePathSet(['src/contracts/app-log.ts', 'src/persistence/app-log.ts']),
  loggedEvents: sourcePathSet(['src/application/event-query-service.ts', 'src/contracts/app-log.ts', 'src/contracts/builtin-tool-inputs.ts', 'src/contracts/operator-api-events.ts', 'src/schemas/event-catalog.ts', 'src/server/routes/operator-events-handlers.ts', 'src/tools/analyst-runtime-tools.ts']),
  cardIdentity: sourcePathSet(['src/application/read-models/canonical-card-files-read-model.ts', 'src/cards/card-service.ts', 'src/schemas/card-id.ts']),
  sessionIdentity: sourcePathSet(['src/schemas/conversation-session-id.ts']),
  shippedTools: sourcePathSet(['src/config/system-templates/classic-typed/template.ts', 'src/config/system-templates/classic/template.ts', 'src/config/system-templates/registry.ts']),
  toolRelations: sourcePathSet(['src/config/system-templates/classic-typed/template.ts', 'src/config/system-templates/classic/template.ts', 'src/config/system-templates/registry.ts', 'src/contracts/result-envelope.ts', 'src/tools/tool-invocation-outbound.ts', 'web/src/utils/tool-presenters/presenters.ts']),
  uiDiff: sourcePathSet(['web/src/api/client.ts', 'web/src/stores/cards.ts']),
});

function errorValue(variants) { return { strict: true, variants: mathematicalSet(variants, 'error variants') }; }
function selectAnalystBusy(projectRoot) {
  const declaration = strictObjectVariant(projectRoot, PATHS.analystBusy[0], 'AnalystTurnBusyErrorSchema');
  requireSourceFragments(projectRoot, PATHS.analystBusy[0], ['ANALYST_TURN_BUSY_ERROR = Object.freeze(', 'AnalystTurnBusyErrorSchema.parse({'], 'busy frozen constant');
  const constant = strictObjectVariantFromParse(projectRoot, PATHS.analystBusy[0], 'ANALYST_TURN_BUSY_ERROR');
  if (canonicalJson(declaration.fields) !== canonicalJson(constant.fields)) throw new Error('Analyst busy constant does not match its schema literals');
  requireDirectUnionMember(projectRoot, PATHS.analystBusy[1], 'AnalystWsErrorContentSchema', 'error', 'AnalystTurnBusyErrorSchema');
  requireSourceFragments(projectRoot, PATHS.analystBusy[2], ['error instanceof AnalystTurnBusyError', '? ANALYST_TURN_BUSY_ERROR'], 'busy WebSocket producer');
  requireSourceFragments(projectRoot, PATHS.analystBusy[3], ['error instanceof AnalystTurnBusyError', 'statusCode: 409, body: ANALYST_TURN_BUSY_ERROR'], 'busy REST producer');
  return errorValue([declaration]);
}
function strictObjectVariantFromParse(projectRoot, path, name) {
  const { ast } = sourceAst(projectRoot, path);
  let node = requiredInitializer(constInitializers(ast), name, path);
  const freeze = callNamed(node, 'Object', 'freeze');
  if (!freeze || freeze.arguments.length !== 1) throw new Error(`${path} ${name} must use Object.freeze`);
  const parse = chainedCall(freeze.arguments[0], 'parse');
  if (!parse || parse.arguments.length !== 1 || !ts.isIdentifier(unwrapExpression(parse.expression.expression))) throw new Error(`${path} ${name} must parse its schema directly`);
  const shape = unwrapExpression(parse.arguments[0]);
  if (!ts.isObjectLiteralExpression(shape)) throw new Error(`${path} ${name} parse argument must be an object literal`);
  const fields = {};
  for (const member of shape.properties) {
    if (!ts.isPropertyAssignment(member)) throw new Error(`${path} ${name} has unsupported member`);
    const value = unwrapExpression(member.initializer);
    if (!ts.isStringLiteral(value) && !ts.isNumericLiteral(value)) throw new Error(`${path} ${name} value must be literal`);
    fields[propertyName(member.name)] = { kind: 'literal', value: ts.isNumericLiteral(value) ? Number(value.text) : value.text };
  }
  return { strict: true, fields: canonicalValue(fields) };
}
function requireDirectUnionMember(projectRoot, path, name, discriminator, memberName) {
  const { ast } = sourceAst(projectRoot, path);
  const call = callNamed(requiredInitializer(constInitializers(ast), name, path), 'z', 'discriminatedUnion');
  if (!call || call.arguments.length !== 2 || stringLiteralText(call.arguments[0], `${name} discriminator`) !== discriminator) throw new Error(`${path} ${name} must be z.discriminatedUnion(${JSON.stringify(discriminator)}, ...)`);
  const members = unwrapExpression(call.arguments[1]);
  if (!ts.isArrayLiteralExpression(members) || !members.elements.some((member) => ts.isIdentifier(unwrapExpression(member)) && unwrapExpression(member).text === memberName)) throw new Error(`${path} ${name} must directly contain ${memberName}`);
}
function selectCoreError(projectRoot, schema, operative) {
  const variant = strictObjectVariant(projectRoot, 'src/contracts/operator-api-core.ts', schema);
  if (operative) {
    requireSourceFragments(projectRoot, 'src/contracts/operator-api-core.ts', ['UNEXPECTED_INTERNAL_SERVER_ERROR', `${schema}.parse(`], 'internal error constant');
    requireSourceFragments(projectRoot, 'src/server/contract-runtime.ts', ['statusCode: 500, body: UNEXPECTED_INTERNAL_SERVER_ERROR'], 'ContractRuntime outer 500');
  }
  return errorValue([variant]);
}
function historicalCardVariant(projectRoot) {
  const path = 'src/contracts/historical-version-not-found.ts';
  const { ast } = sourceAst(projectRoot, path);
  const helper = ast.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === 'historicalVersionNotFoundSchema');
  if (!helper?.body) throw new Error(`${path} historicalVersionNotFoundSchema declaration is missing`);
  const returns = helper.body.statements.filter(ts.isReturnStatement);
  if (returns.length !== 1 || !returns[0].expression) throw new Error(`${path} historical helper must have one return`);
  const object = zodObject(returns[0].expression, `${path} historical helper`);
  if (!object.strict) throw new Error(`${path} historical helper must be strict`);
  const fields = {};
  for (const member of object.shape.properties) {
    if (!ts.isPropertyAssignment(member)) throw new Error(`${path} historical helper has unsupported field`);
    const key = propertyName(member.name);
    if (key === 'resource') fields[key] = { kind: 'literal-parameter', name: identifierText(callNamed(member.initializer, 'z', 'literal')?.arguments[0], 'resource literal parameter') };
    else fields[key] = zodLiteralDescriptor(member.initializer, `${path} ${key}`);
  }
  const initializer = requiredInitializer(constInitializers(ast), 'HistoricalVersionNotFoundErrorSchema', path);
  if (!ts.isCallExpression(initializer) || !ts.isIdentifier(initializer.expression) || initializer.expression.text !== 'historicalVersionNotFoundSchema' || initializer.arguments.length !== 2) throw new Error(`${path} card historical variant must call historicalVersionNotFoundSchema`);
  const resource = stringLiteralText(initializer.arguments[0], 'historical card resource');
  const ownerSchema = identifierText(initializer.arguments[1], 'historical card owner schema');
  fields.resource = { kind: 'literal', value: resource };
  fields.owner_id = { kind: 'schema', name: ownerSchema };
  return { strict: true, fields: canonicalValue(fields) };
}
function unionMembers(projectRoot, path, name) {
  const { ast } = sourceAst(projectRoot, path);
  const call = callNamed(requiredInitializer(constInitializers(ast), name, path), 'z', 'union');
  if (!call || call.arguments.length !== 1) throw new Error(`${path} ${name} must be z.union`);
  const array = unwrapExpression(call.arguments[0]);
  if (!ts.isArrayLiteralExpression(array)) throw new Error(`${path} ${name} must use a direct member array`);
  return array.elements.map((member) => identifierText(member, `${name} member`));
}
function selectCardNotFoundUnion(projectRoot, unionName, operation) {
  const contract = 'src/contracts/operator-api-runtime-cards.ts';
  const card = strictObjectVariant(projectRoot, contract, 'CardNotFoundErrorSchema');
  const historical = historicalCardVariant(projectRoot);
  const members = unionMembers(projectRoot, contract, unionName);
  if (!sameArray(members, ['CardNotFoundErrorSchema', 'HistoricalVersionNotFoundErrorSchema'])) throw new Error(`${unionName} has the wrong direct members`);
  requireSourceFragments(projectRoot, contract, [`'${operation}': {`, `404: ${unionName}`], `${operation} route 404`);
  const handlerMethod = operation === 'cards.history.get' ? 'getHistoryEntry(params.id, params.version)' : 'diffCard(params.id, query)';
  requireSourceFragments(projectRoot, 'src/server/routes/operator-runtime-card-handlers.ts', [`'${operation}':`, handlerMethod], `${operation} handler pass-through`);
  const readModel = 'src/application/read-models/cards-read-model.ts';
  const { ast: readModelAst } = sourceAst(projectRoot, readModel);
  requireNodeFragments(namedFunction(readModelAst, operation === 'cards.history.get' ? 'getHistoryEntry' : 'diffCard', readModel), readModelAst, ["body: { error: 'Card not found', cardId: id }", "body: { error: 'historical_version_not_found', resource: 'card', owner_id: id, version"], `${operation} read-model serialization`);
  const service = 'src/cards/card-service.ts';
  const { ast: serviceAst } = sourceAst(projectRoot, service);
  requireNodeFragments(namedFunction(serviceAst, operation === 'cards.history.get' ? 'readCardVersion' : 'diffCardVersions', service), serviceAst, operation === 'cards.history.get'
    ? ['readCardVersion(this.projectRoot, id, version, instrumentation)']
    : ["{ kind: 'version-not-found' as const, version, side }"], `${operation} CardService selection`);
  return errorValue([card, historical]);
}

function vocabularyValue(members) { return { members: mathematicalSet(members, 'vocabulary members') }; }
function selectLifecycle(projectRoot) {
  const members = constStringArray(projectRoot, 'src/schemas/types.ts', 'cardStatusValues');
  const lifecycleSource = readSource(projectRoot, 'src/schemas/lifecycle.ts');
  const lifecycleMembers = [...lifecycleSource.matchAll(/status:\s*z\.literal\('([^']+)'\)/g)].map((match) => match[1]);
  if (canonicalJson(mathematicalSet(members, 'cardStatusValues')) !== canonicalJson(mathematicalSet(lifecycleMembers, 'lifecycle variants'))) throw new Error('Card lifecycle variants differ from cardStatusValues');
  requireSourceFragments(projectRoot, 'src/schemas/validators.ts', ['cardStatusSchema = z.enum(cardStatusValues)'], 'lifecycle validator');
  requireSourceFragments(projectRoot, 'src/contracts/operator-api-runtime-cards.ts', ['status: cardStatusSchema', 'lifecycle: CardDetailLifecycleSchema'], 'lifecycle operator detail/hierarchy');
  const toolPath = 'src/contracts/builtin-tool-inputs.ts';
  const { ast: toolAst } = sourceAst(projectRoot, toolPath);
  const factory = requiredInitializer(constInitializers(toolAst), 'createListCardsInputSchema', toolPath);
  if (!ts.isArrowFunction(unwrapExpression(factory))) throw new Error(`${toolPath} createListCardsInputSchema must be an arrow function`);
  const inputObject = zodObject(unwrapExpression(factory).body, `${toolPath} createListCardsInputSchema`);
  const status = chainedCall(propertyAssignment(inputObject.shape, 'status', `${toolPath} createListCardsInputSchema`), 'optional');
  const union = status ? callNamed(status.expression.expression, 'z', 'union') : null;
  const alternatives = union?.arguments.length === 1 ? unwrapExpression(union.arguments[0]) : null;
  if (!alternatives || !ts.isArrayLiteralExpression(alternatives) || alternatives.elements.length !== 2) throw new Error(`${toolPath} status filter must have scalar and array alternatives`);
  const scalar = callNamed(alternatives.elements[0], 'z', 'enum');
  const array = callNamed(alternatives.elements[1], 'z', 'array');
  const nested = array?.arguments.length === 1 ? callNamed(array.arguments[0], 'z', 'enum') : null;
  if (!scalar || identifierText(scalar.arguments[0], 'scalar status vocabulary') !== 'cardStatusValues' || !nested || identifierText(nested.arguments[0], 'array status vocabulary') !== 'cardStatusValues') throw new Error(`${toolPath} status filters must consume cardStatusValues`);
  return vocabularyValue(members);
}
function selectCardChange(projectRoot) { return vocabularyValue(enumPropertyMembers(projectRoot, 'src/schemas/card-version-change.ts', 'cardVersionChangeSchema', 'kind')); }
function enumPropertyMembers(projectRoot, path, objectName, field) {
  const { ast } = sourceAst(projectRoot, path);
  const object = zodObject(requiredInitializer(constInitializers(ast), objectName, path), `${path} ${objectName}`);
  const property = object.shape.properties.find((member) => ts.isPropertyAssignment(member) && propertyName(member.name) === field);
  if (!property || !ts.isPropertyAssignment(property)) throw new Error(`${path} ${objectName}.${field} is missing`);
  const call = callNamed(property.initializer, 'z', 'enum');
  if (!call || call.arguments.length !== 1) throw new Error(`${path} ${objectName}.${field} must be z.enum`);
  return stringArray(call.arguments[0], `${path} ${objectName}.${field}`);
}
function selectAvailability(projectRoot, schema) { return vocabularyValue(zodEnumMembers(projectRoot, PATHS.availability[0], schema)); }
function selectAppLog(projectRoot) {
  const path = PATHS.appLog[0];
  const source = readSource(projectRoot, path);
  const members = [...source.matchAll(/const\s+\w+EntrySchema\s*=\s*z\.object\(\{\s*type:\s*z\.literal\('([^']+)'\)/g)].map((match) => match[1]);
  if (members.length === 0) throw new Error(`${path} has no app-log entry declarations`);
  requireDirectUnionMembers(projectRoot, path, 'appLogEntrySchema', 'type', ['eventEntrySchema', 'controlEntrySchema', 'providerEntrySchema']);
  requireSourceFragments(projectRoot, PATHS.appLog[1], ['readStrictCanonicalGrowingFile(path, appLogEntrySchema)', 'prepareGrowingEnvelope([candidate], appLogEntrySchema)', 'candidate.type !== entryType'], 'app-log persistence');
  return vocabularyValue(members);
}
function requireDirectUnionMembers(projectRoot, path, name, discriminator, expectedMembers) {
  const { ast } = sourceAst(projectRoot, path);
  const call = callNamed(requiredInitializer(constInitializers(ast), name, path), 'z', 'discriminatedUnion');
  if (!call || stringLiteralText(call.arguments[0], `${name} discriminator`) !== discriminator) throw new Error(`${path} ${name} has wrong discriminated union`);
  const array = unwrapExpression(call.arguments[1]);
  if (!ts.isArrayLiteralExpression(array)) throw new Error(`${path} ${name} must use direct array`);
  const members = array.elements.map((member) => identifierText(member, `${name} member`));
  if (!sameArray(members, expectedMembers)) throw new Error(`${path} ${name} direct members differ`);
}
function selectLoggedEvents(projectRoot) {
  const members = constStringArray(projectRoot, 'src/schemas/event-catalog.ts', 'eventKindValues');
  const source = readSource(projectRoot, 'src/schemas/event-catalog.ts');
  const variants = [...source.matchAll(/kind:\s*z\.literal\('([^']+)'\)/g)].map((match) => match[1]);
  if (canonicalJson(mathematicalSet(members, 'eventKindValues')) !== canonicalJson(mathematicalSet(variants, 'logged event variants'))) throw new Error('Logged-event schema and eventKindValues differ');
  const edges = [
    ['src/contracts/app-log.ts', ['data: loggedEventSchema']],
    ['src/contracts/builtin-tool-inputs.ts', ['kind: z.enum(eventKindValues).optional()']],
    ['src/contracts/operator-api-events.ts', ['kind: z.enum(eventKindValues).optional()', 'events: z.array(loggedEventSchema)']],
    ['src/application/event-query-service.ts', ["readAppLogEntries(this.projectRoot, 'event')", 'event.kind === query.kind']],
    ['src/server/routes/operator-events-handlers.ts', ['readModel.queryEvents(query)']],
    ['src/tools/analyst-runtime-tools.ts', ['eventKindValues', 'queryEvents({ selection:']],
  ];
  for (const [path, fragments] of edges) requireSourceFragments(projectRoot, path, fragments, 'logged-event live edge');
  return vocabularyValue(members);
}

function constantValue(projectRoot, path, name, unit, uses) {
  const value = numberInitializer(projectRoot, path, name);
  for (const [usePath, minimum] of uses) {
    const count = occurrences(readSource(projectRoot, usePath), name);
    if (count < minimum) throw new Error(`${usePath} must directly use ${name} at least ${minimum} time(s); found ${count}`);
  }
  return { unit, value };
}
function selectMaximumDepth(projectRoot) {
  const value = numberInitializer(projectRoot, 'src/schemas/card-id.ts', 'MAX_CARD_DEPTH');
  requireSourceFragments(projectRoot, 'src/schemas/card-id.ts', ['${MAX_CARD_DEPTH - 1}', '${MAX_CARD_DEPTH} alphabetic segments'], 'card-id depth grammar/messages');
  requireSourceFragments(projectRoot, 'src/cards/card-service.ts', ['depth > MAX_CARD_DEPTH', 'depth===MAX_CARD_DEPTH', '${MAX_CARD_DEPTH}.'], 'CardService depth admission');
  requireSourceFragments(projectRoot, 'src/application/read-models/canonical-card-files-read-model.ts', ['depth === MAX_CARD_DEPTH'], 'canonical Files depth stop');
  return { unit: 'segments', value };
}

function selectManagedProcessTermGrace(projectRoot) {
  const callerPaths = [
    'src/application/runtime-composition.ts',
    'src/mcp/mcp-manager.ts',
    'src/mcp/server-runtime.ts',
    'src/runtime/actors/supervisor-runtime-api.ts',
    'src/tools/process-provider.ts',
  ];
  for (const path of callerPaths) {
    if (readSource(projectRoot, path).includes('graceMs:')) throw new Error(`${path} must consume the registry TERM grace default without an override`);
  }
  requireSourceFragments(projectRoot, 'src/mcp/server-runtime.ts', ['closeAndTerminateDirectScope({'], 'MCP server default TERM grace');
  return constantValue(
    projectRoot,
    'src/runtime/managed-process-group-registry.ts',
    'MANAGED_PROCESS_TERM_GRACE_MS',
    'milliseconds',
    [['src/runtime/managed-process-group-registry.ts', 4]],
  );
}

function extractAgents(projectRoot, path, constantName) {
  const { ast } = sourceAst(projectRoot, path);
  const freeze = callNamed(requiredInitializer(constInitializers(ast), constantName, path), 'Object', 'freeze');
  if (!freeze || freeze.arguments.length !== 1) throw new Error(`${path} ${constantName} must be Object.freeze`);
  const object = unwrapExpression(freeze.arguments[0]);
  if (!ts.isObjectLiteralExpression(object)) throw new Error(`${path} ${constantName} must freeze object literal`);
  const roles = {};
  for (const member of object.properties) {
    if (!ts.isPropertyAssignment(member)) throw new Error(`${path} ${constantName} has unsupported role`);
    const role = propertyName(member.name);
    const agentFreeze = callNamed(member.initializer, 'Object', 'freeze');
    if (!agentFreeze || agentFreeze.arguments.length !== 1) throw new Error(`${path} ${constantName}.${role} must be frozen`);
    const agent = unwrapExpression(agentFreeze.arguments[0]);
    if (!ts.isObjectLiteralExpression(agent)) throw new Error(`${path} ${constantName}.${role} must be object literal`);
    const tools = agent.properties.find((property) => ts.isPropertyAssignment(property) && propertyName(property.name) === 'tools');
    if (!tools || !ts.isPropertyAssignment(tools)) throw new Error(`${path} ${constantName}.${role}.tools missing`);
    const toolsFreeze = callNamed(tools.initializer, 'Object', 'freeze');
    if (!toolsFreeze || toolsFreeze.arguments.length !== 1) throw new Error(`${path} ${constantName}.${role}.tools must be frozen`);
    const ordered = stringArray(toolsFreeze.arguments[0], `${path} ${constantName}.${role}.tools`);
    if (new Set(ordered).size !== ordered.length) throw new Error(`${path} ${constantName}.${role}.tools contains duplicates`);
    roles[role] = ordered;
  }
  return canonicalValue(roles);
}
function propertyAssignment(object, name, context) {
  const member = object.properties.find((candidate) => (ts.isPropertyAssignment(candidate) || ts.isShorthandPropertyAssignment(candidate)) && propertyName(candidate.name) === name);
  if (ts.isPropertyAssignment(member)) return member.initializer;
  if (ts.isShorthandPropertyAssignment(member)) return member.name;
  throw new Error(`${context}.${name} is missing`);
}
function directIdentifierCall(node, name, context) {
  const value = unwrapExpression(node);
  if (!ts.isCallExpression(value) || !ts.isIdentifier(value.expression) || value.expression.text !== name) throw new Error(`${context} must call ${name}`);
  return value;
}
function extractMaterializedTemplate(projectRoot, path, templateName) {
  const { ast } = sourceAst(projectRoot, path);
  const initializers = constInitializers(ast);
  const freeze = callNamed(requiredInitializer(initializers, templateName, path), 'Object', 'freeze');
  if (!freeze || freeze.arguments.length !== 1) throw new Error(`${path} ${templateName} must use Object.freeze`);
  const template = unwrapExpression(freeze.arguments[0]);
  if (!ts.isObjectLiteralExpression(template)) throw new Error(`${path} ${templateName} must freeze an object literal`);
  const name = stringLiteralText(propertyAssignment(template, 'name', `${path} ${templateName}`), `${path} ${templateName}.name`);
  const configName = identifierText(propertyAssignment(template, 'config', `${path} ${templateName}`), `${path} ${templateName}.config`);
  const configCall = directIdentifierCall(requiredInitializer(initializers, configName, path), 'deepFreeze', `${path} ${configName}`);
  if (configCall.arguments.length !== 1) throw new Error(`${path} ${configName} deepFreeze must have one argument`);
  const config = unwrapExpression(configCall.arguments[0]);
  if (!ts.isObjectLiteralExpression(config)) throw new Error(`${path} ${configName} must materialize an object literal`);
  const clone = directIdentifierCall(propertyAssignment(config, 'agents', `${path} ${configName}`), 'structuredClone', `${path} ${configName}.agents`);
  if (clone.arguments.length !== 1) throw new Error(`${path} ${configName}.agents structuredClone must have one argument`);
  const agentsName = identifierText(clone.arguments[0], `${path} ${configName}.agents source`);
  return { name, roles: extractAgents(projectRoot, path, agentsName) };
}
function registryTemplates(projectRoot) {
  const registryPath = 'src/config/system-templates/registry.ts';
  const { ast } = sourceAst(projectRoot, registryPath);
  const imports = new Map();
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings || !ts.isNamedImports(statement.importClause.namedBindings) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    for (const element of statement.importClause.namedBindings.elements) imports.set(element.name.text, statement.moduleSpecifier.text);
  }
  const freeze = callNamed(requiredInitializer(constInitializers(ast), 'SYSTEM_TEMPLATES', registryPath), 'Object', 'freeze');
  if (!freeze || freeze.arguments.length !== 1) throw new Error(`${registryPath} SYSTEM_TEMPLATES must use Object.freeze`);
  const entries = unwrapExpression(freeze.arguments[0]);
  if (!ts.isArrayLiteralExpression(entries)) throw new Error(`${registryPath} SYSTEM_TEMPLATES must freeze a direct array`);
  return entries.elements.map((element) => {
    const identifier = identifierText(element, `${registryPath} SYSTEM_TEMPLATES member`);
    const module = imports.get(identifier);
    if (!module) throw new Error(`${registryPath} ${identifier} must be a named import`);
    const absolute = resolve(dirname(join(projectRoot, registryPath)), module.replace(/\.js$/u, '.ts'));
    const path = relative(projectRoot, absolute);
    if (!PATHS.shippedTools.includes(path)) throw new Error(`${registryPath} ${identifier} resolves outside the exact shipped-template paths`);
    return extractMaterializedTemplate(projectRoot, path, identifier);
  });
}
function shippedToolInventories(projectRoot) {
  const templates = registryTemplates(projectRoot);
  if (templates.length === 0) throw new Error('SYSTEM_TEMPLATES must contain a shipped template');
  const [first, ...rest] = templates;
  for (const template of rest) if (canonicalJson(first.roles) !== canonicalJson(template.roles)) throw new Error('Shipped template role/tool inventories differ');
  const agents = Object.entries(first.roles).map(([name, tools]) => ({ name, tools }));
  return { templates: templates.map((template) => template.name), agents };
}
function objectKeys(projectRoot, path, name) {
  const { ast } = sourceAst(projectRoot, path);
  const object = unwrapExpression(requiredInitializer(constInitializers(ast), name, path));
  if (!ts.isObjectLiteralExpression(object)) throw new Error(`${path} ${name} must be object literal`);
  return object.properties.map((member) => {
    if (!ts.isPropertyAssignment(member) && !ts.isMethodDeclaration(member)) throw new Error(`${path} ${name} has unsupported member`);
    return propertyName(member.name);
  });
}
function selectToolEquality(projectRoot) {
  const inventories = Object.fromEntries(shippedToolInventories(projectRoot).agents.map((agent) => [agent.name, agent.tools]));
  const invocationPath = 'src/tools/tool-invocation-outbound.ts';
  const names = constStringArrayWithIdentifier(projectRoot, invocationPath, 'KNOWN_TOOL_INVOCATION_NAMES', 'TERMINAL_RESULT_TOOL_NAME', stringInitializer(projectRoot, 'src/contracts/result-envelope.ts', 'TERMINAL_RESULT_TOOL_NAME'));
  const presenters = objectKeys(projectRoot, 'web/src/utils/tool-presenters/presenters.ts', 'TOOL_PRESENTERS');
  const roleUnion = new Set(Object.values(inventories).flat());
  roleUnion.add(stringInitializer(projectRoot, 'src/contracts/result-envelope.ts', 'TERMINAL_RESULT_TOOL_NAME'));
  const sets = [names, presenters, [...roleUnion]].map((values) => mathematicalSet(values, 'tool equality set'));
  if (!sets.every((value) => canonicalJson(value) === canonicalJson(sets[0]))) throw new Error('Known tools, presenters, and shipped role union differ');
  const { ast } = sourceAst(projectRoot, invocationPath);
  const initializer = unwrapExpression(requiredInitializer(constInitializers(ast), 'knownToolNames', invocationPath));
  if (!ts.isNewExpression(initializer) || !ts.isIdentifier(initializer.expression) || initializer.expression.text !== 'Set' || initializer.arguments?.length !== 1 || identifierText(initializer.arguments[0], 'knownToolNames source') !== 'KNOWN_TOOL_INVOCATION_NAMES') throw new Error('knownToolNames must directly construct Set from KNOWN_TOOL_INVOCATION_NAMES');
  const gates = ast.statements.filter((statement) => ts.isFunctionDeclaration(statement) && statement.name && statement.body && descendants(statement.body, (node) => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'knownToolNames' && node.expression.name.text === 'has').length > 0).map((statement) => statement.name.text);
  if (gates.length === 0) throw new Error('No projector gate directly consumes knownToolNames');
  return { names: sets[0], sources: ['KNOWN_TOOL_INVOCATION_NAMES', 'TOOL_PRESENTERS', 'shipped-role-union-plus-terminal'], gates: mathematicalSet(gates, 'projector gates') };
}
function stringInitializer(projectRoot, path, name) {
  const { ast } = sourceAst(projectRoot, path);
  return stringLiteralText(requiredInitializer(constInitializers(ast), name, path), `${path} ${name}`);
}
function constStringArrayWithIdentifier(projectRoot, path, name, identifier, resolved) {
  const { ast } = sourceAst(projectRoot, path);
  const node = requiredInitializer(constInitializers(ast), name, path);
  if (!ts.isArrayLiteralExpression(node)) throw new Error(`${path} ${name} must be an array`);
  return node.elements.map((element) => {
    const value = unwrapExpression(element);
    if (ts.isStringLiteral(value)) return value.text;
    if (ts.isIdentifier(value) && value.text === identifier) return resolved;
    throw new Error(`${path} ${name} contains unsupported member`);
  });
}
function selectExclusiveTools(projectRoot) {
  const roles = Object.fromEntries(shippedToolInventories(projectRoot).agents.map((agent) => [agent.name, agent.tools]));
  const allOther = (role) => new Set(Object.entries(roles).filter(([name]) => name !== role).flatMap(([, tools]) => tools));
  const relative = (role) => mathematicalSet(roles[role].filter((tool) => !allOther(role).has(tool)), `${role} exclusive tools`);
  return { analystPresenterOnly: relative('analyst'), plannerOnly: relative('planner') };
}

function regexLiteral(node, context) {
  const value = unwrapExpression(node);
  if (!ts.isRegularExpressionLiteral(value)) throw new Error(`${context} must be a regex literal`);
  const match = value.text.match(/^\/(.*)\/([a-z]*)$/s);
  if (!match) throw new Error(`${context} has malformed regex literal`);
  return { source: match[1], flags: match[2], anchored: match[1].startsWith('^') && match[1].endsWith('$') };
}
function selectCardIdentity(projectRoot) {
  const path = 'src/schemas/card-id.ts';
  const { ast } = sourceAst(projectRoot, path);
  const init = constInitializers(ast);
  const segmentSchema = chainedCall(requiredInitializer(init, 'cardSegmentSchema', path), 'regex');
  if (!segmentSchema || segmentSchema.arguments.length < 1) throw new Error('cardSegmentSchema must use regex');
  const segment = regexLiteral(segmentSchema.arguments[0], 'card segment regex');
  const depth = numberInitializer(projectRoot, path, 'MAX_CARD_DEPTH');
  const pattern = requiredInitializer(init, 'nonRootCardIdPattern', path);
  if (!ts.isNewExpression(pattern) || !ts.isIdentifier(pattern.expression) || pattern.expression.text !== 'RegExp' || pattern.arguments?.length !== 2) throw new Error('nonRootCardIdPattern must use new RegExp(template, flags)');
  const template = unwrapExpression(pattern.arguments[0]);
  if (!ts.isTemplateExpression(template) || template.templateSpans.length !== 1 || !ts.isBinaryExpression(template.templateSpans[0].expression) || template.templateSpans[0].expression.operatorToken.kind !== ts.SyntaxKind.MinusToken || identifierText(template.templateSpans[0].expression.left, 'depth expression') !== 'MAX_CARD_DEPTH' || !ts.isNumericLiteral(template.templateSpans[0].expression.right)) throw new Error('nonRootCardIdPattern must derive directly from MAX_CARD_DEPTH - numeric literal');
  const reconstructed = `${template.head.text}${depth - Number(template.templateSpans[0].expression.right.text)}${template.templateSpans[0].literal.text}`;
  const union = callNamed(requiredInitializer(init, 'cardIdSchema', path), 'z', 'union');
  const alternativesNode = union?.arguments.length === 1 ? unwrapExpression(union.arguments[0]) : null;
  if (!alternativesNode || !ts.isArrayLiteralExpression(alternativesNode) || alternativesNode.elements.length !== 2) throw new Error(`${path} cardIdSchema must have two direct alternatives`);
  const rootCall = callNamed(alternativesNode.elements[0], 'z', 'literal');
  if (!rootCall || rootCall.arguments.length !== 1) throw new Error(`${path} cardIdSchema root must be a literal`);
  const root = stringLiteralText(rootCall.arguments[0], 'card root literal');
  const patternAlternative = identifierText(alternativesNode.elements[1], 'card pattern alternative');
  if (patternAlternative !== 'nonRootCardIdSchema') throw new Error(`${path} cardIdSchema pattern alternative must be nonRootCardIdSchema`);
  const syntax = reconstructed.match(/^\^([a-z]+)([^a-zA-Z0-9])\[a-z\](\+)\(\?:([^a-zA-Z0-9]+)\[a-z\]\+\)\{0,(\d+)\}\$$/u);
  if (!syntax || syntax[2] !== syntax[4] || Number(syntax[5]) + 1 !== depth) throw new Error(`${path} non-root card pattern has unsupported structure`);
  const segmentSyntax = segment.source.match(/^\^\[a-z\](\+)\$$/u);
  if (!segmentSyntax || segmentSyntax[1] !== syntax[3]) throw new Error(`${path} card segment and card-id pattern differ`);
  const minimumSegments = syntax[3] === '+' ? 1 : (() => { throw new Error(`${path} card segment quantifier is unsupported`); })();
  const stem = syntax[1];
  const separator = syntax[2];
  requireSourceFragments(projectRoot, path, [`parentId === '${root}' ? \`${stem}${separator}\${segment}\` : \`\${parentId}${separator}\${segment}\``], 'card identity constructor');
  selectMaximumDepth(projectRoot);
  return { alternatives: [{ kind: 'literal', value: root }, { kind: 'pattern', source: reconstructed }], pattern: { source: reconstructed, flags: stringLiteralText(pattern.arguments[1], 'card regex flags'), anchored: reconstructed.startsWith('^') && reconstructed.endsWith('$') }, segment, stem, separator, minimumSegments, maximumSegments: depth };
}
function descendants(node, predicate) {
  const matches = [];
  const visit = (candidate) => { if (predicate(candidate)) matches.push(candidate); ts.forEachChild(candidate, visit); };
  visit(node);
  return matches;
}
function namedFunction(ast, name, context) {
  const declaration = descendants(ast, (node) => ts.isFunctionDeclaration(node) && node.name?.text === name)[0];
  if (declaration) return declaration;
  const method = descendants(ast, (node) => ts.isMethodDeclaration(node) && propertyName(node.name) === name)[0];
  if (method) return method;
  const variable = descendants(ast, (node) => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name)[0];
  const initializer = variable?.initializer ? unwrapExpression(variable.initializer) : null;
  if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) return initializer;
  throw new Error(`${context} function ${name} is missing`);
}
function requireNodeFragments(node, ast, fragments, edge) {
  const source = node.getText(ast);
  for (const fragment of fragments) if (!source.includes(fragment)) throw new Error(`${edge} is missing ${JSON.stringify(fragment)}`);
}
function elementIndex(node, receiver, context) {
  const value = unwrapExpression(node);
  if (!ts.isElementAccessExpression(value) || !ts.isIdentifier(value.expression) || value.expression.text !== receiver || !value.argumentExpression || !ts.isNumericLiteral(unwrapExpression(value.argumentExpression))) throw new Error(`${context} must index ${receiver} with a numeric literal`);
  return Number(unwrapExpression(value.argumentExpression).text);
}
function selectSessionIdentity(projectRoot) {
  const path = PATHS.sessionIdentity[0];
  const { ast } = sourceAst(projectRoot, path);
  const pattern = regexLiteral(requiredInitializer(constInitializers(ast), 'SESSION_PATTERN', path), 'SESSION_PATTERN');
  const initializer = requiredInitializer(constInitializers(ast), 'ConversationSessionIdSchema', path);
  const custom = callNamed(initializer, 'z', 'custom');
  if (!custom || custom.arguments.length < 1 || !ts.isArrowFunction(unwrapExpression(custom.arguments[0]))) throw new Error(`${path} ConversationSessionIdSchema must use z.custom with an arrow callback`);
  const callback = unwrapExpression(custom.arguments[0]);
  const typeGuards = descendants(callback.body, (node) => ts.isBinaryExpression(node) && ts.isTypeOfExpression(unwrapExpression(node.left)) && ts.isStringLiteral(unwrapExpression(node.right)));
  if (typeGuards.length !== 1) throw new Error(`${path} session input guard must be singular`);
  const inputGuard = stringLiteralText(typeGuards[0].right, 'session input guard');
  const returns = descendants(callback.body, ts.isReturnStatement).filter((statement) => statement.expression);
  const validationReturn = returns.find((statement) => descendants(statement.expression, (node) => ts.isIdentifier(node) && node.text === 'match').length > 0);
  if (!validationReturn?.expression) throw new Error(`${path} session validation return is missing`);
  const binaries = descendants(validationReturn.expression, ts.isBinaryExpression);
  const nullNode = binaries.find((node) => node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken && ((ts.isIdentifier(unwrapExpression(node.left)) && unwrapExpression(node.left).text === 'match' && unwrapExpression(node.right).kind === ts.SyntaxKind.NullKeyword) || (ts.isIdentifier(unwrapExpression(node.right)) && unwrapExpression(node.right).text === 'match' && unwrapExpression(node.left).kind === ts.SyntaxKind.NullKeyword)));
  if (!nullNode) throw new Error(`${path} session null test is missing`);
  const safeParses = descendants(validationReturn.expression, (node) => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'safeParse');
  if (safeParses.length !== 2) throw new Error(`${path} session validation must have two safeParse calls`);
  const parsed = safeParses.map((call) => ({ parser: identifierText(call.expression.expression, 'session parser'), index: elementIndex(call.arguments[0], 'match', 'session parser argument') }));
  const equality = binaries.find((node) => node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken && ts.isStringLiteral(unwrapExpression(node.right)));
  if (!equality) throw new Error(`${path} session global alternative is missing`);
  const scopeIndex = elementIndex(equality.left, 'match', 'session global comparison');
  const globalAlternative = stringLiteralText(equality.right, 'session global alternative');
  const agent = parsed.find((candidate) => candidate.index !== scopeIndex);
  const scope = parsed.find((candidate) => candidate.index === scopeIndex);
  if (!agent || !scope) throw new Error(`${path} session parser captures are ambiguous`);
  const identity = ast.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.body && descendants(statement.body, (node) => (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && propertyName(node.name) === 'sessionId').length > 0);
  if (!identity?.name || !identity.body) throw new Error(`${path} session identity parser is missing`);
  const identityReturn = descendants(identity.body, ts.isReturnStatement).find((statement) => statement.expression && ts.isObjectLiteralExpression(unwrapExpression(statement.expression)));
  if (!identityReturn?.expression) throw new Error(`${path} session identity return is missing`);
  const identityObject = unwrapExpression(identityReturn.expression);
  const captures = identityObject.properties.filter((member) => ts.isPropertyAssignment(member)).map((member) => {
    const name = propertyName(member.name);
    const expression = member.initializer;
    const access = descendants(expression, (node) => ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'match')[0];
    if (!access) throw new Error(`${path} identity ${name} capture is missing`);
    return { index: elementIndex(access, 'match', `${name} capture`), meaning: name };
  });
  if (captures.length === 0) throw new Error(`${path} session identity captures are missing`);
  const constructors = ast.statements.filter((statement) => ts.isFunctionDeclaration(statement) && statement.name && statement.body && descendants(statement.body, (node) => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'parseConversationSessionId').length > 0).map((statement) => {
    const call = descendants(statement.body, (node) => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'parseConversationSessionId')[0];
    if (call.arguments.length !== 1 || !ts.isTemplateExpression(unwrapExpression(call.arguments[0]))) throw new Error(`${path} ${statement.name.text} must construct one template session id`);
    return { name: statement.name.text, template: unwrapExpression(call.arguments[0]).getText(ast) };
  });
  if (constructors.length === 0) throw new Error(`${path} session constructors are missing`);
  const operators = [];
  for (const binary of binaries) {
    const token = binary.operatorToken.getText(ast);
    if (!operators.includes(token)) operators.push(token);
  }
  return { inputGuard, pattern, captures, nullTest: nullNode.getText(ast), agentParser: agent.parser, scopeAlternatives: [globalAlternative, scope.parser], constructors, identityParser: identity.name.text, operators, grouping: validationReturn.expression.getText(ast) };
}

function selectBackendPivot(projectRoot, side) {
  const contract = 'src/contracts/operator-api-runtime-cards.ts';
  requireSourceFragments(projectRoot, contract, ['canonicalPositiveSafeIntegerStringSchema = z.string().regex(/^[1-9][0-9]*$/)', '.superRefine((raw, ctx)', 'positiveSafeIntegerSchema.safeParse(Number(raw)).success', '.transform(Number)', "diffPivotSchema = z.union([z.literal('current'), canonicalPositiveSafeIntegerStringSchema])", 'CardDiffQuerySchema = z.object({ from: canonicalPositiveSafeIntegerStringSchema, to: diffPivotSchema.optional() }).strict()'], 'backend diff query');
  requireSourceFragments(projectRoot, 'src/server/routes/operator-runtime-card-handlers.ts', ["'cards.diff': ({ params, query }) => getCardsReadModel().diffCard(params.id, query)"], 'backend diff handler');
  requireSourceFragments(projectRoot, 'src/application/read-models/cards-read-model.ts', ['diffCard(id: string, query:', 'fromVersion: query.from, toVersion: query.to'], 'backend diff read-model mapping');
  requireSourceFragments(projectRoot, 'src/cards/card-service.ts', ["toVersion?: number | 'current'", "typeof pivots.toVersion === 'number' ? pivots.toVersion : listed.value.at(-1)?.version ?? 0", "pivots.toVersion === undefined || pivots.toVersion === 'current'", 'readCurrentCardArtifact(this.projectRoot, id, instrumentation)'], 'backend diff service meanings');
  return side === 'from'
    ? { field: 'from', presence: 'required', variants: [{ kind: 'canonical-positive-safe-integer' }], mapping: 'fromVersion', regex: '^[1-9][0-9]*$', refinement: 'positiveSafeIntegerSchema.safeParse(Number(raw)).success', transform: 'Number' }
    : { field: 'to', presence: 'optional', variants: [{ kind: 'literal', value: 'current' }, { kind: 'canonical-positive-safe-integer' }], mapping: 'toVersion', regex: '^[1-9][0-9]*$', refinement: 'positiveSafeIntegerSchema.safeParse(Number(raw)).success', transform: 'Number', meanings: { numeric: 'historical-version', omitted: 'current-artifact', current: 'current-artifact' } };
}
function selectUiDiff(projectRoot) {
  const clientPath = 'web/src/api/client.ts';
  const storePath = 'web/src/stores/cards.ts';
  const { ast } = sourceAst(projectRoot, clientPath);
  const declaration = ast.statements.find((statement) => ts.isInterfaceDeclaration(statement) && statement.name.text === 'CurrentCardDiffKey');
  if (!declaration) throw new Error('CurrentCardDiffKey interface missing');
  const key = declaration.members.map((member) => {
    if (!ts.isPropertySignature(member) || !member.type || !member.name) throw new Error('CurrentCardDiffKey has unsupported member');
    return { name: propertyName(member.name), type: member.type.getText(ast) };
  });
  requireNodeFragments(namedFunction(ast, 'getCardDiff', clientPath), ast, ["operatorRequest('cards.diff'", 'params: { id: key.cardId }', 'from: String(key.fromSeq)', 'to: key.to', 'signal,'], 'UI card-diff request serialization');
  const { ast: storeAst } = sourceAst(projectRoot, storePath);
  requireNodeFragments(namedFunction(storeAst, 'startDiff', storePath), storeAst, [
    'diffOwner?.controller.abort()',
    'const accepted =\n      cardHistoryDiffKey.value?.cardId === key.cardId &&\n      cardHistoryDiffKey.value.fromSeq === key.fromSeq',
    'const controller = new AbortController()', 'let owner!: RequestOwner', 'const promise = getCardDiff(key, controller.signal)',
    'diffOwner !== owner', 'selectedCardId.value !== key.cardId', 'cardHistorySelectedVersion.value !== key.fromSeq',
    'if (diffOwner !== owner || aborted(error)) return', 'if (diffOwner === owner)', 'owner = markRaw({ controller, promise })', 'diffOwner = owner',
    'cardHistoryDiffKey.value = key',
  ], 'CardStore displayed-current ownership/currentness');
  requireNodeFragments(namedFunction(storeAst, 'selectCardHistoryVersion', storePath), storeAst, ["Object.freeze({ cardId, fromSeq: version, to: 'current' as const })", 'startDiff(key, null)'], 'CardStore diff selection');
  requireNodeFragments(namedFunction(storeAst, 'refreshDiff', storePath), storeAst, ['return startDiff(cardHistoryDiffKey.value, reason)'], 'CardStore diff refresh');
  requireNodeFragments(namedFunction(storeAst, 'retryDiff', storePath), storeAst, ["return refreshDiff('invalidated')"], 'CardStore diff retry');
  requireNodeFragments(namedFunction(storeAst, 'onInvalidate', storePath), storeAst, ["target.scope === 'diff' && cardHistoryVisible.value && cardHistoryDiffKey.value", "void refreshDiff('invalidated')"], 'CardStore diff invalidation');
  requireNodeFragments(namedFunction(storeAst, 'onReconnect', storePath), storeAst, ['cardHistoryVisible.value &&\n      cardHistoryDiffKey.value &&\n      cardHistoryDiffFreshness.value.staleReason !== \'refresh-failed\'', "void refreshDiff('reconnect')"], 'CardStore diff reconnect');
  return {
    key,
    selection: { construction: { cardId: 'cardId', fromSeq: 'version', to: 'current' }, frozen: true, startArgument: 'key' },
    request: { operation: 'cards.diff', params: { id: 'key.cardId' }, query: { from: 'String(key.fromSeq)', to: 'key.to' }, signal: 'forwarded' },
    currentness: { abortPreviousOwner: true, freshOwner: ['controller', 'promise'], fences: ['success:diffOwner===owner', 'rejection:diffOwner===owner', 'finalization:diffOwner===owner'], selectionGuards: ['selectedCardId===key.cardId', 'cardHistorySelectedVersion===key.fromSeq'], acceptedSideCondition: ['retained.cardId===key.cardId', 'retained.fromSeq===key.fromSeq'], retainedKey: 'original-request-key' },
    reuse: { refresh: 'startDiff(cardHistoryDiffKey, reason)', retry: 'refreshDiff(invalidated)', invalidationGates: ['scope=diff', 'visible', 'retained-key'], reconnectGates: ['visible', 'retained-key', 'freshness!=refresh-failed'] },
  };
}

function defineClaim(family, sourcePaths, select) { return Object.freeze({ family, sourcePaths, select }); }
const VALUE_CONTRACT_CLAIMS = Object.freeze({
  'constant.analyst-orientation-max-bytes': defineClaim('constants', sourcePathSet(['src/application/read-models/analyst-orientation.ts']), (root) => constantValue(root, 'src/application/read-models/analyst-orientation.ts', 'ANALYST_ORIENTATION_MAX_BYTES', 'bytes', [['src/application/read-models/analyst-orientation.ts', 4]])),
  'constant.analyst-title-preview-max-bytes': defineClaim('constants', sourcePathSet(['src/application/read-models/analyst-orientation.ts']), (root) => constantValue(root, 'src/application/read-models/analyst-orientation.ts', 'ANALYST_ORIENTATION_TITLE_PREVIEW_BYTES', 'bytes', [['src/application/read-models/analyst-orientation.ts', 2]])),
  'constant.app-cleanup-leaf-timeout-ms': defineClaim('constants', sourcePathSet(['src/boot/app.ts']), (root) => constantValue(root, 'src/boot/app.ts', 'APP_CLEANUP_LEAF_TIMEOUT_MS', 'milliseconds', [['src/boot/app.ts', 2]])),
  'constant.emit-result-summary-max-chars': defineClaim('constants', sourcePathSet(['src/runtime/card-process/card-process-config.ts']), (root) => constantValue(root, 'src/runtime/card-process/card-process-config.ts', 'EMIT_RESULT_SUMMARY_MAX_CHARS', 'characters', [['src/runtime/card-process/card-process-config.ts', 3]])),
  'constant.managed-process-post-kill-verification-ms': defineClaim('constants', sourcePathSet(['src/application/runtime-composition.ts', 'src/mcp/mcp-manager.ts', 'src/mcp/server-runtime.ts', 'src/runtime/actors/supervisor-runtime-api.ts', 'src/runtime/managed-process-group-registry.ts', 'src/tools/process-provider.ts']), (root) => constantValue(root, 'src/runtime/managed-process-group-registry.ts', 'MANAGED_PROCESS_POST_KILL_VERIFICATION_MS', 'milliseconds', [['src/runtime/managed-process-group-registry.ts', 2]])),
  'constant.managed-process-term-grace-ms': defineClaim('constants', sourcePathSet(['src/application/runtime-composition.ts', 'src/mcp/mcp-manager.ts', 'src/mcp/server-runtime.ts', 'src/runtime/actors/supervisor-runtime-api.ts', 'src/runtime/managed-process-group-registry.ts', 'src/tools/process-provider.ts']), selectManagedProcessTermGrace),
  'constant.maximum-card-depth-segments': defineClaim('constants', PATHS.cardIdentity, selectMaximumDepth),
  'constant.summarizer-completion-tokens': defineClaim('constants', sourcePathSet(['src/runtime/actors/compaction/summarizer.ts']), (root) => constantValue(root, 'src/runtime/actors/compaction/summarizer.ts', 'SUMMARY_COMPLETION_TOKENS', 'tokens', [['src/runtime/actors/compaction/summarizer.ts', 5]])),
  'constant.sync-hub-debounce-ms': defineClaim('constants', sourcePathSet(['src/server/sync-hub.ts']), (root) => constantValue(root, 'src/server/sync-hub.ts', 'SYNC_HUB_DEBOUNCE_MS', 'milliseconds', [['src/server/sync-hub.ts', 2]])),
  'constant.tool-result-envelope-max-bytes': defineClaim('constants', sourcePathSet(['src/contracts/builtin-tool-inputs.ts', 'src/tools/card-inspection-provider.ts', 'src/tools/card-version-provider.ts', 'src/tools/project-file-tools.ts', 'src/tools/response-packer.ts']), (root) => constantValue(root, 'src/contracts/builtin-tool-inputs.ts', 'DISCOVERY_RESPONSE_MAX_BYTES', 'bytes', [['src/contracts/builtin-tool-inputs.ts', 3], ['src/tools/card-inspection-provider.ts', 4], ['src/tools/card-version-provider.ts', 6], ['src/tools/project-file-tools.ts', 2], ['src/tools/response-packer.ts', 2]])),
  'error.analyst-turn-busy': defineClaim('errors', PATHS.analystBusy, selectAnalystBusy),
  'error.cards-diff-404': defineClaim('errors', PATHS.cardErrors, (root) => selectCardNotFoundUnion(root, 'CardDiffNotFoundUnionSchema', 'cards.diff')),
  'error.cards-history-404': defineClaim('errors', PATHS.cardErrors, (root) => selectCardNotFoundUnion(root, 'CardHistoryEntryNotFoundUnionSchema', 'cards.history.get')),
  'error.unauthorized': defineClaim('errors', PATHS.unauthorized, (root) => selectCoreError(root, 'UnauthorizedErrorSchema', false)),
  'error.unexpected-internal': defineClaim('errors', PATHS.unexpected, (root) => selectCoreError(root, 'UnexpectedInternalServerErrorSchema', true)),
  'identity.card': defineClaim('identities', PATHS.cardIdentity, selectCardIdentity),
  'identity.conversation-session': defineClaim('identities', PATHS.sessionIdentity, selectSessionIdentity),
  'pivot.cards-diff-from': defineClaim('pivots', PATHS.backendPivots, (root) => selectBackendPivot(root, 'from')),
  'pivot.cards-diff-to': defineClaim('pivots', PATHS.backendPivots, (root) => selectBackendPivot(root, 'to')),
  'pivot.ui-cards-diff-current-request': defineClaim('pivots', PATHS.uiDiff, selectUiDiff),
  'tools.exclusive-identities': defineClaim('tools', PATHS.toolRelations, selectExclusiveTools),
  'tools.projector-presenter-equality': defineClaim('tools', PATHS.toolRelations, selectToolEquality),
  'tools.shipped-role-inventories': defineClaim('tools', PATHS.shippedTools, shippedToolInventories),
  'vocabulary.app-log-type': defineClaim('vocabularies', PATHS.appLog, selectAppLog),
  'vocabulary.availability-component-source': defineClaim('vocabularies', PATHS.availability, (root) => selectAvailability(root, 'AvailabilityComponentSourceSchema')),
  'vocabulary.availability-state': defineClaim('vocabularies', PATHS.availability, (root) => selectAvailability(root, 'AvailabilityStateSchema')),
  'vocabulary.card-version-change-kind': defineClaim('vocabularies', PATHS.cardChange, selectCardChange),
  'vocabulary.lifecycle-status': defineClaim('vocabularies', PATHS.lifecycle, selectLifecycle),
  'vocabulary.logged-event-kind': defineClaim('vocabularies', PATHS.loggedEvents, selectLoggedEvents),
});

export const VALUE_CONTRACT_MANIFEST = Object.freeze([
  { key: 'card-identity', family: ['identities', 'constants'], file: 'docs/spec/system-specification.md', heading: '### Exact card identity contract', claims: ['identity.card', 'constant.maximum-card-depth-segments'] },
  { key: 'card-lifecycle-vocabulary', family: ['vocabularies'], file: 'docs/spec/system-specification.md', heading: '### Exact card lifecycle vocabulary', claims: ['vocabulary.lifecycle-status'] },
  { key: 'card-change-vocabulary', family: ['vocabularies'], file: 'docs/spec/system-specification.md', heading: '### Exact card history vocabulary', claims: ['vocabulary.card-version-change-kind'] },
  { key: 'session-identity', family: ['identities'], file: 'docs/spec/system-specification.md', heading: '### Exact conversation-session identity contract', claims: ['identity.conversation-session'] },
  { key: 'emit-result-limit', family: ['constants'], file: 'docs/spec/system-specification.md', heading: '### Exact terminal-result limit', claims: ['constant.emit-result-summary-max-chars'] },
  { key: 'cleanup-limits', family: ['constants'], file: 'docs/spec/system-specification.md', heading: '### Exact cleanup timing contract', claims: ['constant.app-cleanup-leaf-timeout-ms', 'constant.managed-process-term-grace-ms', 'constant.managed-process-post-kill-verification-ms'] },
  { key: 'availability-contract', family: ['vocabularies'], file: 'docs/spec/system-specification.md', heading: '### Exact availability vocabulary', claims: ['vocabulary.availability-state', 'vocabulary.availability-component-source'] },
  { key: 'app-log-contract', family: ['vocabularies'], file: 'docs/spec/system-specification.md', heading: '### Exact app-log vocabularies', claims: ['vocabulary.app-log-type', 'vocabulary.logged-event-kind'] },
  { key: 'context-limits', family: ['constants'], file: 'docs/spec/system-specification.md', heading: '### Exact context and compaction limits', claims: ['constant.analyst-orientation-max-bytes', 'constant.analyst-title-preview-max-bytes', 'constant.tool-result-envelope-max-bytes', 'constant.summarizer-completion-tokens'] },
  { key: 'tool-identities', family: ['tools'], file: 'docs/architecture/system-architecture.md', heading: '### Exact shipped tool identities', claims: ['tools.shipped-role-inventories', 'tools.projector-presenter-equality', 'tools.exclusive-identities'] },
  { key: 'operator-error-contracts', family: ['errors'], file: 'docs/spec/system-specification.md', heading: '### Exact shared operator error contracts', claims: ['error.analyst-turn-busy', 'error.unauthorized', 'error.unexpected-internal'] },
  { key: 'backend-card-history-diff', family: ['errors', 'pivots'], file: 'docs/spec/system-specification.md', heading: '### Exact backend card history and diff contract', claims: ['error.cards-history-404', 'error.cards-diff-404', 'pivot.cards-diff-from', 'pivot.cards-diff-to'] },
  { key: 'sync-debounce', family: ['constants'], file: 'docs/architecture/system-architecture.md', heading: '### Exact SyncHub debounce policy', claims: ['constant.sync-hub-debounce-ms'] },
  { key: 'displayed-current-diff', family: ['pivots'], file: 'docs/spec/operator-ui.md', heading: '### Exact displayed-current-diff request contract', claims: ['pivot.ui-cards-diff-current-request'] },
]);

const VALUE_CONTRACT_FAMILIES = ['errors', 'vocabularies', 'constants', 'tools', 'identities', 'pivots'];
function headingInterval(content, heading, file) {
  const matches = [...content.matchAll(/^#{1,6}\s+.*$/gm)].filter((match) => match[0] === heading);
  if (matches.length !== 1) throw new Error(`${file} must contain heading ${JSON.stringify(heading)} exactly once; found ${matches.length}`);
  const level = heading.indexOf(' ');
  const start = matches[0].index + matches[0][0].length;
  const later = [...content.slice(start).matchAll(/^#{1,6}\s+.*$/gm)].find((match) => match[0].indexOf(' ') <= level);
  return { start, end: later ? start + later.index : content.length };
}
function verifyValueContractBlock(content, entry, selected, family) {
  const startMarker = `<!-- saivage:value-contract:${entry.key}:start -->`;
  const endMarker = `<!-- saivage:value-contract:${entry.key}:end -->`;
  if (occurrences(content, startMarker) !== 1 || occurrences(content, endMarker) !== 1) throw new Error(`${entry.file} must contain the ${entry.key} markers exactly once`);
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker, start + startMarker.length);
  const actual = content.slice(start, end + endMarker.length);
  const lines = actual.split('\n');
  if (lines.length !== entry.claims.length + 4 || lines[0] !== startMarker || lines[1] !== '```text' || lines.at(-2) !== '```' || lines.at(-1) !== endMarker) throw new Error(`${entry.file} ${entry.key} has invalid exact marker/fence bytes`);
  entry.claims.forEach((claimKey, index) => {
    const prefix = `${claimKey} = `;
    const line = lines[index + 2];
    if (!line.startsWith(prefix)) throw new Error(`${entry.file} ${entry.key} row ${index + 1} must be ${claimKey}`);
    let documented;
    try { documented = JSON.parse(line.slice(prefix.length)); } catch { throw new Error(`${entry.file} ${entry.key} ${claimKey} has invalid JSON`); }
    if (VALUE_CONTRACT_CLAIMS[claimKey].family === family) {
      const expected = serializeValueContractClaim(claimKey, selected.get(claimKey));
      if (line !== `${prefix}${expected}`) throw new Error(`${entry.file} ${entry.key} ${claimKey} differs from source`);
    } else if (serializeValueContractClaim(claimKey, documented) !== line.slice(prefix.length)) throw new Error(`${entry.file} ${entry.key} ${claimKey} is not canonical JSON`);
  });
  return actual;
}
function verifyCatalogAndManifest() {
  const claimKeys = Object.keys(VALUE_CONTRACT_CLAIMS);
  if (!sameArray(claimKeys, asciiSorted(claimKeys))) throw new Error('VALUE_CONTRACT_CLAIMS keys must be ASCII-sorted');
  for (const [key, claim] of Object.entries(VALUE_CONTRACT_CLAIMS)) {
    exactKeys(claim, ['family', 'sourcePaths', 'select'], `claim ${key}`);
    if (!VALUE_CONTRACT_FAMILIES.includes(claim.family)) throw new Error(`claim ${key} has unknown family ${claim.family}`);
    if (typeof claim.select !== 'function') throw new Error(`claim ${key} select must be a function`);
    sourcePathSet([...claim.sourcePaths]);
  }
  const blockKeys = VALUE_CONTRACT_MANIFEST.map((entry) => entry.key);
  if (VALUE_CONTRACT_MANIFEST.length !== 14) throw new Error('VALUE_CONTRACT_MANIFEST must contain exactly 14 blocks');
  if (new Set(blockKeys).size !== blockKeys.length) throw new Error('VALUE_CONTRACT_MANIFEST block keys must be unique');
  const uses = [];
  for (const entry of VALUE_CONTRACT_MANIFEST) {
    exactKeys(entry, ['key', 'family', 'file', 'heading', 'claims'], `manifest ${entry.key}`);
    if (new Set(entry.family).size !== entry.family.length || entry.family.some((family) => !VALUE_CONTRACT_FAMILIES.includes(family))) throw new Error(`manifest ${entry.key} has invalid families`);
    if (new Set(entry.claims).size !== entry.claims.length) throw new Error(`manifest ${entry.key} repeats a claim`);
    for (const claimKey of entry.claims) {
      const claim = VALUE_CONTRACT_CLAIMS[claimKey];
      if (!claim) throw new Error(`manifest ${entry.key} references unknown claim ${claimKey}`);
      if (!entry.family.includes(claim.family)) throw new Error(`manifest ${entry.key} omits family ${claim.family}`);
      uses.push(claimKey);
    }
  }
  if (!sameArray(asciiSorted(uses), claimKeys)) throw new Error('Manifest must use every claim exactly once');
}
function selectClaims(projectRoot, family) {
  const selected = new Map();
  const failures = [];
  const claims = Object.entries(VALUE_CONTRACT_CLAIMS).filter(([, claim]) => claim.family === family);
  for (const [key, claim] of claims) {
    try { selected.set(key, normalizeClaimValue(key, claim.select(projectRoot))); }
    catch (error) { failures.push({ type: 'value-contract-source', claim: key, message: `${key}: ${error instanceof Error ? error.message : String(error)}` }); }
  }
  return { selected, failures, claims };
}
function verifyFamily(family, options = {}) {
  const projectRoot = options.projectRoot ?? process.cwd();
  const failures = [];
  try { verifyCatalogAndManifest(); } catch (error) { failures.push({ type: 'value-contract-catalog', message: error instanceof Error ? error.message : String(error) }); }
  const selection = selectClaims(projectRoot, family);
  failures.push(...selection.failures);
  const relevantBlocks = VALUE_CONTRACT_MANIFEST.filter((entry) => entry.family.includes(family));
  if (selection.failures.length === 0) {
    for (const entry of relevantBlocks) {
      try {
        const content = readSource(projectRoot, entry.file).replace(/\r\n/g, '\n');
        const expected = verifyValueContractBlock(content, entry, selection.selected, family);
        const interval = headingInterval(content, entry.heading, entry.file);
        const blockIndex = content.indexOf(expected);
        if (blockIndex < interval.start || blockIndex + expected.length > interval.end) throw new Error(`${entry.key} is outside ${entry.heading}`);
      } catch (error) { failures.push({ type: 'value-contract-block', block: entry.key, message: error instanceof Error ? error.message : String(error) }); }
    }
    try {
      const known = new Set(VALUE_CONTRACT_MANIFEST.flatMap((entry) => [`<!-- saivage:value-contract:${entry.key}:start -->`, `<!-- saivage:value-contract:${entry.key}:end -->`]));
      for (const file of VALUE_CONTRACT_DOCS) {
        const content = readSource(projectRoot, file);
        for (const line of content.split(/\r?\n/u)) if (line.includes('<!-- saivage:value-contract:') && !known.has(line)) throw new Error(`${file} contains unknown or malformed value-contract marker ${line}`);
      }
    } catch (error) { failures.push({ type: 'value-contract-marker', message: error instanceof Error ? error.message : String(error) }); }
  }
  const selectedSourcePaths = asciiSorted(new Set(selection.claims.flatMap(([, claim]) => claim.sourcePaths)));
  return {
    ok: failures.length === 0,
    failures,
    checkedClaimKeys: asciiSorted(new Set(selection.claims.map(([key]) => key))),
    checkedBlockKeys: asciiSorted(new Set(relevantBlocks.map((entry) => entry.key))),
    selectedSourcePaths,
  };
}
export function verifyErrorShapeDocs(options = {}) { return verifyFamily('errors', options); }
export function verifyClosedVocabularyDocs(options = {}) { return verifyFamily('vocabularies', options); }
export function verifySourceConstantDocs(options = {}) { return verifyFamily('constants', options); }
export function verifyToolContractDocs(options = {}) { return verifyFamily('tools', options); }
export function verifyIdentityGrammarDocs(options = {}) { return verifyFamily('identities', options); }
export function verifyCardDiffPivotDocs(options = {}) { return verifyFamily('pivots', options); }

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
    if (isInternalDebugRoute(row.key)) failures.push({ type: 'internal-debug-in-operator-inventory', route: row.key, message: `${OPERATION_DOC} must document ${row.key} in the internal debug inventory, not the operator route inventory` });
  }
  const internalDebugCounts = new Map();
  for (const row of internalDebugRows) {
    internalDebugCounts.set(row.key, (internalDebugCounts.get(row.key) ?? 0) + 1);
    verifyAnchor(projectRoot, row.anchor, failures, `internal debug route ${row.key}`);
  }
  for (const route of implementedRoutes) {
    const count = isInternalDebugRoute(route) ? (internalDebugCounts.get(route) ?? 0) : (inventoryCounts.get(route) ?? 0);
    if (count !== 1) {
      const block = isInternalDebugRoute(route) ? 'internal debug inventory' : 'operator route inventory';
      failures.push({ type: 'route-inventory-count', route, message: `${OPERATION_DOC} must document implemented route ${route} exactly once in the ${block}; found ${count}` });
    }
  }
  for (const [route, count] of inventoryCounts) {
    if (!implementedRoutes.has(route)) failures.push({ type: 'route-inventory-missing', route, message: `${OPERATION_DOC} route inventory lists ${route}, but no matching Fastify or contract route was found` });
    if (count > 1) failures.push({ type: 'route-inventory-count', route, message: `${OPERATION_DOC} route inventory lists ${route} ${count} times` });
  }
  for (const [route, count] of internalDebugCounts) {
    if (!isInternalDebugRoute(route)) failures.push({ type: 'unexpected-internal-debug-route', route, message: `${OPERATION_DOC} internal debug inventory lists unclassified route ${route}` });
    if (!implementedRoutes.has(route)) failures.push({ type: 'route-inventory-missing', route, message: `${OPERATION_DOC} internal debug inventory lists ${route}, but no matching Fastify route was found` });
    if (count > 1) failures.push({ type: 'route-inventory-count', route, message: `${OPERATION_DOC} internal debug inventory lists ${route} ${count} times` });
  }

  return { ok: failures.length === 0, failures, documentedRoutes, implementedRoutes, checkedDocs: docPaths, routeInventoryRows: inventoryRows, internalDebugRows };
}

export function verifyAgentToolDocs(options = {}) {
  const projectRoot = options.projectRoot ?? process.cwd();
  const expected = options.expectedTools ?? extractImplementedAgentTools(projectRoot);
  const parsed = options.documentedTools
    ? { rows: Array.from(options.documentedTools, ([key, row]) => ({ key, ...row })), failures: [] }
    : parseAgentToolTable(projectRoot);
  const failures = [...parsed.failures];
  const counts = new Map();
  for (const row of parsed.rows) counts.set(row.key, (counts.get(row.key) ?? 0) + 1);
  for (const row of parsed.rows) {
    if (!expected.has(row.key)) failures.push({ type: 'unexpected-agent', agent: row.key, file: row.file, line: row.line, message: `${row.file ?? AGENTS_DOC}:${row.line ?? '?'} has unexpected named agent ${row.key}` });
  }
  for (const [agent] of expected) {
    const count = counts.get(agent) ?? 0;
    if (count !== 1) failures.push({ type: count === 0 ? 'missing-agent' : 'duplicate-agent', agent, message: `${AGENTS_DOC} must document named agent ${agent} exactly once; found ${count}` });
  }
  const identityValid = failures.every((failure) => !['malformed-agent-tool-row', 'unexpected-agent', 'missing-agent', 'duplicate-agent'].includes(failure.type));
  const documented = new Map();
  if (identityValid) for (const row of parsed.rows) documented.set(row.key, row);
  if (!identityValid) return { ok: false, failures, expected, documented };
  for (const [agent, tools] of expected) {
    const row = documented.get(agent);
    verifyAnchor(projectRoot, row.anchor, failures, `agent tool row ${agent}`);
    if (!sameArray(row.tools, tools)) failures.push({ type: 'agent-tool-parity', agent, message: `${AGENTS_DOC} tools for ${agent} do not match the default named-agent catalog (doc=${row.tools.join(',')} source=${tools.join(',')})` });
  }
  return { ok: failures.length === 0, failures, expected, documented };
}

export function verifyConfigDocs(options = {}) {
  const projectRoot = options.projectRoot ?? process.cwd();
  const expected = options.expectedConfig ?? extractConfigSchema(projectRoot);
  const docPaths = options.configDocPaths ?? CONFIG_DOCS;
  const documentedByPath = new Map();
  const failures = [];

  for (const docPath of docPaths) {
    const parsed = options.documentedConfig
      ? { rows: Array.from(options.documentedConfig, ([key, row]) => ({ key, ...row })), failures: [] }
      : parseConfigTable(projectRoot, docPath);
    failures.push(...parsed.failures);
    const counts = new Map();
    for (const row of parsed.rows) counts.set(row.key, (counts.get(row.key) ?? 0) + 1);
    for (const row of parsed.rows) {
      if (!expected.has(row.key)) failures.push({ type: 'unexpected-config-section', section: row.key, file: row.file, line: row.line, message: `${row.file ?? docPath}:${row.line ?? '?'} has unexpected config schema row ${row.key}` });
    }
    for (const [section] of expected) {
      const count = counts.get(section) ?? 0;
      if (count !== 1) failures.push({ type: count === 0 ? 'missing-config-section' : 'duplicate-config-section', section, message: `${docPath} must document config schema path ${section} exactly once; found ${count}` });
    }
    const identityTypes = new Set(['malformed-config-row', 'unexpected-config-section', 'missing-config-section', 'duplicate-config-section']);
    const identityValid = failures.every((failure) => !identityTypes.has(failure.type));
    const documented = new Map();
    if (identityValid) for (const row of parsed.rows) documented.set(row.key, row);
    documentedByPath.set(docPath, documented);
    if (!identityValid) continue;
    for (const [section, fields] of expected) {
      const row = documented.get(section);
      verifyAnchor(projectRoot, row.anchor, failures, `config schema ${docPath} ${section}`);
      if (!sameArray(row.fields, fields)) failures.push({ type: 'config-schema-parity', section, message: `${docPath} fields for ${section} do not match src/schemas/saivage-config.ts (doc=${row.fields.join(',')} source=${fields.join(',')})` });
    }
  }

  return { ok: failures.length === 0, failures, expected, documented: documentedByPath, checkedDocs: docPaths };
}

export function verifyDocSourceContracts(options = {}) {
  const projectRoot = options.projectRoot ?? process.cwd();
  const routeResult = verifyDocRoutes({ ...options, projectRoot });
  const toolResult = verifyAgentToolDocs({ projectRoot });
  const configResult = verifyConfigDocs({ projectRoot });
  const errorShapeResult = verifyErrorShapeDocs({ projectRoot });
  const closedVocabularyResult = verifyClosedVocabularyDocs({ projectRoot });
  const sourceConstantResult = verifySourceConstantDocs({ projectRoot });
  const toolContractResult = verifyToolContractDocs({ projectRoot });
  const identityGrammarResult = verifyIdentityGrammarDocs({ projectRoot });
  const cardDiffPivotResult = verifyCardDiffPivotDocs({ projectRoot });
  const failures = [
    ...routeResult.failures,
    ...toolResult.failures,
    ...configResult.failures,
    ...errorShapeResult.failures,
    ...closedVocabularyResult.failures,
    ...sourceConstantResult.failures,
    ...toolContractResult.failures,
    ...identityGrammarResult.failures,
    ...cardDiffPivotResult.failures,
  ];
  return { ok: failures.length === 0, failures, routeResult, toolResult, configResult, errorShapeResult, closedVocabularyResult, sourceConstantResult, toolContractResult, identityGrammarResult, cardDiffPivotResult };
}

function sourceFilesForReport(projectRoot) {
  return [...STATIC_SOURCE_FILES, ...discoverOperatorContractRouteSources(projectRoot)].sort();
}

export function formatVerificationResult(result, projectRoot = process.cwd()) {
  const lines = [];
  lines.push('==> Verifying active docs against source contracts...');
  lines.push(`  Checked ${result.routeResult.checkedDocs.length} active doc(s), ${result.routeResult.implementedRoutes.size} implemented route(s), ${result.routeResult.routeInventoryRows.length} operator inventory row(s), and ${result.routeResult.internalDebugRows.length} internal debug row(s).`);
  lines.push(`  Checked agent tool parity, configuration schema fields in ${result.configResult.checkedDocs.length} config doc(s), and code anchors.`);
  const families = [
    ['errors', result.errorShapeResult],
    ['vocabularies', result.closedVocabularyResult],
    ['constants', result.sourceConstantResult],
    ['tools', result.toolContractResult],
    ['identities', result.identityGrammarResult],
    ['card-diff pivots', result.cardDiffPivotResult],
  ];
  for (const [name, family] of families) lines.push(`  Checked ${family.checkedClaimKeys.length} ${name} claim(s) in ${family.checkedBlockKeys.length} block(s) across ${family.selectedSourcePaths.length} selected source file(s).`);
  if (result.ok) lines.push('  ✓ current docs match routes, tools, config schema, anchors, errors, vocabularies, constants, shipped-tool contracts, identities, and card-diff pivots');
  else {
    lines.push('  ✗ documentation/source drift detected:');
    for (const failure of result.failures) lines.push(`    - ${failure.message}`);
  }
  const familyPaths = families.flatMap(([, family]) => family.selectedSourcePaths);
  lines.push(`  Source files: ${asciiSorted(new Set([...sourceFilesForReport(projectRoot), ...familyPaths])).map((p) => relative(projectRoot, join(projectRoot, p))).join(', ')}`);
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
