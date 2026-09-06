import { describe, expect, it } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

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

describe('source-derived publication owner inventory', () => {
  it('keeps CardProcessActor as the sole production BaseActor subclass', () => {
    const inventory = occurrenceInventory(/extends\s+BaseActor\b/gu);
    expect(inventory).toHaveLength(1);
    expect(inventory[0]).toContain('src/runtime/actors/card-process-actor.ts:');
  });

  it('closes every detached consumer/observer site under an explicit current owner decision', () => {
    expect(fileCountInventory(/\.trackConsumer\(/gu)).toEqual({
      'src/agents/analyst-handler.ts': 1,
      'src/runtime/actors/card-process-actor.ts': 2,
      'src/runtime/actors/llm-actor.ts': 1,
    });
    expect(fileCountInventory(/\bobserve\(/gu)).toEqual({ 'src/runtime/actors/llm-actor.ts': 9 });
    expect(fileCountInventory(/\.finally\([^\n]*\)\.catch\(/gu)).toEqual({
      'src/mcp/mcp-manager.ts': 1,
      'src/runtime/actors/contained-operations.ts': 4,
    });
    for (const owner of ['src/agents/analyst-handler.ts', 'src/runtime/actors/card-process-actor.ts', 'src/runtime/actors/llm-actor.ts']) {
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

  it('keeps the sole AnalystWsHandler composition and every rejection owner fatal-aware', () => {
    expect(fileCountInventory(/new\s+AnalystWsHandler\(/gu)).toEqual({ 'src/server/websocket.ts': 1 });
    const handler = source('src/server/analyst-ws-handler.ts');
    expect([...handler.matchAll(/(?<!\.)\bcatch\s*\(/gu)]).toHaveLength(1);
    expect([...handler.matchAll(/\.catch\(/gu)]).toHaveLength(0);
    expect(handler).not.toContain('turnQueues');
    expect(handler).not.toContain('queueTurn');
    expect(source('src/server/websocket.ts')).toContain('fatalPort: options.fatalPort');
    expect(source('src/server/composition/route-composition.ts')).toContain('fatalPort: options.fatalPort');
  });

  it('validates the exact configured Analyst session before transport, MCP, or runtime startup', () => {
    const services = source('src/server/composition/server-services.ts');
    const workflows = services.indexOf('const workflows = bindRuntimeWorkflows');
    const identity = services.indexOf('globalAgentSessionId(workflows.analyst.name)');
    const validation = services.indexOf('validateConfiguredAnalystConversation(projectRoot, analystSessionId)');
    expect(workflows).toBeLessThan(identity);
    expect(identity).toBeLessThan(validation);
    expect(validation).toBeLessThan(services.indexOf('await createFastifyApp'));
    expect(validation).toBeLessThan(services.indexOf('new McpManager'));
    expect(validation).toBeLessThan(services.indexOf('runtimeApplication.runtimeApi.start()'));
  });

  it('has no obsolete publication errors or retained process writer anywhere in production', () => {
    expect(allSource).not.toMatch(/AppLogPublicationError|rethrowAppLogPublicationError|RecordAcceptanceOutcomeUnknown|createWriteStream|WriteStream|streamClose/);
  });

  it('keeps corrective conversation recovery solely in Supervisor explicit Run', () => {
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
