import { afterEach, describe, expect, it } from '@jest/globals';
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
const tmpdir = () => '/home/salva/g/ml/tmp';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { CardService, initProjectTree } from '../helpers/canonical-project.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';
import { globalAgentConversationVersionFile, runtimeProcessLockFile } from '../../src/persistence/layout.js';
import { appendConversationBatch, initializeMissingConversation, readCurrentConversationSegment } from '../../src/persistence/conversation-file.js';
import { buildGlobalAgentIngressRows } from '../../src/runtime/actors/conversation-session.js';
import { appendStartupEvidence, appendStartupPendingCall } from '../helpers/startup-session-fixtures.js';
import { readRuntimeLockStatus } from '../../src/runtime/lock.js';

const fixture = join(process.cwd(), 'tests', 'fixtures', 'app-terminal-child.ts');
const REAL_CHILD_PROCESS_RUNAWAY_TIMEOUT_MS = 20_000;
const children = new Map<ChildProcess, { scenario: string; stdout: string; stderr: string }>();

function runChild(scenario: string, projectRoot?: string, extraEnv: NodeJS.ProcessEnv = {}, target?: string): ChildProcess {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent' };
  delete env.SAIVAGE_API_TOKEN;
  Object.assign(env, extraEnv);
  const selectedFixture = scenario.startsWith('startup-admission-') ? join(process.cwd(), 'tests', 'fixtures', 'startup-admission-fatal.ts') : fixture;
  const child = spawn(process.execPath, ['--import', 'tsx', selectedFixture, scenario, ...(projectRoot ? [projectRoot] : []), ...(target ? [target] : [])], {
    cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.set(child, { scenario, stdout: '', stderr: '' });
  child.once('close', () => children.delete(child));
  return child;
}

function collect(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  const output = children.get(child)!;
  child.stdout!.setEncoding('utf8').on('data', (chunk: string) => { output.stdout += chunk; });
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { output.stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      process.stderr.write(`TERMINAL_CHILD_CLOSE:${JSON.stringify({ ...output, code, signal })}\n`);
      resolve({ code, signal, stdout: output.stdout, stderr: output.stderr });
    });
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
  it('dispatches lifecycle release uncertainty instead of a terminal warning or normal stop', async () => {
    const root = project(validConfig(await availablePort())); roots.push(root);
    const result = await collect(runChild('release-fatal', root));
    expect(result).toMatchObject({ code: 1, signal: null, stdout: 'RELEASE_UNCERTAIN\n' });
    expect(result.stderr).toContain('Fatal: PublicationOutcomeUnknownError');
    expect(result.stderr).not.toContain('STARTUP_ERROR:');
    expect(existsSync(runtimeProcessLockFile(root))).toBe(true);
  }, REAL_CHILD_PROCESS_RUNAWAY_TIMEOUT_MS);
  afterEach(() => {
    for (const [child, output] of children) {
      process.stderr.write(`TERMINAL_CHILD_TEARDOWN_PARTIAL:${JSON.stringify(output)}\n`);
      child.kill('SIGKILL');
    }
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it.each(['mate', 'global-tail', 'oversight-tail', 'running-evidence-tail'] as const)('exits startup %s uncertainty before next subject, card stop, MCP, listener or cleanup', async (fault) => {
    const root = project(validConfig(await availablePort())); roots.push(root);
    new CardService(root).setStatus('project', 'running');
    const sessionId = 'agent:analyst:global' as const;
    const input = '11111111-1111-4111-8111-111111111111';
    appendConversationBatch({ projectRoot: root }, buildGlobalAgentIngressRows(sessionId, input, 'interrupted question', { kind: 'unavailable', reason: 'not_recorded' }));
    appendStartupPendingCall(root, sessionId, input);
    const segment = readCurrentConversationSegment(root, sessionId)!;
    let target = globalAgentConversationVersionFile(root, 'analyst', segment.entry.filename);
    if (fault === 'oversight-tail') {
      initializeMissingConversation(root, 'agent:oversight:global');
      appendConversationBatch({ projectRoot: root }, buildGlobalAgentIngressRows('agent:oversight:global', input, 'interrupted check', { kind: 'unavailable', reason: 'not_recorded' }));
      const oversight = readCurrentConversationSegment(root, 'agent:oversight:global')!;
      target = globalAgentConversationVersionFile(root, 'oversight', oversight.entry.filename);
    }
    if (fault === 'running-evidence-tail') target = appendStartupEvidence(root, 'agent:planner:project');
    if (fault !== 'mate') appendFileSync(target, '{"torn":');
    const result = await collect(runChild(`startup-admission-${fault}`, root, {}, target));
    expect(result).toMatchObject({ code: 1, signal: null, stdout: fault === 'mate' ? 'MATE_WRITE_UNCERTAIN\n' : 'TRUNCATE_UNCERTAIN\n' });
    expect(result.stderr).toContain('Fatal: PublicationOutcomeUnknownError; Saivage is halting because durable publication outcome is unknown.');
    expect(result.stderr).not.toContain('STARTUP_ERROR:');
    expect(existsSync(runtimeProcessLockFile(root))).toBe(true);
    expect(readRuntimeLockStatus(root).kind).toBe('dead');
    unlinkSync(runtimeProcessLockFile(root));
  }, REAL_CHILD_PROCESS_RUNAWAY_TIMEOUT_MS);

  it('exits on startup stopped-publication uncertainty before the App terminal coordinator releases exclusion', async () => {
    const root = project(validConfig(await availablePort())); roots.push(root);
    new CardService(root).setStatus('project', 'running');
    const result = await collect(runChild('startup-publication-fatal', root));
    expect(result).toMatchObject({ code: 1, signal: null, stdout: 'STOPPED_APPEND_ATTEMPT\n' });
    expect(result.stderr).toContain('Fatal: PublicationOutcomeUnknownError; Saivage is halting because durable publication outcome is unknown.');
    expect(result.stderr).not.toContain('STARTUP_ERROR:');
    expect(existsSync(runtimeProcessLockFile(root))).toBe(true);
    expect(readRuntimeLockStatus(root).kind).toBe('dead');
    unlinkSync(runtimeProcessLockFile(root));
  }, REAL_CHILD_PROCESS_RUNAWAY_TIMEOUT_MS);

  it('handles a real SIGTERM through the App coordinator and exits zero', async () => {
    const root = project(validConfig(await availablePort())); roots.push(root);
    const child = runChild('signal', root);
    const result = collect(child);
    let output = '';
    let onData: (chunk: string) => void;
    let onError: (error: Error) => void;
    const ready = new Promise<string>((resolve, reject) => {
      onData = (chunk) => {
        output += chunk;
        const match = /(?:^|\n)READY:(\d+)\n/.exec(output);
        if (match) resolve(match[1]!);
      };
      onError = reject;
      child.stdout!.on('data', onData);
      child.once('error', onError);
    });
    try {
      const pid = await Promise.race([
        ready,
        result.then((closed) => { throw new Error(`Signal child closed before READY: ${JSON.stringify(closed)}`); }),
      ]);
      expect(pid).toBe(String(child.pid));
    } finally {
      child.stdout!.off('data', onData!);
      child.off('error', onError!);
    }
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

  it('contains an unexpected Oversight owner failure through synchronous close, bounded cleanup, and exit 1', async () => {
    const result = await collect(runChild('oversight-owner-failure'));
    expect(result).toMatchObject({ code: 1, signal: null });
    expect(result.stdout).toContain('ADMISSION_CLOSED');
    expect(result.stdout).toContain('OVERSIGHT_CLOSED');
    expect(result.stdout).toContain('OVERSIGHT_SETTLED');
    expect(result.stdout).toContain('RUNTIME_CLEANED');
    expect(result.stderr).toBe('[oversight] owner failure; application terminating\n');
    expect(`${result.stdout}${result.stderr}`).not.toContain('private-provider-and-state-details');
  }, REAL_CHILD_PROCESS_RUNAWAY_TIMEOUT_MS);
});

function validConfig(port: number): string {
  return stringify({ ...structuredClone(TEST_SAIVAGE_CONFIG), server: { host: '127.0.0.1', port } });
}
