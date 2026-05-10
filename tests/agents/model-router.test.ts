/**
 * Tests for model-router.ts — Model routing and candidate chain resolution
 */

import { describe, it, expect } from '@jest/globals';
import { ModelRouter } from '../../src/agents/model-router.js';
import { ProviderRegistry } from '../../src/agents/provider.js';
import type { SaivageConfig } from '../../src/agents/config-schema.js';

function mockConfig(overrides: Partial<SaivageConfig> = {}): SaivageConfig {
  return {
    models: { default: ['test-model'] },
    providers: {},
    server: { port: 8080, host: '0.0.0.0' },
    runtime: {
      recoverAgentInvocations: true,
      healthCheckIntervalMs: 30000,
      idleShutdownMs: 300000,
      maxGoalDepth: 5,
      recoveryDelayMs: 60000,
      continuousImprovement: false,
      compactionThreshold: 0.8,
      maxCompactions: 3,
      compactionTimeoutMs: 1200000,
      compactionKeepFraction: 0.2,
      maxRecoveryRetries: 3,
    },
    security: {
      injectionScanner: true,
      maxScanLengthBytes: 102400,
    },
    supervisor: {
      enabled: true,
      intervalMs: 1200000,
      consecutiveStuckVerdicts: 3,
      logLines: 400,
    },
    ...overrides,
  };
}

