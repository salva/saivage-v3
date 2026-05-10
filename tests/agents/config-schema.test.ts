/**
 * Tests for config-schema.ts — loading and validating saivage.json
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_ROOT = join(tmpdir(), `saivage-config-test-${Date.now()}`);
const SAIVAGE_DIR = join(TEST_ROOT, '.saivage');
const CONFIG_PATH = join(SAIVAGE_DIR, 'saivage.json');

function setupConfig(json: Record<string, unknown>) {
  mkdirSync(SAIVAGE_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(json, null, 2), 'utf-8');
}

function cleanup() {
  if (existsSync(TEST_ROOT)) {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  }
}

// We need to import after setup since it's ESM
let loadConfig: typeof import('../../src/agents/config-schema.js').loadConfig;
let getModelListForRole: typeof import('../../src/agents/config-schema.js').getModelListForRole;
let getRuntimeConfig: typeof import('../../src/agents/config-schema.js').getRuntimeConfig;

beforeAll(async () => {
  const mod = await import('../../src/agents/config-schema.js');
  loadConfig = mod.loadConfig;
  getModelListForRole = mod.getModelListForRole;
  getRuntimeConfig = mod.getRuntimeConfig;
});

beforeEach(() => cleanup());
afterEach(() => cleanup());

describe('config-schema', () => {
  describe('loadConfig', () => {
    it('should load a minimal valid config', () => {
      setupConfig({
        models: { default: ['test-model'] },
      });

      const { config, warnings } = loadConfig(TEST_ROOT);
      expect(config.models.default).toEqual(['test-model']);
      expect(warnings).toEqual([]);
    });

    it('should throw on missing config file', () => {
      expect(() => loadConfig(TEST_ROOT)).toThrow(/Configuration not found/);
    });

    it('should throw on invalid JSON', () => {
      mkdirSync(SAIVAGE_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, 'not json', 'utf-8');
      expect(() => loadConfig(TEST_ROOT)).toThrow(/Failed to parse/);
    });

    it('should throw on validation failures', () => {
      setupConfig({
        models: { default: 123 },
      });
      expect(() => loadConfig(TEST_ROOT)).toThrow(/Configuration validation failed/);
    });

    it('should normalize single string model list to array', () => {
      setupConfig({
        models: { planner: 'gpt-5.5', default: ['fallback'] },
      });

      const { config } = loadConfig(TEST_ROOT);
      expect(config.models.planner).toEqual(['gpt-5.5']);
    });

    it('should apply defaults for missing sections', () => {
      setupConfig({
        models: { default: ['test'] },
      });

      const { config } = loadConfig(TEST_ROOT);
      expect(config.server.port).toBe(8080);
      expect(config.server.host).toBe('0.0.0.0');
      expect(config.runtime.recoveryDelayMs).toBe(60000);
      expect(config.runtime.maxGoalDepth).toBe(5);
      expect(config.security.injectionScanner).toBe(true);
    });

    it('should parse all sections', () => {
      setupConfig({
        models: {
          planner: ['gpt-5.5', 'kimi-k2.6'],
          executor: ['kimi-k2.6'],
          reviewer: ['gpt-5.5'],
          default: ['deepseek-v4-flash'],
          profiles: {
            heavy: { preferred: ['gpt-5.5'], allowed: ['deepseek-v4-pro'] },
          },
          routing: { planner: 'heavy' },
          equivalents: [['claude-sonnet-4', 'gpt-4o']],
          failover: { 'gpt-5.5': ['kimi-k2.6'] },
        },
        providers: {
          github: {
            priority: 10,
            models: ['gpt-5.5'],
            accounts: {
              primary: { priority: 10, apiKey: 'key1' },
              secondary: { priority: 20, apiKey: 'key2' },
            },
          },
        },
        server: { port: 3000, host: '127.0.0.1' },
        runtime: {
          recoveryDelayMs: 30000,
          maxGoalDepth: 3,
          continuousImprovement: true,
        },
        security: { injectionScanner: false },
        supervisor: { enabled: false },
        telegram: { botToken: 'token123', allowedUserIds: [123] },
        notifications: { channels: ['telegram', 'web'] },
        mcpServers: {
          test_server: { command: 'npx', args: ['-y', 'test'], transport: 'stdio' },
        },
      });

      const { config } = loadConfig(TEST_ROOT);
      expect(config.models.planner).toEqual(['gpt-5.5', 'kimi-k2.6']);
      expect(config.models.profiles?.heavy.preferred).toEqual(['gpt-5.5']);
      expect(config.models.routing?.planner).toBe('heavy');
      expect(config.models.equivalents).toHaveLength(1);
      expect(config.models.failover?.['gpt-5.5']).toEqual(['kimi-k2.6']);
      expect(config.providers.github.priority).toBe(10);
      expect(config.providers.github.accounts?.primary?.priority).toBe(10);
      expect(config.server.port).toBe(3000);
      expect(config.runtime.recoveryDelayMs).toBe(30000);
      expect(config.runtime.maxGoalDepth).toBe(3);
      expect(config.security.injectionScanner).toBe(false);
      expect(config.supervisor?.enabled).toBe(false);
      expect(config.telegram?.botToken).toBe('token123');
      expect(config.notifications?.channels).toEqual(['telegram', 'web']);
      expect(config.mcpServers?.test_server?.transport).toBe('stdio');
    });

    it('should include failover from top-level key', () => {
      setupConfig({
        models: { default: ['deepseek-v4-flash'] },
        failover: {
          'kimi-k2.6': ['deepseek-v4-pro'],
        },
      });

      const { config } = loadConfig(TEST_ROOT);
      expect(config.failover).toBeDefined();
      if (config.failover) {
        expect(config.failover['kimi-k2.6']).toEqual(['deepseek-v4-pro']);
      }
    });
  });

  describe('env interpolation', () => {
    it('should resolve ${ENV_VAR} references', () => {
      process.env.TEST_API_KEY = 'secret-123';
      setupConfig({
        models: { default: ['test'] },
        providers: {
          opencode: {
            models: ['kimi-k2.6'],
            apiKey: '${TEST_API_KEY}',
          },
        },
      });

      const { config, warnings } = loadConfig(TEST_ROOT);
      expect(config.providers.opencode.apiKey).toBe('secret-123');
      expect(warnings).toEqual([]);
      delete process.env.TEST_API_KEY;
    });

    it('should warn on undefined env vars', () => {
      delete process.env.NONEXISTENT_VAR;
      setupConfig({
        models: { default: ['test'] },
        providers: {
          opencode: {
            models: ['kimi-k2.6'],
            apiKey: '${NONEXISTENT_VAR}',
          },
        },
      });

      const { config, warnings } = loadConfig(TEST_ROOT);
      expect(config.providers.opencode.apiKey).toBe('');
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0]).toContain('NONEXISTENT_VAR');
    });
  });

  describe('getModelListForRole', () => {
    it('should return direct model list for a role', () => {
      setupConfig({
        models: {
          planner: ['gpt-5.5'],
          default: ['fallback'],
        },
      });
      const { config } = loadConfig(TEST_ROOT);
      const list = getModelListForRole(config, 'planner');
      expect(list).toEqual(['gpt-5.5']);
    });

    it('should fall back to default if role not configured', () => {
      setupConfig({
        models: { default: ['fallback'] },
      });
      const { config } = loadConfig(TEST_ROOT);
      const list = getModelListForRole(config, 'unknown-role');
      expect(list).toEqual(['fallback']);
    });

    it('should resolve routing profiles', () => {
      setupConfig({
        models: {
          profiles: {
            heavy: { preferred: ['gpt-5.5'], allowed: ['deepseek-v4-pro'] },
          },
          routing: { planner: 'heavy' },
          default: ['fallback'],
        },
      });
      const { config } = loadConfig(TEST_ROOT);
      const list = getModelListForRole(config, 'planner');
      expect(list).toEqual(['gpt-5.5', 'deepseek-v4-pro']);
    });

    it('should throw if no default and no matching role', () => {
      setupConfig({
        models: {},
      });
      const { config } = loadConfig(TEST_ROOT);
      expect(() => getModelListForRole(config, 'planner')).toThrow(/No model list configured/);
    });
  });

  describe('getRuntimeConfig', () => {
    it('should return runtime section with defaults', () => {
      setupConfig({ models: { default: ['test'] } });
      const { config } = loadConfig(TEST_ROOT);
      const rt = getRuntimeConfig(config);
      expect(rt.recoveryDelayMs).toBe(60000);
      expect(rt.maxGoalDepth).toBe(5);
      expect(rt.compactionThreshold).toBe(0.8);
      expect(rt.maxCompactions).toBe(3);
      expect(rt.maxRecoveryRetries).toBe(3);
    });
  });
});
