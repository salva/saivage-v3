import { initProjectTree } from '../helpers/canonical-project.js';
import { describe, it, expect, afterEach } from '@jest/globals';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EnvironmentLoadError, loadEnvironment } from '../../src/config/environment.js';
import { startApp, type App } from '../../src/boot/index.js';

import { writeSaivageConfig } from '../helpers/project-config.js';

const roots: string[] = [];
const liveApps: App[] = [];

function makeProject(modelsSection: unknown, initializeProjectTree = false): string {
  const root = mkdtempSync(join(tmpdir(), 'saivage-boot-role-'));
  roots.push(root);
  if (initializeProjectTree) initProjectTree(root);
  else mkdirSync(join(root, '.saivage'), { recursive: true });
  const cfg = {
    models: modelsSection,
    providers: {},
  };
  writeSaivageConfig(root, cfg);
  return root;
}

afterEach(async () => {
  while (liveApps.length > 0) {
    const app = liveApps.pop();
    if (app) {
      try { await app.stop(); } catch { /* ignore */ }
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('boot fail-fast on missing dispatched model roles', () => {
  it('loadEnvironment throws EnvironmentLoadError naming every missing role', () => {
    const root = makeProject({});
    let thrown: unknown;
    try { loadEnvironment(['node', 'saivage', 'start'], { SAIVAGE_PROJECT_ROOT: root }); }
    catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(EnvironmentLoadError);
    const error = thrown as EnvironmentLoadError;
    expect(error.message).toMatch(/missing model role\(s\): planner, executor, reviewer, analyst/);
    expect(error.message).toMatch(/model name or a non-empty array/);
    expect(error.message).toContain('models.routing[');
    expect(error.message).toContain('models.profiles[');
    expect(error.message).toContain('models.default');
    expect(error.message).toContain('.saivage/saivage.yaml');
    expect(error.message).not.toContain('.saivage/saivage.json');
    expect(error.expected).toContain('model name or non-empty array');
    expect(error.expected).toContain('models.routing');
    expect(error.expected).toContain('models.default');
  });

  it('plain start rejects a missing canonical root before config loading or runtime initialization', async () => {
    const root = makeProject({});
    await expect(
      startApp({
        argv: ['node', 'saivage', 'start'],
        env: { SAIVAGE_PROJECT_ROOT: root, SAIVAGE_API_TOKEN: 'boot-test-token' },
      }),
    ).rejects.toThrow(/canonical project|Cannot enumerate/);
    expect(existsSync(join(root, '.saivage', 'events.jsonl'))).toBe(false);
  });

  it('startApp resolves and /api/runtime/status is reachable when models.default is set', async () => {
    const root = makeProject({ default: ['gpt-4.1'] }, true);
    const app = await startApp({
      argv: ['node', 'saivage', 'start'],
      env: {
        SAIVAGE_PROJECT_ROOT: root,
        SAIVAGE_API_TOKEN: 'boot-test-token',
        SAIVAGE_HOST: '127.0.0.1',
        SAIVAGE_PORT: '0',
      },
    });
    liveApps.push(app);
    expect(Object.isFrozen(app.environment)).toBe(true);
    const response = await app.server.fastify.inject({
      method: 'GET',
      url: '/api/runtime/status',
      headers: { authorization: 'Bearer boot-test-token' },
    });
    expect(response.statusCode).toBe(200);
  });
});
