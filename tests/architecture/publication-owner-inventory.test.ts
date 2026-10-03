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
    const services = source('src/server/composition/server-services.ts');
    const workflows = services.indexOf('const workflows = bindRuntimeWorkflows(');
    const analystIdentity = services.indexOf('const analystSessionId = globalAgentSessionId(workflows.analyst.name);');
    const analystSettlement = services.indexOf('stabilizeGlobalSessionAtStartup({ projectRoot }, analystSessionId);');
    const oversightIdentity = services.indexOf('const oversightSessionId = globalAgentSessionId(workflows.oversight.name);');
    const oversightEstablishment = services.indexOf('let oversightEstablished = true;');
    const oversightCatalog = services.indexOf('readConversationCatalog(projectRoot, oversightSessionId);');
    const oversightSettlement = services.indexOf('stabilizeGlobalSessionAtStartup({ projectRoot }, oversightSessionId);');
    const runtimeStart = services.indexOf('await runtimeApplication.runtimeApi.start();');
    const mcpReconciliation = services.indexOf('const mcpReconciliation = await mcpManager.reconcilePersistedConfig();');
    for (const position of [workflows, analystIdentity, analystSettlement, oversightIdentity,
      oversightEstablishment, oversightCatalog, oversightSettlement, runtimeStart, mcpReconciliation]) {
      expect(position).toBeGreaterThanOrEqual(0);
    }
    expect(workflows).toBeLessThan(analystIdentity);
    expect(workflows).toBeLessThan(oversightIdentity);
    expect(analystIdentity).toBeLessThan(analystSettlement);
    expect(analystSettlement).toBeLessThan(oversightIdentity);
    expect(oversightIdentity).toBeLessThan(oversightEstablishment);
    expect(oversightEstablishment).toBeLessThan(oversightCatalog);
    expect(oversightCatalog).toBeLessThan(oversightSettlement);
    expect(oversightIdentity).toBeLessThan(oversightSettlement);

    const optionalOversightBlock = new RegExp([
      /^\s*let\s+oversightEstablished\s*=\s*true\s*;/u.source,
      /try\s*\{/u.source,
      /readConversationCatalog\s*\(\s*projectRoot\s*,\s*oversightSessionId\s*\)\s*;/u.source,
      /\}\s*catch\s*\(\s*error\s*\)\s*\{/u.source,
      /if\s*\(\s*\(\s*error\s+as\s+NodeJS\.ErrnoException\s*\)\s*\.code\s*!==\s*'ENOENT'\s*\)\s*throw\s+error\s*;/u.source,
      /oversightEstablished\s*=\s*false\s*;\s*\}/u.source,
      /if\s*\(\s*oversightEstablished\s*\)\s*stabilizeGlobalSessionAtStartup\s*\(\s*\{\s*projectRoot\s*\}\s*,\s*oversightSessionId\s*\)\s*;\s*$/u.source,
    ].join('\\s*'), 'u');
    expect(services.slice(oversightEstablishment, runtimeStart)).toMatch(optionalOversightBlock);
    for (const settlement of [analystSettlement, oversightSettlement]) {
      expect(settlement).toBeLessThan(runtimeStart);
      expect(settlement).toBeLessThan(mcpReconciliation);
    }
    expect(runtimeStart).toBeLessThan(mcpReconciliation);

    const server = source('src/server/server.ts');
    const serviceCreation = server.indexOf('const services = await createServerServices({');
    const routeRegistration = server.indexOf('registerServerRoutes({');
    const serverCreation = server.indexOf('const server = await createServer(options);');
    const listen = server.indexOf('await server.fastify.listen({');
    for (const position of [serviceCreation, routeRegistration, serverCreation, listen]) {
      expect(position).toBeGreaterThanOrEqual(0);
    }
    expect(serviceCreation).toBeLessThan(routeRegistration);
    expect(serverCreation).toBeLessThan(listen);
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
