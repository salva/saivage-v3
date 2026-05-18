/**
 * Tests for provider.ts — Provider, Account, Candidate, ProviderRegistry
 */

import { describe, it, expect } from '@jest/globals';
import {
  Provider,
  Account,
  ProviderRegistry,
  candidateKey,
  parseCandidateKey,
  type Candidate,
} from '../../src/agents/provider.js';
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
      autoDispatchBacklog: true,
      continuousImprovement: false, maxReviewRetries: 3, processTimeouts: { plannerMs: 1200000, executorMs: 1200000, reviewerMs: 1200000 },
      compactionThreshold: 0.8,
      maxCompactions: 3,
      compactionTimeoutMs: 1200000,
      compactionKeepFraction: 0.2,
      maxRecoveryRetries: 3,
      selfCheck: { executor: 15, planner: 30, analyst: 0 },
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

describe('candidateKey / parseCandidateKey', () => {
  it('should serialize and deserialize round-trip', () => {
    const c: Candidate = { provider: 'github', account: 'primary', model: 'gpt-5.5' };
    const key = candidateKey(c);
    expect(parseCandidateKey(key)).toEqual(c);
  });

  it('should handle null account', () => {
    const c: Candidate = { provider: 'opencode', account: null, model: 'kimi-k2.6' };
    const key = candidateKey(c);
    expect(key).toBe('opencode/_/kimi-k2.6');
    expect(parseCandidateKey(key)).toEqual(c);
  });

  it('should throw on invalid key', () => {
    expect(() => parseCandidateKey('invalid')).toThrow();
    expect(() => parseCandidateKey('a/b')).toThrow();
  });
});

describe('Account', () => {
  it('should report capability matching provider model set', () => {
    const acct = new Account('primary', { priority: 10 });
    const modelSet = new Set(['gpt-5.5', 'kimi-k2.6']);
    expect(acct.canServe('gpt-5.5', modelSet)).toBe(true);
    expect(acct.canServe('unknown', modelSet)).toBe(false);
  });

  it('should use account-specific model subset', () => {
    const acct = new Account('primary', {
      priority: 10,
      models: ['gpt-5.5'], // only gpt-5.5
    });
    const modelSet = new Set(['gpt-5.5', 'kimi-k2.6']);
    expect(acct.canServe('gpt-5.5', modelSet)).toBe(true);
    expect(acct.canServe('kimi-k2.6', modelSet)).toBe(false);
  });

  it('should compute effective API key (account overrides provider)', () => {
    const acct = new Account('primary', { priority: 10, apiKey: 'acct-key' });
    expect(acct.effectiveApiKey('provider-key')).toBe('acct-key');
    expect(acct.effectiveApiKey()).toBe('acct-key');
  });

  it('should compute effective base URL', () => {
    const acct = new Account('primary', { priority: 10, baseUrl: 'https://acct.example.com' });
    expect(acct.effectiveBaseUrl('https://provider.example.com')).toBe('https://acct.example.com');
    expect(acct.effectiveBaseUrl()).toBe('https://acct.example.com');
  });
});

describe('Provider', () => {
  it('should report which models it can serve', () => {
    const p = new Provider('github', {
      models: ['gpt-5.5', 'gpt-5.5-mini'],
      priority: 10,
    });
    expect(p.canServe('gpt-5.5')).toBe(true);
    expect(p.canServe('gpt-5.5-mini')).toBe(true);
    expect(p.canServe('claude-4')).toBe(false);
  });

  it('should build implicit account when no explicit accounts', () => {
    const p = new Provider('opencode', {
      models: ['kimi-k2.6'],
      apiKey: 'sk-123',
      priority: 20,
    });
    const accounts = p.getAllAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].name).toBe('_implicit');
  });

  it('should sort explicit accounts by priority', () => {
    const p = new Provider('github', {
      priority: 10,
      models: ['gpt-5.5'],
      accounts: {
        secondary: { priority: 20, apiKey: 'sk-2' },
        primary: { priority: 10, apiKey: 'sk-1' },
        tertiary: { priority: 30, apiKey: 'sk-3' },
      },
    });
    const accounts = p.getAccountsForModel('gpt-5.5');
    expect(accounts).toHaveLength(3);
    expect(accounts[0].name).toBe('primary');
    expect(accounts[1].name).toBe('secondary');
    expect(accounts[2].name).toBe('tertiary');
  });

  it('should return candidates for a model', () => {
    const p = new Provider('github', {
      priority: 10,
      models: ['gpt-5.5'],
      accounts: {
        primary: { priority: 10 },
        secondary: { priority: 20 },
      },
    });
    const candidates = p.getCandidatesForModel('gpt-5.5');
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toEqual({ provider: 'github', account: 'primary', model: 'gpt-5.5' });
    expect(candidates[1]).toEqual({ provider: 'github', account: 'secondary', model: 'gpt-5.5' });
  });

  it('should return implicit account candidates when no explicit accounts', () => {
    const p = new Provider('opencode', {
      models: ['kimi-k2.6'],
    });
    const candidates = p.getCandidatesForModel('kimi-k2.6');
    expect(candidates).toHaveLength(1);
    expect(candidates[0].account).toBeNull();
  });
});

