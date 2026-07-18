import { afterEach, describe, expect, it } from '@jest/globals';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProjectTree } from '../helpers/canonical-project.js';

const fixture = join(process.cwd(), 'tests', 'fixtures', 'app-terminal-child.ts');
const tsx = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
const children = new Set<ChildProcess>();

function runChild(scenario: string, projectRoot?: string, extraEnv: NodeJS.ProcessEnv = {}): ChildProcess {
  const child = spawn(process.execPath, [tsx, fixture, scenario, ...(projectRoot ? [projectRoot] : [])], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

function collect(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  child.stdout!.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function project(config: string): string {
  const root = mkdtempSync(join(tmpdir(), 'saivage-app-child-'));
  initProjectTree(root);
  writeFileSync(join(root, '.saivage', 'saivage.yaml'), config);
  return root;
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Failed to reserve child-process test port.');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

describe('App terminal process adapters', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const child of children) child.kill('SIGKILL');
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('handles a real SIGTERM through the App coordinator and exits zero', async () => {
    const port = await availablePort();
    const root = project(validConfig(port));
    roots.push(root);
    const child = runChild('signal', root, { SAIVAGE_API_TOKEN: '' });
    const result = collect(child);
    await new Promise<void>((resolve, reject) => {
      let output = '';
      child.stdout!.on('data', (chunk: Buffer | string) => { output += chunk.toString(); if (output.includes('READY')) resolve(); });
      child.once('error', reject);
    });
    child.kill('SIGTERM');
    await expect(result).resolves.toMatchObject({ code: 0, signal: null });
  }, 20_000);

  it('preserves the original startup failure after coordinator cleanup', async () => {
    const root = project('models: invalid\n');
    roots.push(root);
    const result = await collect(runChild('startup-failure', root));
    expect(result.code).toBe(23);
    expect(result.stderr).toContain('STARTUP_ERROR:');
  }, 20_000);

  it('keeps acknowledged restart on exit code 75', async () => {
    const port = await availablePort();
    const root = project(validConfig(port));
    roots.push(root);
    const result = await collect(runChild('restart-75', root, { SAIVAGE_API_TOKEN: 'child-test-token' }));
    expect(result.code).toBe(75);
  }, 20_000);

  it('clears a real referenced timer after fast rejection so the child exits promptly', async () => {
    const started = Date.now();
    const result = await collect(runChild('coordinator-fast-reject'));
    const payload = JSON.parse(result.stdout.trim()) as { elapsed: number; report: unknown };
    expect(result.code).toBe(0);
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(payload.elapsed).toBeLessThan(1_000);
    expect(payload.report).toEqual({ warnings: [{ component: 'runtime', code: 'cleanup_failed' }] });
  }, 10_000);

  it('keeps a hanging child alive through the real ten-second bound then runs the later leaf', async () => {
    const result = await collect(runChild('coordinator-hang'));
    const payload = JSON.parse(result.stdout.trim()) as { elapsed: number; later: boolean; report: unknown };
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(payload.elapsed).toBeGreaterThanOrEqual(9_900);
    expect(payload.later).toBe(true);
    expect(payload.report).toEqual({ warnings: [{ component: 'runtime', code: 'cleanup_timeout' }] });
  }, 20_000);
});

function validConfig(port: number): string {
  return `models:\n  default: [test-model]\n  max_tokens:\n    analyst: 200\nproviders:\n  test:\n    models: [test-model]\ncompaction:\n  enabled: true\n  input_budget_tokens: 1000\n  summarizer_candidate:\n    provider: test\n    account: null\n    model: test-model\nruntime:\n  continuous_improvement: false\nserver:\n  host: 127.0.0.1\n  port: ${port}\n`;
}
