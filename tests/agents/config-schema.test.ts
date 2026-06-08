/**
 * Tests for config-schema.ts — loading and validating saivage.json
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
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
let saivageConfigSchema: typeof import('../../src/agents/config-schema.js').saivageConfigSchema;

beforeAll(async () => {
  const mod = await import('../../src/agents/config-schema.js');
  loadConfig = mod.loadConfig;
  getModelListForRole = mod.getModelListForRole;
  getRuntimeConfig = mod.getRuntimeConfig;
  saivageConfigSchema = mod.saivageConfigSchema;
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



    it('accepts the authoritative §13 persisted runtime keys and exposes the in-memory mirror', () => {
      setupConfig({
        models: { default: ['test'] },
        runtime: {
          continuous_improvement: true,
          max_review_retries: 7,
          process_timeouts: {
            planner_ms: 111,
            executor_ms: 222,
            reviewer_ms: 333,
          },
        },
      });

      const { config } = loadConfig(TEST_ROOT);
      expect(config.runtime.continuousImprovement).toBe(true);
      expect(config.runtime.maxReviewRetries).toBe(7);
      expect(config.runtime.processTimeouts).toEqual({ plannerMs: 111, executorMs: 222, reviewerMs: 333 });
    });

    it('rejects non-authoritative persisted camelCase runtime keys at the schema boundary', () => {
      const result = saivageConfigSchema.safeParse({
        models: { default: ['test'] },
        runtime: {
          continuousImprovement: true,
          maxReviewRetries: 7,
          processTimeouts: { plannerMs: 1, executorMs: 2, reviewerMs: 3 },
          recoveryDelayMs: 10,
          maxRecoveryRetries: 0,
        },
      });
      expect(result.success).toBe(false);
    });

    it('rejects removed operational runtime keys when persisted in snake_case without legacy migration', () => {
      setupConfig({
        models: { default: ['test'] },
        runtime: {
          continuous_improvement: true,
          recovery_delay_ms: 1000,
        },
      });

      expect(() => loadConfig(TEST_ROOT)).toThrow(/Configuration validation failed:[\s\S]*runtime: Unrecognized key/);
    });

    it('rejects unknown persisted runtime keys under strict validation', () => {
      setupConfig({
        models: { default: ['test'] },
        runtime: {
          continuous_improvement: true,
          mystery_runtime_key: true,
        },
      });

      expect(() => loadConfig(TEST_ROOT)).toThrow(/Configuration validation failed:[\s\S]*runtime: Unrecognized key/);
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
          continuous_improvement: true,
          max_review_retries: 4,
          process_timeouts: { planner_ms: 1000, executor_ms: 2000, reviewer_ms: 3000 },
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
      expect(config.runtime.maxReviewRetries).toBe(4);
      expect(config.runtime.processTimeouts).toEqual({ plannerMs: 1000, executorMs: 2000, reviewerMs: 3000 });
      expect(config.security.injectionScanner).toBe(false);
      expect(config.supervisor?.enabled).toBe(false);
      expect(config.telegram?.botToken).toBe('token123');
      expect(config.notifications?.channels).toEqual(['telegram', 'web']);
      expect(config.mcpServers?.test_server?.transport).toBe('stdio');
    });

    it('drops a role array byte-equal to models.default so the role inherits default', () => {
      const result = saivageConfigSchema.safeParse({
        models: {
          default: ['gpt-5.5', 'kimi-k2.6'],
          planner: ['gpt-5.5', 'kimi-k2.6'],
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect((result.data.models as Record<string, unknown>).planner).toBeUndefined();
        expect(result.data.models.default).toEqual(['gpt-5.5', 'kimi-k2.6']);
      }
    });

    it('accepts a role array that differs from models.default', () => {
      setupConfig({
        models: {
          default: ['gpt-5.5', 'kimi-k2.6', 'deepseek-v4-pro'],
          analyst: ['gpt-5.5', 'kimi-k2.6', 'glm-5.1'],
        },
      });
      const { config } = loadConfig(TEST_ROOT);
      expect(getModelListForRole(config, 'analyst')).toEqual(['gpt-5.5', 'kimi-k2.6', 'glm-5.1']);
    });

    it('returns models.default for a role without an explicit override', () => {
      setupConfig({
        models: { default: ['gpt-5.5', 'kimi-k2.6'] },
      });
      const { config } = loadConfig(TEST_ROOT);
      expect(getModelListForRole(config, 'planner')).toEqual(['gpt-5.5', 'kimi-k2.6']);
    });

    it('rejects models.default of length 0', () => {
      const result = saivageConfigSchema.safeParse({
        models: { default: [] },
      });
      expect(result.success).toBe(false);
    });

    it('rejects an empty per-role override array', () => {
      const result = saivageConfigSchema.safeParse({
        models: {
          default: ['gpt-5.5'],
          planner: [],
        },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues.find((i) => i.path.join('.') === 'models.planner');
        expect(issue?.message).toMatch(/empty array; remove the key to inherit models\.default/);
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
      expect(rt.continuousImprovement).toBe(false);
      expect(rt.maxReviewRetries).toBe(3);
      expect(rt.processTimeouts).toEqual({ plannerMs: 1200000, executorMs: 1200000, reviewerMs: 1200000 });
      expect(rt.recoveryDelayMs).toBe(60000);
      expect(rt.maxRecoveryRetries).toBe(3);
    });
  });
});

describe('provider capability schema', () => {
  it('accepts optional provider/account/model capability declarations without breaking legacy configs', () => {
    const result = saivageConfigSchema.safeParse({
      models: { default: ['gpt-5.5'] },
      providers: {
        'github-copilot': {
          models: ['gpt-5.5'],
          capabilities: { toolsMode: 'native' },
          modelCapabilities: {
            'gpt-5.5': { maxOutputTokens: 8192, quirks: ['large-context'] },
          },
          accounts: {
            primary: { capabilities: { exclusiveToolChoiceSupport: 'native' } },
          },
        },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.providers['github-copilot'].capabilities?.toolsMode).toBe('native');
      expect(result.data.providers['github-copilot'].accounts?.primary?.capabilities?.exclusiveToolChoiceSupport).toBe('native');
      expect(result.data.providers['github-copilot'].modelCapabilities?.['gpt-5.5']?.maxOutputTokens).toBe(8192);
    }
  });

  it('rejects invalid capability enum values at the config boundary', () => {
    const result = saivageConfigSchema.safeParse({
      models: { default: ['m1'] },
      providers: {
        p1: { models: ['m1'], capabilities: { toolsMode: 'sometimes' } },
      },
    });

    expect(result.success).toBe(false);
  });
});

describe('telegram notification recipient config', () => {
  it('accepts explicit outbound notificationChatIds separate from allowedUserIds', () => {
    const result = saivageConfigSchema.safeParse({
      models: { default: ['test'] },
      telegram: {
        botToken: '123456:TEST_TOKEN',
        allowedUserIds: [9001],
        notificationChatIds: [111111, -222222],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.telegram?.allowedUserIds).toEqual([9001]);
      expect(result.data.telegram?.notificationChatIds).toEqual([111111, -222222]);
    }
  });

  it('rejects invalid zero and unsafe outbound chat ids at schema boundary', () => {
    expect(saivageConfigSchema.safeParse({ models: { default: ['test'] }, telegram: { notificationChatIds: [0] } }).success).toBe(false);
    expect(saivageConfigSchema.safeParse({ models: { default: ['test'] }, telegram: { notificationChatIds: [Number.MAX_SAFE_INTEGER + 1] } }).success).toBe(false);
  });
});


describe('notification config strict enums', () => {
  it('accepts allowed notification channels, router severities, open categories, and default omission', () => {
    expect(saivageConfigSchema.safeParse({ models: { default: ['test'] } }).success).toBe(true);

    for (const channels of [['web'], ['telegram', 'web']] as const) {
      const result = saivageConfigSchema.safeParse({
        models: { default: ['test'] },
        notifications: {
          channels,
          filters: { min_severity: 'critical', categories: ['custom_category', 'goal_completed'] },
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.notifications?.channels).toEqual([...channels]);
        expect(result.data.notifications?.filters?.categories).toEqual(['custom_category', 'goal_completed']);
      }
    }

    for (const minSeverity of ['info', 'warning', 'error', 'critical'] as const) {
      expect(saivageConfigSchema.safeParse({
        models: { default: ['test'] },
        notifications: { channels: ['web'], filters: { min_severity: minSeverity } },
      }).success).toBe(true);
    }
  });

  it('rejects invalid notification channels and router severities at parse time with path-oriented safe errors', () => {
    for (const channel of ['email', 'telegrm', 'WEB', 123] as const) {
      const result = saivageConfigSchema.safeParse({
        models: { default: ['test'] },
        telegram: { botToken: '123456:TEST_TOKEN', notificationChatIds: [111111] },
        notifications: { channels: [channel], filters: { min_severity: 'info' } },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const text = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n');
        expect(text).toContain('notifications.channels.0');
        expect(text).not.toContain('123456:TEST_TOKEN');
        expect(text).not.toContain('111111');
      }
    }

    for (const minSeverity of ['warn', 'block', 'fatal', 'WARNING'] as const) {
      const result = saivageConfigSchema.safeParse({
        models: { default: ['test'] },
        notifications: { channels: ['web'], filters: { min_severity: minSeverity } },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const text = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n');
        expect(text).toContain('notifications.filters.min_severity');
      }
    }
  });

  it('preserves ARCH-014 telegram notificationChatIds separately from allowedUserIds and channel enablement', () => {
    const result = saivageConfigSchema.safeParse({
      models: { default: ['test'] },
      telegram: {
        botToken: '123456:TEST_TOKEN',
        allowedUserIds: [9001],
        notificationChatIds: [111111, -222222],
      },
      notifications: { channels: ['telegram'], filters: { min_severity: 'warning' } },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.notifications?.channels).toEqual(['telegram']);
      expect(result.data.telegram?.allowedUserIds).toEqual([9001]);
      expect(result.data.telegram?.notificationChatIds).toEqual([111111, -222222]);
    }
  });
});