describe('ProviderRegistry', () => {
  it('should sort providers by priority', () => {
    const cfg = mockConfig({
      providers: {
        high_priority: { priority: 10, models: ['m1'] },
        low_priority: { priority: 50, models: ['m1'] },
        medium_priority: { priority: 30, models: ['m1'] },
      },
    });
    const registry = new ProviderRegistry(cfg);
    const providers = registry.getAll();
    expect(providers[0].name).toBe('high_priority');
    expect(providers[1].name).toBe('medium_priority');
    expect(providers[2].name).toBe('low_priority');
  });

  it('should filter providers by model capability', () => {
    const cfg = mockConfig({
      providers: {
        a: { priority: 10, models: ['gpt-5.5'] },
        b: { priority: 20, models: ['kimi-k2.6'] },
        c: { priority: 30, models: ['gpt-5.5', 'kimi-k2.6'] },
      },
    });
    const registry = new ProviderRegistry(cfg);
    const gptProviders = registry.getProvidersForModel('gpt-5.5');
    expect(gptProviders).toHaveLength(2);
    expect(gptProviders[0].name).toBe('a');
    expect(gptProviders[1].name).toBe('c');
  });

  describe('health state', () => {
    it('should default to healthy', () => {
      const cfg = mockConfig({
        providers: {
          p1: { priority: 10, models: ['m1'] },
        },
      });
      const registry = new ProviderRegistry(cfg);
      const c: Candidate = { provider: 'p1', account: null, model: 'm1' };
      expect(registry.isHealthy(c)).toBe(true);
    });

    it('should enter cooldown on failure', () => {
      const cfg = mockConfig({
        providers: {
          p1: { priority: 10, models: ['m1'] },
        },
      });
      const registry = new ProviderRegistry(cfg);
      const c: Candidate = { provider: 'p1', account: null, model: 'm1' };
      registry.markFailed(c, 1000);
      expect(registry.isHealthy(c)).toBe(false);

      const health = registry.getHealth(c);
      expect(health.inCooldown).toBe(true);
      expect(health.failureCount).toBe(1);
    });

    it('should exit cooldown after delay expires', async () => {
      const cfg = mockConfig({
        providers: {
          p1: { priority: 10, models: ['m1'] },
        },
      });
      const registry = new ProviderRegistry(cfg);
      const c: Candidate = { provider: 'p1', account: null, model: 'm1' };
      registry.markFailed(c, 10); // 10ms cooldown
      expect(registry.isHealthy(c)).toBe(false);
      await new Promise((r) => setTimeout(r, 20));
      expect(registry.isHealthy(c)).toBe(true);
    });

    it('should clear failure state on success', () => {
      const cfg = mockConfig({
        providers: {
          p1: { priority: 10, models: ['m1'] },
        },
      });
      const registry = new ProviderRegistry(cfg);
      const c: Candidate = { provider: 'p1', account: null, model: 'm1' };
      registry.markFailed(c, 60000);
      expect(registry.isHealthy(c)).toBe(false);
      registry.markSucceeded(c);
      expect(registry.isHealthy(c)).toBe(true);
      expect(registry.getHealth(c).failureCount).toBe(0);
    });
  });
});
