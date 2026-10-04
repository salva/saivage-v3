import { describe, expect, it } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const sourceRoot = join(process.cwd(), 'src');
const sourceFiles = readdirSync(sourceRoot, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
  .map((entry) => join(entry.parentPath, entry.name))
  .sort();
const relativePath = (path: string): string => relative(process.cwd(), path);
const source = (path: string): string => readFileSync(join(process.cwd(), path), 'utf8');
const allSource = sourceFiles.map((path) => `// ${relativePath(path)}\n${readFileSync(path, 'utf8')}`).join('\n');

function occurrenceInventory(pattern: RegExp): string[] {
  return sourceFiles.flatMap((path) => {
    const text = readFileSync(path, 'utf8');
    return [...text.matchAll(pattern)].map((match) => `${relativePath(path)}:${text.slice(0, match.index).split('\n').length}:${match[0]}`);
  });
}

function fileCountInventory(pattern: RegExp): Record<string, number> {
  return Object.fromEntries(sourceFiles.flatMap((path) => {
    const count = [...readFileSync(path, 'utf8').matchAll(pattern)].length;
    return count === 0 ? [] : [[relativePath(path), count]];
  }));
}

function finallyCatchInventory(): Record<string, number> {
  return Object.fromEntries(sourceFiles.flatMap((path) => {
    const ast = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    let count = 0;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'catch') {
        const receiver = node.expression.expression;
        if (ts.isCallExpression(receiver) && ts.isPropertyAccessExpression(receiver.expression)
          && receiver.expression.name.text === 'finally') count += 1;
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    return count === 0 ? [] : [[relativePath(path), count]];
  }));
}

// Only the current direct startup statements are inspected; this is not control-flow analysis.
function startupAst(text: string): ts.SourceFile {
  return ts.createSourceFile('startup.ts', text, ts.ScriptTarget.Latest, true);
}
function statements(ast: ts.SourceFile, name: string): readonly ts.Statement[] {
  const fn = ast.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === name);
  expect(fn?.body).toBeDefined();
  return fn!.body!.statements;
}
function imported(ast: ts.SourceFile, name: string, owner: string): void {
  expect(ast.statements.some(node => ts.isImportDeclaration(node)
    && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === owner
    && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
    && node.importClause.namedBindings.elements.some(binding => binding.name.text === name
      && (binding.propertyName?.text ?? binding.name.text) === name))).toBe(true);
}
function directCall(statement: ts.Statement, awaited = false): ts.CallExpression | undefined {
  let expression: ts.Expression | undefined;
  if (ts.isExpressionStatement(statement)) expression = statement.expression;
  if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1)
    expression = statement.declarationList.declarations[0]!.initializer;
  if (!expression) return undefined;
  if (awaited) {
    if (!ts.isAwaitExpression(expression)) return undefined;
    expression = expression.expression;
  }
  return ts.isCallExpression(expression) ? expression : undefined;
}
const printer = ts.createPrinter({ removeComments: true });
function syntax(node: ts.Node): string {
  return printer.printNode(ts.EmitHint.Unspecified, node, node.getSourceFile());
}
function orderedPositions(positions: number[]): void {
  for (const position of positions) expect(position).toBeGreaterThanOrEqual(0);
  for (let i = 1; i < positions.length; i++) expect(positions[i - 1]).toBeLessThan(positions[i]!);
}
function assertGlobalStartup(text: string): void {
  const ast = startupAst(text);
  imported(ast, 'globalAgentSessionId', '../../schemas/index.js');
  imported(ast, 'settleFinalUnmatchedCall', '../../runtime/runtime-api.js');
  imported(ast, 'isConversationCatalogEstablished', '../../persistence/index.js');
  const body = statements(ast, 'createServerServices');
  const identity = (name: string, agent: string): number => body.findIndex(node =>
    ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration =>
      ts.isIdentifier(declaration.name) && declaration.name.text === name
      && declaration.initializer && ts.isCallExpression(declaration.initializer)
      && syntax(declaration.initializer) === `globalAgentSessionId(workflows.${agent}.name)`));
  const settlement = (node: ts.Statement, id: string): boolean => {
    const call = directCall(node);
    return !!call && syntax(call) === `settleFinalUnmatchedCall({ projectRoot }, ${id})`;
  };
  const oversight = body.findIndex(node => ts.isIfStatement(node)
    && ts.isCallExpression(node.expression)
    && syntax(node.expression) === 'isConversationCatalogEstablished(projectRoot, oversightSessionId)'
    && !node.elseStatement
    && (ts.isBlock(node.thenStatement)
      ? node.thenStatement.statements.length === 1 && settlement(node.thenStatement.statements[0]!, 'oversightSessionId')
      : settlement(node.thenStatement, 'oversightSessionId')));
  const awaited = (name: string): number => body.findIndex(node => {
    const call = directCall(node, true);
    return !!call && syntax(call) === name;
  });
  orderedPositions([
    identity('analystSessionId', 'analyst'),
    body.findIndex(node => settlement(node, 'analystSessionId')),
    identity('oversightSessionId', 'oversight'), oversight,
    awaited('runtimeApplication.runtimeApi.start()'), awaited('mcpManager.reconcilePersistedConfig()'),
  ]);
}
function assertServerStartup(text: string): void {
  const ast = startupAst(text);
  imported(ast, 'createServerServices', './composition/server-services.js');
  imported(ast, 'registerServerRoutes', './composition/route-composition.js');
  const position = (body: readonly ts.Statement[], callee: string, awaited: boolean): number =>
    body.findIndex(node => {
      const call = directCall(node, awaited);
      return !!call && syntax(call.expression) === callee && call.arguments.length === 1
        && (callee === 'createServer' ? syntax(call.arguments[0]!) === 'options' : ts.isObjectLiteralExpression(call.arguments[0]!));
    });
  const creation = statements(ast, 'createServer');
  orderedPositions([position(creation, 'createServerServices', true), position(creation, 'registerServerRoutes', false)]);
  const listening = statements(ast, 'startServer');
  orderedPositions([position(listening, 'createServer', true), position(listening, 'server.fastify.listen', true)]);
}

