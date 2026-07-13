import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EnvironmentLoadError, loadEnvironment } from '../../src/config/environment.js';
import { writeSaivageConfig } from '../helpers/project-config.js';
import { createTestMutationComposition } from '../helpers/mutation-composition.js';

const roots: string[] = [];

function makeProject(config: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'saivage-env-test-'));
  roots.push(root);
  writeSaivageConfig(root, config);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('loadEnvironment', () => {
  it('loads validated config once with explicit precedence and deep-freezes the result', async () => {
    const root = makeProject({
      server: { host: '127.0.0.1', port: 1111 },
      models: { default: ['test-model'] },
      providers: { test: { models: ['test-model'], apiKey: '${TEST_PROVIDER_KEY}' } },
    });

    const env = await loadEnvironment(['node', 'saivage', 'start', '--host', 'localhost', '--port', '3333'], {
      SAIVAGE_PROJECT_ROOT: root,
      SAIVAGE_HOST: '0.0.0.0',
      SAIVAGE_PORT: '2222',
      SAIVAGE_API_TOKEN: 'token-for-test',
      TEST_PROVIDER_KEY: 'secret-provider-key',
      NODE_ENV: 'test',
      LOG_LEVEL: 'debug',
    }, createTestMutationComposition());

    expect(env.projectRoot).toBe(root);
    expect(env.server.host).toBe('localhost');
    expect(env.server.port).toBe(3333);
    expect(env.server.logLevel).toBe('debug');
    expect(env.nodeEnv).toBe('test');
    expect(env.auth.apiToken).toBe('token-for-test');
    expect(env.config.providers.test.apiKey).toBe('secret-provider-key');
    expect(Object.isFrozen(env)).toBe(true);
    expect(Object.isFrozen(env.server)).toBe(true);
    expect(() => { (env.server as { port: number }).port = 9999; }).toThrow();
  });

  it('fails closed on malformed env port', async () => {
    const root = makeProject({ models: { default: ['test-model'] } });
    await expect(loadEnvironment(['node', 'saivage', 'start'], { SAIVAGE_PROJECT_ROOT: root, SAIVAGE_PORT: 'not-a-port' }, createTestMutationComposition())).rejects.toThrow(EnvironmentLoadError);
  });

  it('fails closed on malformed config without logging secret values in the message', async () => {
    const root = makeProject({
      models: { default: ['test-model'] },
      notifications: { channels: ['email'] },
      providers: { test: { apiKey: 'super-secret-value', models: ['test-model'] } },
    });

    await expect(loadEnvironment(['node', 'saivage', 'start'], { SAIVAGE_PROJECT_ROOT: root }, createTestMutationComposition())).rejects.toThrow(/Configuration validation failed/);
    try {
      await loadEnvironment(['node', 'saivage', 'start'], { SAIVAGE_PROJECT_ROOT: root }, createTestMutationComposition());
    } catch (err) {
      expect(String((err as Error).message)).not.toContain('super-secret-value');
    }
  });

  it('fails closed on removed config keys', async () => {
    for (const removed of [
      { supervisor: { enabled: false } },
      { rag: {} },
      { notifications: { channels: ['web'], filters: { min_severity: 'warning' } } },
    ]) {
      const root = makeProject({ models: { default: ['test-model'] }, ...removed });
      await expect(loadEnvironment(['node', 'saivage', 'start'], { SAIVAGE_PROJECT_ROOT: root }, createTestMutationComposition())).rejects.toThrow(/Configuration validation failed/);
    }
  });
});
