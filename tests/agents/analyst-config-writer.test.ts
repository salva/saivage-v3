/**
 * Tests for analyst-config-writer.setFailoverChain — F07: per-model failover
 * chains under `models.failover`, no root `failover`.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as YAML from 'yaml';

const TEST_ROOT = join(tmpdir(), `saivage-analyst-writer-test-${Date.now()}`);
const SAIVAGE_DIR = join(TEST_ROOT, '.saivage');
const CONFIG_PATH = join(SAIVAGE_DIR, 'saivage.yaml');
const LEGACY_CONFIG_PATH = join(SAIVAGE_DIR, 'saivage.json');

function setupConfig(json: Record<string, unknown>) {
  mkdirSync(SAIVAGE_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, YAML.stringify(json), 'utf-8');
}

function setupYamlConfig(yaml: string) {
  mkdirSync(SAIVAGE_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, yaml, 'utf-8');
}

function cleanup() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true, force: true });
}

let setFailoverChain: typeof import('../../src/agents/analyst-config-writer.js').setFailoverChain;
let loadEnvironment: typeof import('../../src/config/environment.js').loadEnvironment;

beforeAll(async () => {
  setFailoverChain = (await import('../../src/agents/analyst-config-writer.js')).setFailoverChain;
  loadEnvironment = (await import('../../src/config/environment.js')).loadEnvironment;
});

beforeEach(() => cleanup());
afterEach(() => cleanup());

function loadConfig(projectRoot: string) {
  return { config: loadEnvironment(['node', 'test', '--project-root', projectRoot], process.env).config };
}

describe('analyst-config-writer.setFailoverChain', () => {
  it('writes the chain under models.failover (not root failover)', () => {
    setupConfig({
      models: { default: ['gpt-5.5', 'kimi-k2.6'] },
    });

    const result = setFailoverChain(TEST_ROOT, 'gpt-5.5', ['kimi-k2.6', 'deepseek-v4-pro']);
    expect(result.success).toBe(true);

    const raw = YAML.parse(readFileSync(CONFIG_PATH, 'utf-8')) as Record<string, unknown>;
    expect(raw.failover).toBeUndefined();
    const models = raw.models as Record<string, unknown>;
    expect(models.failover).toEqual({ 'gpt-5.5': ['kimi-k2.6', 'deepseek-v4-pro'] });
  });

  it('round-trips through loadConfig and surfaces the chain on models.failover', () => {
    setupConfig({
      models: { default: ['gpt-5.5'] },
    });

    const result = setFailoverChain(TEST_ROOT, 'gpt-5.5', ['kimi-k2.6']);
    expect(result.success).toBe(true);

    const { config } = loadConfig(TEST_ROOT);
    expect(config.models.failover).toEqual({ 'gpt-5.5': ['kimi-k2.6'] });
    expect((config as Record<string, unknown>).failover).toBeUndefined();
  });

  it('preserves comments, ordering, and prompts block scalars while writing YAML only', () => {
    setupYamlConfig(`# operator comment\nmodels:\n  default:\n    - gpt-5.5\nprompts:\n  planner: |\n    Keep this prompt as a block scalar.\n    It contains ${'${HOME}'} literally.\nserver:\n  host: 127.0.0.1\n  port: 8080\n`);

    const result = setFailoverChain(TEST_ROOT, 'gpt-5.5', ['kimi-k2.6']);
    expect(result.success).toBe(true);

    const content = readFileSync(CONFIG_PATH, 'utf-8');
    expect(content).toContain('# operator comment');
    expect(content).toContain('models:');
    expect(content.indexOf('models:')).toBeLessThan(content.indexOf('prompts:'));
    expect(content.indexOf('prompts:')).toBeLessThan(content.indexOf('server:'));
    expect(content).toContain('planner: |');
    expect(content).toContain('It contains ${HOME} literally.');
    expect(content).toContain('failover:');
    expect(existsSync(LEGACY_CONFIG_PATH)).toBe(false);
  });
});
