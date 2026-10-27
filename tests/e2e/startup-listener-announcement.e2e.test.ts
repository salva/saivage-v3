import { describe, expect, it } from '@jest/globals';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { replaceConfigYaml } from '../../src/config/config-file.js';
import { createProjectIdentity } from '../../src/persistence/project-identity.js';
import { publishTestProjectRuntime as publishInitialProjectRuntime } from '../helpers/initial-project-fixture.js';
import { compileProjectWorkflows } from '../../src/runtime/card-process/card-process-config.js';
import { readRuntimeLockStatus } from '../../src/runtime/lock.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';

const cli = resolve('src/cli.ts');
const tsx = createRequire(import.meta.url).resolve('tsx');
const wildcardSuffix = ' (wildcard bind; use a reachable host address to connect)';

async function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function ipv6Available(host: string): Promise<boolean> {
  const probe = createServer();
  try {
    await bounded(new Promise<void>((resolveListen, reject) => {
      probe.once('error', reject);
      probe.listen(0, host, resolveListen);
    }), 5_000, `TCP capability ${host}`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EAFNOSUPPORT' || code === 'EADDRNOTAVAIL') {
      console.log(`PORT-05 IPv6 ${host}: SKIPPED (${code})`);
      return false;
    }
    throw error;
  } finally {
    // Also cancels an outstanding listen if its bounded wait failed.
    await bounded(new Promise<void>((resolveClose, reject) => {
      probe.close((error) => {
        if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolveClose();
      });
    }), 5_000, `TCP capability close ${host}`);
  }
  console.log(`PORT-05 IPv6 ${host}: available`);
  return true;
}

function launch(root: string, host: string) {
  // Deliberate allowlist: inherit no Saivage selectors, provider credentials,
  // NODE_OPTIONS, proxy settings or real HOME/configuration locations.
  const child = spawn(process.execPath, ['--import', tsx, cli, 'start',
    '--project-root', root, '--host', host, '--port', '0'], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, NODE_ENV: 'test', LOG_LEVEL: 'silent' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let closed = false;
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClose) => {
    child.once('close', (code, signal) => {
      closed = true;
      resolveClose({ code, signal });
    });
  });
  let stdout = '';
  const announcement = new Promise<string>((resolveAnnouncement, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => reject(new Error(`CLI exited before announcement: ${code}/${signal}`)));
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      const line = stdout.split('\n').find((value) => value.startsWith('Saivage server listening on '));
      if (line !== undefined && stdout.includes(`${line}\n`)) resolveAnnouncement(line);
    });
  });
  // Drain without printing potentially sensitive diagnostic contents.
  child.stderr!.resume();
  return {
    announcement,
    async stop(): Promise<void> {
      let forced = false;
      if (!closed) {
        child.kill('SIGTERM');
        try {
          await bounded(completion, 15_000, 'CLI graceful termination');
        } catch {
          forced = true;
          child.kill('SIGKILL');
          await bounded(completion, 5_000, 'CLI forced termination');
        }
      }
      return assertCleanExit(await completion, forced);
    },
    isClosed: () => closed,
  };
}

function assertCleanExit(result: { code: number | null; signal: NodeJS.Signals | null }, forced: boolean): void {
  expect({ ...result, forced }).toEqual({ code: 0, signal: null, forced: false });
}

async function health(origin: string): Promise<void> {
  const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(5_000) });
  await response.text();
  console.log(`PORT-05 health ${origin}/health: ${response.status}`);
  expect(response.status).toBe(200);
}

describe('real CLI startup listener announcement', () => {
  it.each(['127.0.0.1', '0.0.0.0', '::1', '::'])('reports actual %s port-zero binding', async (host) => {
    if (host.includes(':') && !await ipv6Available(host)) return;
    const root = mkdtempSync(join(tmpdir(), 'PORT-05-listener-'));
    let running: ReturnType<typeof launch> | undefined;
    try {
      const config = structuredClone(TEST_SAIVAGE_CONFIG);
      config.oversight.enabled = false;
      config.mcpServers = {};
      createProjectIdentity(root, 'PORT-05 isolated startup');
      replaceConfigYaml(join(root, '.saivage', 'saivage.yaml'), config);
      publishInitialProjectRuntime(root, compileProjectWorkflows(config));
      running = launch(root, host);
      const line = await bounded(running.announcement, 30_000, 'CLI announcement');
      console.log(`PORT-05 emitted: ${line}`);
      const wildcard = host === '0.0.0.0' || host === '::';
      const expectedHost = host.includes(':') ? `[${host}]` : host;
      const match = /^Saivage server listening on (http:\/\/\S+)(.*)$/.exec(line);
      expect(match).not.toBeNull();
      const url = new URL(match![1]!);
      expect(url.hostname).toBe(expectedHost);
      expect(Number(url.port)).toBeGreaterThan(0);
      expect(Number(url.port)).toBeLessThanOrEqual(65535);
      expect(match![2]).toBe(wildcard ? wildcardSuffix : '');
      if (host === '0.0.0.0') {
        await health(`http://127.0.0.1:${url.port}`);
        const lock = readRuntimeLockStatus(root);
        expect(lock.kind).toBe('live');
        if (lock.kind !== 'live') throw new Error('Expected live fixture lifecycle owner');
        expect(lock.record.control_endpoint).toEqual({ origin: `http://127.0.0.1:${url.port}`, auth: 'disabled' });
        console.log(`PORT-05 control corroboration: http://127.0.0.1:${url.port}, auth disabled`);
      } else if (!wildcard) {
        await health(url.origin);
      }
    } finally {
      try {
        await running?.stop();
      } finally {
        // A failed termination must never be hidden by deleting a live fixture.
        if (running === undefined || running.isClosed()) rmSync(root, { recursive: true, force: true });
      }
    }
  }, 90_000);
});
