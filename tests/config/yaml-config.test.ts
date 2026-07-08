import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadEnvironment } from '../../src/config/environment.js';
import { writeSaivageConfig } from '../helpers/project-config.js';

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'saivage-yaml-config-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('YAML project config loading', () => {
  it('loads .saivage/saivage.yaml', () => {
    const root = makeRoot();
    writeSaivageConfig(root, 'models:\n  default: [test-model]\nserver:\n  host: 127.0.0.1\n  port: 9090\n');
    const env = loadEnvironment(['node', 'saivage', 'start'], { SAIVAGE_PROJECT_ROOT: root, NODE_ENV: 'test' });
    expect(env.configPath).toBe(join(root, '.saivage', 'saivage.yaml'));
    expect(env.server.host).toBe('127.0.0.1');
    expect(env.server.port).toBe(9090);
  });

  it('interpolates non-prompts YAML values', () => {
    const root = makeRoot();
    writeSaivageConfig(root, 'models:\n  default: ["${TEST_MODEL}"]\nproviders:\n  default:\n    apiKey: "${TEST_API_KEY}"\n    models: ["${TEST_MODEL}"]\n');
    const env = loadEnvironment(['node', 'saivage', 'start'], { SAIVAGE_PROJECT_ROOT: root, TEST_MODEL: 'model-a', TEST_API_KEY: 'key-a', NODE_ENV: 'test' });
    expect(env.config.models.default).toEqual(['model-a']);
    expect(env.config.providers.default.apiKey).toBe('key-a');
  });
});