describe('source-derived publication owner inventory', () => {
  it('keeps CardProcessActor as the sole production BaseActor subclass', () => {
    const inventory = occurrenceInventory(/extends\s+BaseActor\b/gu);
    expect(inventory).toHaveLength(1);
    expect(inventory[0]).toContain('src/runtime/actors/card-process-actor.ts:');
  });

  it('closes every detached consumer/observer site under an explicit current owner decision', () => {
    expect(fileCountInventory(/\.trackConsumer\(/gu)).toEqual({
      'src/runtime/actors/analyst-session.ts': 1,
      'src/runtime/actors/card-process-actor.ts': 2,
      'src/runtime/actors/llm-actor.ts': 1,
    });
    expect(fileCountInventory(/\bobserve\(/gu)).toEqual({ 'src/runtime/actors/llm-actor.ts': 9 });
    expect(finallyCatchInventory()).toEqual({
      'src/mcp/mcp-manager.ts': 1,
      'src/runtime/actors/contained-operations.ts': 4,
    });
    for (const owner of ['src/runtime/actors/analyst-session.ts', 'src/runtime/actors/card-process-actor.ts', 'src/runtime/actors/llm-actor.ts']) {
      expect(source(owner)).toMatch(/deliverPublicationFatal|onFatalTaskError/);
    }
  });

  it('keeps every ProcessRunner termination surface and production caller explicit', () => {
    const runner = source('src/runtime/process-runner.ts');
    const registryDelegations = [...runner.matchAll(/\.\s*(terminateGroup|terminateScopeTree|closeAndTerminateDirectScope)\s*\(/gu)].map((match) => match[1]).sort();
    expect(registryDelegations).toEqual(['closeAndTerminateDirectScope', 'terminateGroup', 'terminateScopeTree']);

    const publicCallerFiles = sourceFiles.filter((path) => ![
      'src/runtime/managed-process-group-registry.ts',
      'src/runtime/lock.ts',
      'src/runtime/process-runner.ts',
    ].includes(relativePath(path)));
    const publicCallerInventory = Object.fromEntries(publicCallerFiles.flatMap((path) => {
      const count = [...readFileSync(path, 'utf8').matchAll(/\.\s*(?:kill|terminateScopeTree|closeAndTerminateDirectScope)\s*\(/gu)].length;
      return count === 0 ? [] : [[relativePath(path), count]];
    }));
    expect(publicCallerInventory).toEqual({
      'src/application/runtime-composition.ts': 2,
      'src/mcp/mcp-manager.ts': 1,
      'src/mcp/server-runtime.ts': 1,
      'src/runtime/actors/supervisor-runtime-api.ts': 2,
      'src/tools/process-provider.ts': 3,
    });
  });

  it('settles configured globals before runtime startup, MCP reconciliation, and listening', () => {
    assertGlobalStartup(source('src/server/composition/server-services.ts'));
    assertServerStartup(source('src/server/server.ts'));
  });

  it.each(['removed', 'unguarded', 'late', 'nested'] as const)('rejects %s Oversight settlement despite comment markers', (fault) => {
    const imports = `
      import { globalAgentSessionId } from '../../schemas/index.js';
      import { settleFinalUnmatchedCall } from '../../runtime/runtime-api.js';
      import { isConversationCatalogEstablished } from '../../persistence/index.js';`;
    const guarded = 'if (isConversationCatalogEstablished(projectRoot, oversightSessionId)) settleFinalUnmatchedCall({ projectRoot }, oversightSessionId);';
    const settlement = fault === 'removed' ? '' : fault === 'unguarded'
      ? 'settleFinalUnmatchedCall({ projectRoot }, oversightSessionId);'
      : fault === 'nested' ? `function unused() { ${guarded} }` : guarded;
    const text = `${imports}
      async function createServerServices() {
        const analystSessionId = globalAgentSessionId(workflows.analyst.name);
        settleFinalUnmatchedCall({ projectRoot }, analystSessionId);
        const oversightSessionId = globalAgentSessionId(workflows.oversight.name);
        // ${guarded}
        ${fault === 'late' ? '' : settlement}
        await runtimeApplication.runtimeApi.start();
        ${fault === 'late' ? settlement : ''}
        const mcpReconciliation = await mcpManager.reconcilePersistedConfig();
      }`;
    assertGlobalStartup(`${imports}
      async function createServerServices() {
        const analystSessionId = globalAgentSessionId(workflows.analyst.name);
        settleFinalUnmatchedCall({ projectRoot }, analystSessionId);
        const oversightSessionId = globalAgentSessionId(workflows.oversight.name);
        ${guarded}
        await runtimeApplication.runtimeApi.start();
        const mcpReconciliation = await mcpManager.reconcilePersistedConfig();
      }`);
    expect(() => assertGlobalStartup(text)).toThrow();
  });

  it('has no obsolete publication errors or retained process writer anywhere in production', () => {
    expect(allSource).not.toMatch(/AppLogPublicationError|rethrowAppLogPublicationError|RecordAcceptanceOutcomeUnknown|createWriteStream|WriteStream|streamClose/);
  });

  it('keeps broad corrective conversation stabilization solely in Supervisor explicit Run', () => {
    const recoveryModule = 'src/runtime/actors/conversation-recovery.ts';
    const correctiveCalls = sourceFiles
      .filter((path) => relativePath(path) !== recoveryModule)
      .flatMap((path) => {
        const count = [...readFileSync(path, 'utf8').matchAll(/\bstabilizeAgentSession\s*\(/gu)].length;
        return count === 0 ? [] : [`${relativePath(path)}:${count}`];
      });

    expect(correctiveCalls).toEqual(['src/runtime/actors/supervisor-runtime-api.ts:1']);
    expect(allSource).not.toMatch(/alreadyStabilizedAgents|#stabilizedAgents|\bbeginActivation\s*\(/u);
  });
});