describe('ModelRouter', () => {
  describe('resolve', () => {
    it('should resolve a role to ordered candidates', () => {
      const cfg = mockConfig({
        models: {
          planner: ['gpt-5.5', 'kimi-k2.6'],
        },
        providers: {
          github: {
            priority: 10,
            models: ['gpt-5.5'],
            accounts: {
              primary: { priority: 10 },
              secondary: { priority: 20 },
            },
          },
          opencode: {
            priority: 20,
            models: ['kimi-k2.6'],
          },
        },
      });
      const registry = new ProviderRegistry(cfg);
      const router = new ModelRouter(cfg, registry);

      const chain = router.resolve('planner');
      // Should be: github/primary/gpt-5.5, github/secondary/gpt-5.5, opencode/_/kimi-k2.6
      expect(chain.length).toBeGreaterThanOrEqual(3);
      expect(chain[0]).toEqual({ provider: 'github', account: 'primary', model: 'gpt-5.5' });
      expect(chain[1]).toEqual({ provider: 'github', account: 'secondary', model: 'gpt-5.5' });
      expect(chain[2].model).toBe('kimi-k2.6');
    });

    it('should skip providers/accounts in cooldown', () => {
      const cfg = mockConfig({
        models: { planner: ['gpt-5.5'] },
        providers: {
          github: {
            priority: 10,
            models: ['gpt-5.5'],
            accounts: { primary: { priority: 10 } },
          },
          opencode: {
            priority: 20,
            models: ['gpt-5.5'],
          },
        },
      });
      const registry = new ProviderRegistry(cfg);
      // Mark github candidate as failed
      registry.markFailed(
        { provider: 'github', account: 'primary', model: 'gpt-5.5' },
        60000,
      );
      const router = new ModelRouter(cfg, registry);

      const chain = router.resolve('planner');
      // github/primary is in cooldown — should skip to opencode
      expect(chain).toHaveLength(1);
      expect(chain[0].provider).toBe('opencode');
    });

    it('should advance to next model only after all candidates for current model exhausted', () => {
      const cfg = mockConfig({
        models: { planner: ['gpt-5.5', 'kimi-k2.6'] },
        providers: {
          github: {
            priority: 10,
            models: ['gpt-5.5'],
          },
          opencode: {
            priority: 20,
            models: ['kimi-k2.6'],
          },
        },
      });
      const registry = new ProviderRegistry(cfg);
      // Mark github (only provider for gpt-5.5) as failed
      registry.markFailed(
        { provider: 'github', account: null, model: 'gpt-5.5' },
        60000,
      );
      const router = new ModelRouter(cfg, registry);

      const chain = router.resolve('planner');
      // gpt-5.5 has no healthy candidates → advance to kimi-k2.6
      expect(chain).toHaveLength(1);
      expect(chain[0].model).toBe('kimi-k2.6');
      expect(chain[0].provider).toBe('opencode');
    });

    it('should try model equivalents after exhausting all candidates', () => {
      const cfg = mockConfig({
        models: {
          planner: ['gpt-5.5'],
          equivalents: [['gpt-5.5', 'claude-sonnet-4']],
        },
        providers: {
          github: {
            priority: 10,
            models: ['gpt-5.5'],
          },
          anthropic: {
            priority: 20,
            models: ['claude-sonnet-4'],
          },
        },
      });
      const registry = new ProviderRegistry(cfg);
      // Mark all gpt-5.5 candidates as failed
      registry.markFailed(
        { provider: 'github', account: null, model: 'gpt-5.5' },
        60000,
      );
      const router = new ModelRouter(cfg, registry);

      const chain = router.resolve('planner');
      // Should try claude-sonnet-4 as equivalent
      expect(chain.length).toBeGreaterThan(0);
      expect(chain[0].model).toBe('claude-sonnet-4');
    });

    it('should try failover chains after equivalents', () => {
      const cfg = mockConfig({
        models: {
          planner: ['gpt-5.5'],
          failover: { 'gpt-5.5': ['deepseek-v4-pro'] },
        },
        providers: {
          github: {
            priority: 10,
            models: ['gpt-5.5'],
          },
          opencode: {
            priority: 20,
            models: ['deepseek-v4-pro'],
          },
        },
      });
      const registry = new ProviderRegistry(cfg);
      registry.markFailed(
        { provider: 'github', account: null, model: 'gpt-5.5' },
        60000,
      );
      const router = new ModelRouter(cfg, registry);

      const chain = router.resolve('planner');
      // Should try deepseek-v4-pro via failover
      expect(chain.length).toBeGreaterThan(0);
      expect(chain[0].model).toBe('deepseek-v4-pro');
    });

    it('should use routing profiles when configured', () => {
      const cfg = mockConfig({
        models: {
          profiles: {
            heavy: {
              preferred: ['gpt-5.5'],
              allowed: ['kimi-k2.6'],
            },
          },
          routing: { planner: 'heavy' },
        },
        providers: {
          github: { priority: 10, models: ['gpt-5.5'] },
          opencode: { priority: 20, models: ['kimi-k2.6'] },
        },
      });
      const registry = new ProviderRegistry(cfg);
      const router = new ModelRouter(cfg, registry);

      const chain = router.resolve('planner');
      expect(chain).toHaveLength(2);
      expect(chain[0].model).toBe('gpt-5.5');
      expect(chain[1].model).toBe('kimi-k2.6');
    });

    it('should return empty chain if no providers can serve any model', () => {
      const cfg = mockConfig({
        models: { planner: ['nonexistent-model'] },
        providers: {
          github: { priority: 10, models: ['gpt-5.5'] },
        },
      });
      const registry = new ProviderRegistry(cfg);
      const router = new ModelRouter(cfg, registry);

      const chain = router.resolve('planner');
      expect(chain).toHaveLength(0);
    });

    it('should support top-level failover key', () => {
      const cfg = mockConfig({
        models: {
          planner: ['gpt-5.5'],
        },
        failover: {
          'gpt-5.5': ['deepseek-v4-pro'],
        },
        providers: {
          github: { priority: 10, models: ['gpt-5.5'] },
          opencode: { priority: 20, models: ['deepseek-v4-pro'] },
        },
      });
      const registry = new ProviderRegistry(cfg);
      registry.markFailed(
        { provider: 'github', account: null, model: 'gpt-5.5' },
        60000,
      );
      const router = new ModelRouter(cfg, registry);

      const chain = router.resolve('planner');
      expect(chain.length).toBeGreaterThan(0);
      expect(chain[0].model).toBe('deepseek-v4-pro');
    });
  });

  describe('nextCandidate', () => {
    it('should return the first healthy candidate', () => {
      const cfg = mockConfig({
        models: { planner: ['gpt-5.5'] },
        providers: {
          github: { priority: 10, models: ['gpt-5.5'] },
        },
      });
      const registry = new ProviderRegistry(cfg);
      const router = new ModelRouter(cfg, registry);

      const c = router.nextCandidate('planner');
      expect(c).not.toBeNull();
      expect(c!.model).toBe('gpt-5.5');
    });

    it('should return null if no candidates available', () => {
      const cfg = mockConfig({
        models: { planner: ['gpt-5.5'] },
        providers: {
          github: { priority: 10, models: ['gpt-5.5'] },
        },
      });
      const registry = new ProviderRegistry(cfg);
      registry.markFailed(
        { provider: 'github', account: null, model: 'gpt-5.5' },
        60000,
      );
      const router = new ModelRouter(cfg, registry);

      const c = router.nextCandidate('planner');
      expect(c).toBeNull();
    });
  });
});
