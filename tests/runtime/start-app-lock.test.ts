import { describe, it, expect, afterEach, jest } from '@jest/globals';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startApp, type App } from '../../src/boot/index.js';
import { run } from '../../src/cli.js';
import { isInitialized } from '../../src/persistence/file-tree.js';
import { acquireRuntimeLifecycleLock, parseRuntimeLockOwnerRecord, releaseRuntimeLifecycleLock, runtimeLifecycleLockRecord } from '../../src/runtime/lock.js';

const roots: string[] = [];
const apps: App[] = [];

function validProjectJson(name = 'start-lock-test'): string {
  return JSON.stringify({ id: 'project', name, context: '', goals_summary: '', constraints: [], planner_enabled: true, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' }, null, 2) + '\n';
}

function makeDurableOnlyProject(): { root: string; promptPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'saivage-start-lock-'));
  roots.push(root);
  const promptPath = join(root, '.saivage', 'config', 'prompts', 'project', 'planner.md');
  mkdirSync(join(promptPath, '..'), { recursive: true });
  writeFileSync(join(root, '.saivage', 'project.json'), validProjectJson());
  writeFileSync(join(root, '.saivage', 'saivage.yaml'), 'server:\n  host: "127.0.0.1"\n  port: 8080\nmodels:\n  default: ["gpt-4.1"]\nproviders: {}\n');
  writeFileSync(promptPath, '# Locked bootstrap prompt\n');
  return { root, promptPath };
}

afterEach(async () => {
  while (apps.length > 0) {
    const app = apps.pop();
    if (app) await app.stop();
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('startApp runtime lock ownership', () => {
  it('refuses an old valid live-PID lock before --create-runtime initialization', async () => {
    const { root, promptPath } = makeDurableOnlyProject();
    const lockPath = join(root, '.saivage', 'locks', 'runtime.lock');
    mkdirSync(join(lockPath, '..'), { recursive: true });
    const oldStartedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const blocker = acquireRuntimeLifecycleLock({ projectRoot: root, mode: 'bound' });
    const record = { ...runtimeLifecycleLockRecord(blocker), started_at: oldStartedAt };
    releaseRuntimeLifecycleLock(blocker);
    writeFileSync(lockPath, JSON.stringify(record, null, 2) + '\n');

    await expect(startApp({
      argv: ['node', 'saivage', 'start', '--create-runtime'],
      env: { SAIVAGE_PROJECT_ROOT: root, SAIVAGE_API_TOKEN: 'lock-test-token', SAIVAGE_PORT: '0' },
    })).rejects.toThrow(/live PID/);

    expect(isInitialized(root)).toBe(false);
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(record);
    expect(readFileSync(promptPath, 'utf8')).toBe('# Locked bootstrap prompt\n');
  });

  it('bootstraps --create-runtime under the canonical lock, rejects a second start, and releases on stop', async () => {
    const { root, promptPath } = makeDurableOnlyProject();
    expect(isInitialized(root)).toBe(false);

    const app = await startApp({
      argv: ['node', 'saivage', 'start', '--create-runtime'],
      env: { SAIVAGE_PROJECT_ROOT: root, SAIVAGE_API_TOKEN: 'lock-test-token', SAIVAGE_PORT: '0' },
    });
    apps.push(app);

    expect(isInitialized(root)).toBe(true);
    expect(app.server.runtimeApplication.cardStore.recordReader).toBe(app.authority.reader);
    expect((app.server.runtimeApplication.cardStore as unknown as { persistenceWriter: unknown }).persistenceWriter).toBe(app.authority.writer);
    expect(existsSync(join(root, '.saivage', 'locks', 'runtime.lock'))).toBe(true);
    const publishedLock = parseRuntimeLockOwnerRecord(JSON.parse(readFileSync(join(root, '.saivage', 'locks', 'runtime.lock'), 'utf8')));
    expect(publishedLock.lock_state).toBe('bound');
    expect(publishedLock.control_endpoint).toEqual({ origin: `http://127.0.0.1:${(app.server.fastify.server.address() as { port: number }).port}`, auth: 'bearer' });
    expect(readFileSync(promptPath, 'utf8')).toBe('# Locked bootstrap prompt\n');
    await expect(startApp({ argv: ['node', 'saivage', 'start', '--create-runtime'], env: { SAIVAGE_PROJECT_ROOT: root, SAIVAGE_API_TOKEN: 'lock-test-token', SAIVAGE_PORT: '0' } })).rejects.toThrow(/Runtime lock is held/);

    await app.stop();
    apps.pop();
    expect(existsSync(join(root, '.saivage', 'locks', 'runtime.lock'))).toBe(false);
  });

  it('keeps plain start in normal mode and never bootstraps a missing root', async () => {
    const { root, promptPath } = makeDurableOnlyProject();
    await expect(startApp({
      argv: ['node', 'saivage', 'start'],
      env: { SAIVAGE_PROJECT_ROOT: root, SAIVAGE_API_TOKEN: 'lock-test-token', SAIVAGE_PORT: '0' },
    })).rejects.toThrow(/Cannot enumerate canonical project/);
    expect(isInitialized(root)).toBe(false);
    expect(existsSync(join(root, '.saivage', 'cards'))).toBe(false);
    expect(existsSync(join(root, '.saivage', 'locks', 'runtime.lock'))).toBe(false);
    expect(readFileSync(promptPath, 'utf8')).toBe('# Locked bootstrap prompt\n');
  });

  it('keeps --create-runtime in normal mode when canonical root evidence is malformed', async () => {
    const { root, promptPath } = makeDurableOnlyProject();
    const artifactPath = join(root, '.saivage', 'cards', 'project', 'card', 'versions', '1.json');
    mkdirSync(join(artifactPath, '..'), { recursive: true });
    writeFileSync(artifactPath, '{malformed canonical root');
    await expect(startApp({
      argv: ['node', 'saivage', 'start', '--create-runtime'],
      env: { SAIVAGE_PROJECT_ROOT: root, SAIVAGE_API_TOKEN: 'lock-test-token', SAIVAGE_PORT: '0' },
    })).rejects.toThrow(/Failed to parse JSON/);
    expect(readFileSync(artifactPath, 'utf8')).toBe('{malformed canonical root');
    expect(readFileSync(promptPath, 'utf8')).toBe('# Locked bootstrap prompt\n');
    expect(existsSync(join(root, '.saivage', 'state'))).toBe(false);
  });

  it('makes reset refuse without mutation while a real started app owns the same lock, then allows reset after stop', async () => {
    const { root } = makeDurableOnlyProject();
    const app = await startApp({
      argv: ['node', 'saivage', 'start', '--create-runtime'],
      env: { SAIVAGE_PROJECT_ROOT: root, SAIVAGE_API_TOKEN: 'lock-test-token', SAIVAGE_PORT: '0' },
    });
    apps.push(app);
    const runtimeStatePath = join(root, '.saivage', 'state', 'runtime.json');
    const before = readFileSync(runtimeStatePath, 'utf8');
    const cwd = process.cwd();
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      process.chdir(root);
      await expect(run(['node', 'cli', 'reset'])).rejects.toThrow(/Runtime lock is held/);
      expect(readFileSync(runtimeStatePath, 'utf8')).toBe(before);
      await app.stop();
      apps.pop();
      await run(['node', 'cli', 'reset']);
      expect(isInitialized(root)).toBe(true);
      expect(existsSync(join(root, '.saivage', 'locks', 'runtime.lock'))).toBe(false);
    } finally {
      log.mockRestore();
      process.chdir(cwd);
    }
  });
});
