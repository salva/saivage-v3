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
    expect(fileCountInventory(/\bobserve\(/gu)).toEqual({ 'src/runtime/actors/llm-actor.ts': 12 });
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
    expect(fileCountInventory(/#registry\.(?:terminateGroup|terminateScopeTree|closeAndTerminateDirectScope)\(/gu)).toEqual({ 'src/runtime/process-runner.ts': 3 });
    expect(fileCountInventory(/#joinStopped\(report\)/gu)).toEqual({ 'src/runtime/process-runner.ts': 3 });
    expect(fileCountInventory(/(?:processRunner|#processRunner)\s*\.\s*(?:kill|terminateScopeTree|closeAndTerminateDirectScope)\(/gu)).toEqual({
      'src/application/runtime-composition.ts': 2,
      'src/mcp/mcp-manager.ts': 1,
      'src/mcp/server-runtime.ts': 1,
      'src/runtime/actors/supervisor-runtime-api.ts': 2,
      'src/tools/process-provider.ts': 3,
    });
    expect(runner.indexOf('replaceFile(stdoutPath')).toBeLessThan(runner.indexOf('this.#registry.launch('));
    expect(runner.indexOf('replaceFile(stderrPath')).toBeLessThan(runner.indexOf('this.#registry.launch('));
    expect(runner).toMatch(/readable\.on\('data'/);
    expect(runner).toMatch(/readable\.on\('error'/);
    expect(runner).toMatch(/readable\.once\('end'/);
    expect(runner).toMatch(/readable\.once\('close'/);
    expect(runner).toMatch(/child\.once\('exit'/);
    expect(runner).toMatch(/child\.once\('error'/);
    expect(runner).toContain('Promise.all([absence, stdoutDrain, stderrDrain])');
  });

  it('keeps the sole AnalystWsHandler composition and every rejection owner fatal-aware', () => {
    expect(fileCountInventory(/new\s+AnalystWsHandler\(/gu)).toEqual({ 'src/server/websocket.ts': 1 });
    const handler = source('src/server/analyst-ws-handler.ts');
    expect([...handler.matchAll(/(?<!\.)\bcatch\s*\(/gu)]).toHaveLength(1);
    expect([...handler.matchAll(/\.catch\(/gu)]).toHaveLength(1);
    expect(handler.match(/deliverPublicationFatal\(/g)).toHaveLength(4);
    expect(handler).not.toContain('previous.catch(() => undefined)');
    expect(handler).not.toMatch(/\.finally\([^]*turnQueues/);
    expect(source('src/server/websocket.ts')).toContain('fatalPort: options.fatalPort');
    expect(source('src/server/composition/route-composition.ts')).toContain('fatalPort: options.fatalPort');
  });

  it('has no obsolete publication errors or retained process writer anywhere in production', () => {
    expect(allSource).not.toMatch(/AppLogPublicationError|rethrowAppLogPublicationError|RecordAcceptanceOutcomeUnknown|createWriteStream|WriteStream|streamClose/);
  });
});
