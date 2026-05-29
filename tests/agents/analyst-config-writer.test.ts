/**
 * Tests for analyst-config-writer.setFailoverChain — F07: per-model failover
 * chains under `models.failover`, no root `failover`.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_ROOT = join(tmpdir(), `saivage-analyst-writer-test-${Date.now()}`);
const SAIVAGE_DIR = join(TEST_ROOT, '.saivage');
const CONFIG_PATH = join(SAIVAGE_DIR, 'saivage.json');

function setupConfig(json: Record<string, unknown>) {
  mkdirSync(SAIVAGE_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(json, null, 2), 'utf-8');
}

function cleanup() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true, force: true });
}

let setFailoverChain: typeof import('../../src/agents/analyst-config-writer.js').setFailoverChain;
let loadConfig: typeof import('../../src/agents/config-schema.js').loadConfig;

beforeAll(async () => {
  setFailoverChain = (await import('../../src/agents/analyst-config-writer.js')).setFailoverChain;
  loadConfig = (await import('../../src/agents/config-schema.js')).loadConfig;
});

beforeEach(() => cleanup());
afterEach(() => cleanup());

describe('analyst-config-writer.setFailoverChain', () => {
  it('writes the chain under models.failover (not root failover)', () => {
    setupConfig({
      models: { default: ['gpt-5.5', 'kimi-k2.6'] },
    });

    const result = setFailoverChain(TEST_ROOT, 'gpt-5.5', ['kimi-k2.6', 'deepseek-v4-pro']);
    expect(result.success).toBe(true);

    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as Record<string, unknown>;
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
});
