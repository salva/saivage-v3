import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EnvironmentLoadError, loadEnvironment } from '../../src/config/environment.js';

const roots: string[] = [];

function makeProject(config: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'saivage-env-test-'));
  roots.push(root);
  mkdirSync(join(root, '.saivage'), { recursive: true });
  writeFileSync(join(root, '.saivage', 'saivage.json'), JSON.stringify(config, null, 2), 'utf-8');
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('loadEnvironment', () => {
  it('loads validated config once with explicit precedence and deep-freezes the result', () => {
    const root = makeProject({
      server: { host: '127.0.0.1', port: 1111 },
      models: { default: ['test-model'] },
      providers: { test: { models: ['test-model'], apiKey: '${TEST_PROVIDER_KEY}' } },
    });

    const env = loadEnvironment(['node', 'saivage', 'start', '--host', 'localhost', '--port', '3333'], {
      SAIVAGE_PROJECT_ROOT: root,
      SAIVAGE_HOST: '0.0.0.0',
      SAIVAGE_PORT: '2222',
      SAIVAGE_API_TOKEN: 'token-for-test',
      TEST_PROVIDER_KEY: 'secret-provider-key',
      NODE_ENV: 'test',
      LOG_LEVEL: 'debug',
    });

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

  it('fails closed on malformed env port', () => {
    const root = makeProject({ models: { default: ['test-model'] } });
    expect(() => loadEnvironment(['node', 'saivage', 'start'], { SAIVAGE_PROJECT_ROOT: root, SAIVAGE_PORT: 'not-a-port' })).toThrow(EnvironmentLoadError);
  });

  it('fails closed on malformed config without logging secret values in the message', () => {
    const root = makeProject({
      models: { default: ['test-model'] },
      notifications: { channels: ['email'] },
      providers: { test: { apiKey: 'super-secret-value', models: ['test-model'] } },
    });

    expect(() => loadEnvironment(['node', 'saivage', 'start'], { SAIVAGE_PROJECT_ROOT: root })).toThrow(/Configuration validation failed/);
    try {
      loadEnvironment(['node', 'saivage', 'start'], { SAIVAGE_PROJECT_ROOT: root });
    } catch (err) {
      expect(String((err as Error).message)).not.toContain('super-secret-value');
    }
  });
});
