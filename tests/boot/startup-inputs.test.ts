import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadEnvironment, type StartInputs } from '../../src/config/environment.js';
import { replaceConfigYaml } from '../../src/config/config-file.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';

const originalCwd = process.cwd();
const roots: string[] = [];

function rootWithConfig(host = 'config.example', port = 8123): string {
  const root = mkdtempSync(join(tmpdir(), 'saivage-start-inputs-'));
  roots.push(root);
  replaceConfigYaml(join(root, '.saivage', 'saivage.yaml'), {
    ...structuredClone(TEST_SAIVAGE_CONFIG), server: { host, port },
  });
  return root;
}

function inputs(projectRoot?: string, overrides: Partial<StartInputs> = {}): StartInputs {
  return { projectRoot, createRuntime: false, ...overrides };
}

afterEach(() => {
  process.chdir(originalCwd);
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('typed startup input precedence', () => {
  it('selects project root as CLI, then environment, then cwd', async () => {
    const cliRoot = rootWithConfig();
    const envRoot = rootWithConfig();
    const cwdRoot = rootWithConfig();
    process.chdir(cwdRoot);

    await expect(loadEnvironment(inputs(cliRoot), { SAIVAGE_PROJECT_ROOT: envRoot })).resolves.toMatchObject({ projectRoot: cliRoot });
    await expect(loadEnvironment(inputs(), { SAIVAGE_PROJECT_ROOT: envRoot })).resolves.toMatchObject({ projectRoot: envRoot });
    await expect(loadEnvironment(inputs(), {})).resolves.toMatchObject({ projectRoot: cwdRoot });
  });

  it('selects config as CLI, then environment, then the selected-root default', async () => {
    const root = rootWithConfig('default.example');
    const cliConfigRoot = rootWithConfig('cli-config.example');
    const envConfigRoot = rootWithConfig('env-config.example');
    const cliConfig = join(cliConfigRoot, '.saivage', 'saivage.yaml');
    const envConfig = join(envConfigRoot, '.saivage', 'saivage.yaml');

    await expect(loadEnvironment(inputs(root, { config: cliConfig }), { SAIVAGE_CONFIG: envConfig })).resolves.toMatchObject({ server: { host: 'cli-config.example' } });
    await expect(loadEnvironment(inputs(root), { SAIVAGE_CONFIG: envConfig })).resolves.toMatchObject({ server: { host: 'env-config.example' } });
    await expect(loadEnvironment(inputs(root), {})).resolves.toMatchObject({ server: { host: 'default.example' } });
    await expect(loadEnvironment(inputs(root), { SAIVAGE_CONFIG: join(root, 'missing.yaml') })).rejects.toMatchObject({ field: 'config', source: 'file' });
  });

  it('selects host as CLI, then environment, then config', async () => {
    const root = rootWithConfig('config.example');
    await expect(loadEnvironment(inputs(root, { host: 'cli.example' }), { SAIVAGE_HOST: 'env.example' })).resolves.toMatchObject({ server: { host: 'cli.example' } });
    await expect(loadEnvironment(inputs(root), { SAIVAGE_HOST: 'env.example' })).resolves.toMatchObject({ server: { host: 'env.example' } });
    await expect(loadEnvironment(inputs(root), {})).resolves.toMatchObject({ server: { host: 'config.example' } });
  });

  it('selects port as CLI, then environment, then config and validates only the selected raw value', async () => {
    const root = rootWithConfig('config.example', 8123);
    await expect(loadEnvironment(inputs(root, { port: '0' }), { SAIVAGE_PORT: 'malformed' })).resolves.toMatchObject({ server: { port: 0 } });
    await expect(loadEnvironment(inputs(root), { SAIVAGE_PORT: '8124' })).resolves.toMatchObject({ server: { port: 8124 } });
    await expect(loadEnvironment(inputs(root), {})).resolves.toMatchObject({ server: { port: 8123 } });

    await expect(loadEnvironment(inputs(root), { SAIVAGE_PORT: 'malformed' })).rejects.toMatchObject({ field: 'server.port', source: 'env' });
    await expect(loadEnvironment(inputs(root, { port: 'malformed' }), { SAIVAGE_PORT: '8124' })).rejects.toMatchObject({ field: 'server.port', source: 'cli' });
  });

  it('does not validate shadowed lower-priority root or config values', async () => {
    const root = rootWithConfig();
    const config = join(root, '.saivage', 'saivage.yaml');
    await expect(loadEnvironment(inputs(root, { config }), {
      SAIVAGE_PROJECT_ROOT: join(root, 'missing-root'),
      SAIVAGE_CONFIG: join(root, 'missing-config.yaml'),
    })).resolves.toMatchObject({ projectRoot: root });
    await expect(loadEnvironment(inputs(), { SAIVAGE_PROJECT_ROOT: join(root, 'missing-root') })).rejects.toThrow();
  });

  it('uses the built-in host and port defaults when the selected config omits the server section', async () => {
    const root = rootWithConfig();
    const { server: _server, ...configWithoutServer } = structuredClone(TEST_SAIVAGE_CONFIG);
    replaceConfigYaml(join(root, '.saivage', 'saivage.yaml'), configWithoutServer);
    await expect(loadEnvironment(inputs(root), {})).resolves.toMatchObject({ server: { host: '0.0.0.0', port: 8080 } });
  });

  it('keeps NODE_ENV, LOG_LEVEL, and SAIVAGE_API_TOKEN as independent environment-only inputs', async () => {
    const root = rootWithConfig();
    await expect(loadEnvironment(inputs(root), {
      NODE_ENV: 'test', LOG_LEVEL: 'debug', SAIVAGE_API_TOKEN: 'startup-token',
    })).resolves.toMatchObject({ nodeEnv: 'test', server: { logLevel: 'debug' }, auth: { apiToken: 'startup-token', devModeAuthDisabled: false } });
  });
});
