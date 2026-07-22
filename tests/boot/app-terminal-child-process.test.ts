import { afterEach, describe, expect, it } from '@jest/globals';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { initProjectTree } from '../helpers/canonical-project.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';

const fixture = join(process.cwd(), 'tests', 'fixtures', 'app-terminal-child.ts');
const tsx = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
const REAL_CHILD_PROCESS_RUNAWAY_TIMEOUT_MS = 20_000;
const children = new Set<ChildProcess>();

function runChild(scenario: string, projectRoot?: string, extraEnv: NodeJS.ProcessEnv = {}): ChildProcess {
  const child = spawn(process.execPath, [tsx, fixture, scenario, ...(projectRoot ? [projectRoot] : [])], {
    cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

function collect(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  let stdout = ''; let stderr = '';
  child.stdout!.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
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
    const root = project(validConfig(await availablePort())); roots.push(root);
    const child = runChild('signal', root, { SAIVAGE_API_TOKEN: '' });
    const result = collect(child);
    await new Promise<void>((resolve, reject) => {
      let output = '';
      child.stdout!.on('data', (chunk: Buffer | string) => { output += chunk.toString(); if (output.includes('READY')) resolve(); });
      child.once('error', reject);
    });
    child.kill('SIGTERM');
    await expect(result).resolves.toMatchObject({ code: 0, signal: null });
  }, REAL_CHILD_PROCESS_RUNAWAY_TIMEOUT_MS);

  it('preserves the original startup failure after coordinator cleanup', async () => {
    const root = project('models: invalid\n'); roots.push(root);
    const result = await collect(runChild('startup-failure', root));
    expect(result).toMatchObject({ code: 23, signal: null });
    expect(result.stderr).toContain('STARTUP_ERROR:');
  }, REAL_CHILD_PROCESS_RUNAWAY_TIMEOUT_MS);

  it('keeps acknowledged restart on exit code 75', async () => {
    const root = project(validConfig(await availablePort())); roots.push(root);
    await expect(collect(runChild('restart-75', root, { SAIVAGE_API_TOKEN: 'child-test-token' }))).resolves.toMatchObject({ code: 75, signal: null });
  }, REAL_CHILD_PROCESS_RUNAWAY_TIMEOUT_MS);

  it('clears a real referenced timer after fast rejection so the child exits promptly', async () => {
    const result = await collect(runChild('coordinator-fast-reject'));
    const payload = JSON.parse(result.stdout.trim()) as { elapsed: number; exitReadyElapsed: number; report: unknown };
    expect(result).toMatchObject({ code: 0, signal: null });
    expect(payload.elapsed).toBeLessThan(1_000);
    expect(payload.exitReadyElapsed).toBeLessThan(1_000);
    expect(payload.report).toEqual({ warnings: [{ component: 'runtime', code: 'cleanup_failed' }] });
  }, REAL_CHILD_PROCESS_RUNAWAY_TIMEOUT_MS);

  it('keeps a hanging child alive through the real ten-second bound then runs the later leaf', async () => {
    const result = await collect(runChild('coordinator-hang'));
    const payload = JSON.parse(result.stdout.trim()) as { elapsed: number; later: boolean; report: unknown };
    expect(result).toMatchObject({ code: 0, signal: null });
    expect(payload.elapsed).toBeGreaterThanOrEqual(9_900);
    expect(payload.later).toBe(true);
    expect(payload.report).toEqual({ warnings: [{ component: 'runtime', code: 'cleanup_timeout' }] });
  }, REAL_CHILD_PROCESS_RUNAWAY_TIMEOUT_MS);
});

function validConfig(port: number): string {
  return stringify({ ...structuredClone(TEST_SAIVAGE_CONFIG), server: { host: '127.0.0.1', port } });
}
