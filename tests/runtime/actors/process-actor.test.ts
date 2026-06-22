import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProjectTree } from '../../../src/persistence/file-tree.js';
import { ProcessActor, readActorSnapshots } from '../../../src/runtime/actors/index.js';

function withTempProject<T>(fn: (projectRoot: string) => Promise<T> | T): Promise<T> | T {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-process-actor-'));
  const result = fn(projectRoot);
  if (result instanceof Promise) return result.finally(() => rmSync(projectRoot, { recursive: true, force: true }));
  rmSync(projectRoot, { recursive: true, force: true });
  return result;
}

async function eventually(assertion: () => void, attempts = 50): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try { assertion(); return; } catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 5)); }
  }
  throw lastError;
}

describe('ProcessActor', () => {
  it('launches a process, records metadata, output, and terminal exit', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const actor = new ProcessActor({ projectRoot, processId: 'P-1' });
    actor.start();

    actor.launch({ command: process.execPath, args: ['-e', 'console.log("hello"); console.error("warn")'] });
    await eventually(() => expect(actor.pid).not.toBeNull());
    const result = await actor.wait(1000);

    expect(result).toMatchObject({ status: 'settled', exitCode: 0, signal: null });
    expect(result.output.stdout).toContain('hello');
    expect(result.output.stderr).toContain('warn');
    expect(actor.command).toBe(process.execPath);
    expect(actor.args).toEqual(['-e', 'console.log("hello"); console.error("warn")']);
    expect(readActorSnapshots(projectRoot).map((snapshot) => snapshot.actor_id)).toContain('process:P-1');
  }));

  it('wait timeout is non-destructive', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const actor = new ProcessActor({ projectRoot, processId: 'P-2' });
    actor.start();

    actor.launch({ command: process.execPath, args: ['-e', 'setTimeout(() => console.log("late"), 80)'] });
    const timedOut = await actor.wait(5);

    expect(timedOut).toMatchObject({ status: 'running', timedOut: true });
    expect(actor.pid).not.toBeNull();
    const settled = await actor.wait(1000);
    expect(settled).toMatchObject({ status: 'settled', exitCode: 0 });
    expect(settled.output.stdout).toContain('late');
  }));

  it('inspect returns bounded output', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const actor = new ProcessActor({ projectRoot, processId: 'P-3' });
    actor.start();

    actor.launch({ command: process.execPath, args: ['-e', 'console.log("abcdef")'] });
    await actor.wait(1000);

    expect(actor.inspect({ stdoutTail: 4 }).stdout).toBe('def\n');
  }));

  it('kill terminates a running process and records diagnostics', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const actor = new ProcessActor({ projectRoot, processId: 'P-4' });
    actor.start();

    actor.launch({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] });
    await eventually(() => expect(actor.pid).not.toBeNull());
    actor.kill('test requested kill');
    const result = await actor.wait(1000);

    expect(result.status).toBe('settled');
    expect(actor.killReason).toBe('test requested kill');
    expect(actor.signal).toBe('SIGTERM');
  }));
});
