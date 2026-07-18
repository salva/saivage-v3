#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROUTE_METHOD_RE = /fastify\.(get|post|patch|delete|put)\(\s*(['"`])([^'"`]+)\2/g;
const DOC_ROUTE_RE = /\b(GET|POST|PATCH|DELETE|PUT)\s+(?:https?:\/\/[^\s`)'"<>]+)?(\/(?:api\/[A-Za-z0-9_./:{}-]+|health)\b[^\s`)'"<>]*)/g;
const INVENTORY_ROW_RE = /^\|\s*`([^`]+)`\s*\|\s*current\s*\|/;
const CODE_LINE_ANCHOR_PATTERN = String.raw`[^\s:|]+:\d+(?:\s+"(?:\\.|[^"\\])*")?`;
const ROUTE_TABLE_ROW_RE = new RegExp('^\\|\\s*`(GET|POST|PATCH|DELETE|PUT)\\s+([^`]+)`\\s*\\|\\s*([^|]+?)\\s*\\|\\s*`(' + CODE_LINE_ANCHOR_PATTERN + ')`\\s*\\|');
const ROLE_TOOL_ROW_RE = /^\|\s*`([^`]+)`\s*\|\s*`([^`]*)`\s*\|\s*`([^`]+:\d+)`\s*\|\s*$/;
const CONFIG_ROW_RE = /^\|\s*`([^`]+)`\s*\|\s*`([^`]*)`\s*\|\s*`([^`]+:\d+)`\s*\|\s*$/;

const DEFAULT_REMOVED_ROUTES = new Set(['POST /api/runtime/dispatch']);
const DEFAULT_OPERATOR_DOCS = new Set(['README.md', 'docs/spec/system-specification.md', 'docs/spec/operator-ui.md', 'docs/architecture/system-architecture.md']);
const STATIC_SOURCE_FILES = ['src/server/server.ts', 'src/server/composition/fastify-app.ts', 'src/server/composition/route-composition.ts', 'src/server/routes', 'src/server/routes/operator-contracts.ts', 'src/server/contract-runtime.ts', 'src/agents/config-schema.ts'];
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

function parseRoleToolTable(projectRoot, docPath = AGENTS_DOC) {
  const fullPath = join(projectRoot, docPath);
  const rows = [];
  const failures = [];
  if (!existsSync(fullPath)) return { rows, failures };
  const content = readFileSync(fullPath, 'utf-8');
  for (const { text, line } of markedBlockLines(content, 'agent-tools')) {
    const match = text.match(ROLE_TOOL_ROW_RE);
    if (match) {
      rows.push({ key: match[1], tools: match[2].split(',').map((tool) => tool.trim()).filter(Boolean).sort(), anchor: match[3], file: docPath, line });
      continue;
    }
    if (text.trim().startsWith('|') && !isMarkdownTableScaffolding(text, 'Role')) failures.push({ type: 'malformed-agent-tool-row', file: docPath, line, message: `${docPath}:${line} has a malformed Agent tools data row` });
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
  return { content, ast: ts.createSourceFile(relPath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS) };
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

const PROVIDER_SOURCE_NAVIGATION = new Map([
  ['createPlannerControlProvider', 'src/tools/planner-control-provider.ts'],
  ['createAnalystControlProvider', 'src/tools/analyst-control-provider.ts'],
  ['createCardInspectionProvider', 'src/tools/card-inspection-provider.ts'],
  ['createWorkspaceProvider', 'src/tools/workspace-provider.ts'],
  ['createAnalystWorkspaceProvider', 'src/tools/workspace-provider.ts'],
  ['createPatchProvider', 'src/tools/workspace-provider.ts'],
  ['createAnalystPatchProvider', 'src/tools/workspace-provider.ts'],
  ['createProcessProvider', 'src/tools/process-provider.ts'],
  ['createCardHistoryProvider', 'src/tools/card-history-provider.ts'],
  ['createWebProvider', 'src/tools/web-tools.ts'],
  ['createSkillProvider', 'src/tools/skill-provider.ts'],
  ['createMcpProvider', 'src/tools/mcp-provider.ts'],
]);

function evaluateRoleCondition(node, role) {
  const condition = unwrapExpression(node);
  if (!ts.isBinaryExpression(condition) || (condition.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken && condition.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsToken)) throw new Error('Unsupported role-dependent provider condition');
  const left = unwrapExpression(condition.left);
  const right = unwrapExpression(condition.right);
  if (ts.isIdentifier(left) && left.text === 'role' && ts.isStringLiteral(right)) return role === right.text;
  if (ts.isIdentifier(right) && right.text === 'role' && ts.isStringLiteral(left)) return role === left.text;
  throw new Error('Unresolved role-dependent provider condition');
}

function selectedConstructorCall(node, role) {
  const value = unwrapExpression(node);
  if (ts.isConditionalExpression(value)) return selectedConstructorCall(evaluateRoleCondition(value.condition, role) ? value.whenTrue : value.whenFalse, role);
  if (ts.isCallExpression(value) && ts.isIdentifier(value.expression)) return value.expression.text;
  throw new Error(`Unresolved provider constructor branch for ${role}`);
}

function arrowResult(node) {
  const value = unwrapExpression(node);
  if (!ts.isArrowFunction(value)) throw new Error('Provider constructor must be an arrow function');
  if (!ts.isBlock(value.body)) return value.body;
  const returns = value.body.statements.filter(ts.isReturnStatement);
  if (returns.length !== 1 || !returns[0].expression) throw new Error('Provider constructor block must have one explicit return');
  return returns[0].expression;
}

function findFunction(ast, name) {
  const found = ast.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  if (!found || !ts.isFunctionDeclaration(found) || !found.body) throw new Error(`Unable to resolve provider function ${name} in ${ast.fileName}`);
  return found;
}

function directReturnObjects(fn) {
  return fn.body.statements.filter(ts.isReturnStatement).map((statement) => statement.expression && unwrapExpression(statement.expression)).filter(Boolean).filter(ts.isObjectLiteralExpression);
}

function toolNamesFromProvider(projectRoot, functionName, relPath) {
  const { ast } = sourceAst(projectRoot, relPath);
  if (functionName === 'createAnalystControlProvider') {
    const fn = findFunction(ast, functionName);
    if (!fn.getText(ast).includes('ANALYST_CONTROL_TOOLS')) throw new Error('Analyst control provider no longer consumes ANALYST_CONTROL_TOOLS');
    const registry = sourceAst(projectRoot, 'src/tools/analyst-tool-registry.ts');
    const initializers = constInitializers(registry.ast);
    const control = requiredInitializer(initializers, 'ANALYST_CONTROL_TOOLS', registry.ast.fileName);
    if (!ts.isCallExpression(control) || !ts.isPropertyAccessExpression(control.expression) || control.expression.name.text !== 'map' || !ts.isIdentifier(control.expression.expression)) throw new Error('Unable to resolve live ANALYST_CONTROL_TOOLS input');
    return stringArray(requiredInitializer(initializers, control.expression.expression.text, registry.ast.fileName), 'Analyst control order');
  }
  const objects = directReturnObjects(findFunction(ast, functionName));
  if (objects.length !== 1) throw new Error(`${functionName} must return one direct provider object`);
  const toolsProperty = objects[0].properties.find((property) => ts.isPropertyAssignment(property) && propertyName(property.name) === 'tools');
  if (!toolsProperty || !ts.isPropertyAssignment(toolsProperty)) throw new Error(`${functionName} has no statically discoverable tools property`);
  const tools = unwrapExpression(toolsProperty.initializer);
  if (!ts.isArrayLiteralExpression(tools)) throw new Error(`${functionName} tools must be an array literal`);
  return tools.elements.map((element) => {
    const call = unwrapExpression(element);
    if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== 'defineTool' || call.arguments.length !== 1) throw new Error(`${functionName} contains an unsupported tool definition`);
    const definition = unwrapExpression(call.arguments[0]);
    if (!ts.isObjectLiteralExpression(definition)) throw new Error(`${functionName} contains a non-object tool definition`);
    const nameProperty = definition.properties.find((property) => ts.isPropertyAssignment(property) && propertyName(property.name) === 'name');
    if (!nameProperty || !ts.isPropertyAssignment(nameProperty)) throw new Error(`${functionName} contains a tool without a name`);
    const name = unwrapExpression(nameProperty.initializer);
    if (!ts.isStringLiteral(name)) throw new Error(`${functionName} contains a non-literal tool name`);
    return name.text;
  });
}

function terminalToolName(projectRoot, role) {
  const nodeExecution = sourceAst(projectRoot, 'src/runtime/actors/agent-node-execution.ts');
  if (!nodeExecution.content.includes('name: TERMINAL_RESULT_TOOL_NAME')) throw new Error(`configured ${role} node contract does not compose TERMINAL_RESULT_TOOL_NAME`);
  const result = sourceAst(projectRoot, 'src/contracts/result-envelope.ts');
  const initializer = requiredInitializer(constInitializers(result.ast), 'TERMINAL_RESULT_TOOL_NAME', result.ast.fileName);
  if (!ts.isStringLiteral(initializer)) throw new Error('TERMINAL_RESULT_TOOL_NAME must be a string literal');
  return initializer.text;
}

function extractImplementedAgentTools(projectRoot) {
  const source = sourceAst(projectRoot, 'src/tools/role-invocation-surfaces.ts');
  const initializers = constInitializers(source.ast);
  const roleOrder = requiredInitializer(initializers, 'ROLE_PROVIDER_ORDER', source.ast.fileName);
  const constructors = requiredInitializer(initializers, 'PROVIDER_CONSTRUCTORS', source.ast.fileName);
  if (!ts.isObjectLiteralExpression(roleOrder) || !ts.isObjectLiteralExpression(constructors)) throw new Error('Role provider composition must use object literals');
  const constructorByName = new Map(constructors.properties.map((property) => {
    if (!ts.isPropertyAssignment(property)) throw new Error('Unsupported provider constructor declaration');
    return [propertyName(property.name), property.initializer];
  }));
  const usedFunctions = new Set();
  const usedProviders = new Set();
  const result = new Map();
  for (const property of roleOrder.properties) {
    if (!ts.isPropertyAssignment(property)) throw new Error('Unsupported role provider declaration');
    const role = propertyName(property.name);
    const providers = stringArray(property.initializer, `${role} provider order`);
    const names = [];
    for (const provider of providers) {
      const constructor = constructorByName.get(provider);
      if (!constructor) throw new Error(`Unknown provider ${provider} for ${role}`);
      usedProviders.add(provider);
      const functionName = selectedConstructorCall(arrowResult(constructor), role);
      const relPath = PROVIDER_SOURCE_NAVIGATION.get(functionName);
      if (!relPath) throw new Error(`Missing provider source navigation for ${functionName}`);
      usedFunctions.add(functionName);
      names.push(...toolNamesFromProvider(projectRoot, functionName, relPath));
    }
    if (role === 'planner' || role === 'executor' || role === 'reviewer') names.push(terminalToolName(projectRoot, role));
    const unique = uniqueSorted(names);
    if (unique.length !== names.length) throw new Error(`Duplicate resulting tool name for ${role}`);
    result.set(role, unique);
  }
  for (const provider of constructorByName.keys()) if (!usedProviders.has(provider)) throw new Error(`Unreferenced provider constructor ${provider}`);
  for (const functionName of PROVIDER_SOURCE_NAVIGATION.keys()) if (!usedFunctions.has(functionName)) throw new Error(`Unreferenced provider source navigation for ${functionName}`);
  return result;
}

const SCHEMA_WRAPPERS = new Set(['optional', 'default', 'strict', 'passthrough', 'superRefine', 'transform']);
const SCALAR_CHAINS = new Set(['min', 'max', 'int', 'positive', 'nonnegative', 'safe', 'refine']);
const SCALAR_FACTORIES = new Set(['string', 'number', 'boolean', 'enum', 'unknown', 'literal', 'any']);

function extractConfigSchema(projectRoot) {
  const relPath = 'src/agents/config-schema.ts';
  const { ast } = sourceAst(projectRoot, relPath);
  const initializers = constInitializers(ast);
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
    : parseRoleToolTable(projectRoot);
  const failures = [...parsed.failures];
  const counts = new Map();
  for (const row of parsed.rows) counts.set(row.key, (counts.get(row.key) ?? 0) + 1);
  for (const row of parsed.rows) {
    if (!expected.has(row.key)) failures.push({ type: 'unexpected-agent-role', role: row.key, file: row.file, line: row.line, message: `${row.file ?? AGENTS_DOC}:${row.line ?? '?'} has unexpected agent-tool role ${row.key}` });
  }
  for (const [role] of expected) {
    const count = counts.get(role) ?? 0;
    if (count !== 1) failures.push({ type: count === 0 ? 'missing-agent-role' : 'duplicate-agent-role', role, message: `${AGENTS_DOC} must document agent-tool role ${role} exactly once; found ${count}` });
  }
  const identityValid = failures.every((failure) => !['malformed-agent-tool-row', 'unexpected-agent-role', 'missing-agent-role', 'duplicate-agent-role'].includes(failure.type));
  const documented = new Map();
  if (identityValid) for (const row of parsed.rows) documented.set(row.key, row);
  if (!identityValid) return { ok: false, failures, expected, documented };
  for (const [role, tools] of expected) {
    const row = documented.get(role);
    verifyAnchor(projectRoot, row.anchor, failures, `agent tool row ${role}`);
    if (!sameArray(row.tools, tools)) failures.push({ type: 'agent-tool-parity', role, message: `${AGENTS_DOC} tools for ${role} do not match runtime role-provider composition (doc=${row.tools.join(',')} source=${tools.join(',')})` });
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
      if (!sameArray(row.fields, fields)) failures.push({ type: 'config-schema-parity', section, message: `${docPath} fields for ${section} do not match src/agents/config-schema.ts (doc=${row.fields.join(',')} source=${fields.join(',')})` });
    }
  }

  return { ok: failures.length === 0, failures, expected, documented: documentedByPath, checkedDocs: docPaths };
}

export function verifyDocSourceContracts(options = {}) {
  const projectRoot = options.projectRoot ?? process.cwd();
  const routeResult = verifyDocRoutes({ ...options, projectRoot });
  const toolResult = verifyAgentToolDocs({ projectRoot });
  const configResult = verifyConfigDocs({ projectRoot });
  const failures = [...routeResult.failures, ...toolResult.failures, ...configResult.failures];
  return { ok: failures.length === 0, failures, routeResult, toolResult, configResult };
}

function sourceFilesForReport(projectRoot) {
  return [...STATIC_SOURCE_FILES, ...discoverOperatorContractRouteSources(projectRoot)].sort();
}

export function formatVerificationResult(result, projectRoot = process.cwd()) {
  const lines = [];
  lines.push('==> Verifying active docs against source contracts...');
  lines.push(`  Checked ${result.routeResult.checkedDocs.length} active doc(s), ${result.routeResult.implementedRoutes.size} implemented route(s), ${result.routeResult.routeInventoryRows.length} operator inventory row(s), and ${result.routeResult.internalDebugRows.length} internal debug row(s).`);
  lines.push(`  Checked agent tool parity, configuration schema fields in ${result.configResult.checkedDocs.length} config doc(s), and code anchors.`);
  if (result.ok) lines.push('  ✓ current docs match Fastify/contract routes, agent tools, config schema, and anchors');
  else {
    lines.push('  ✗ documentation/source drift detected:');
    for (const failure of result.failures) lines.push(`    - ${failure.message}`);
  }
  lines.push(`  Source files: ${sourceFilesForReport(projectRoot).map((p) => relative(projectRoot, join(projectRoot, p))).join(', ')}`);
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
