/**
 * Tests for model-router.ts — Model routing and candidate chain resolution
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

// ── Auth profile test helpers ─────────────────────────────────

let testRoots: string[] = [];

function makeProjectRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'saivage-router-test-'));
  testRoots.push(dir);
  return dir;
}

function writeAuthProfileFile(
  projectRoot: string,
  profiles: Record<string, Record<string, unknown>>,
): void {
  const saivageDir = join(projectRoot, '.saivage');
  const filePath = join(saivageDir, 'auth-profiles.json');
  mkdirSync(saivageDir, { recursive: true });
  writeFileSync(
    filePath,
    JSON.stringify({ version: 1, profiles }, null, 2),
    { mode: 0o600 },
  );
}

afterEach(() => {
  for (const dir of testRoots) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  testRoots = [];
});

describe('ModelRouter', () => {
  describe('resolve', () => {
    it('should resolve a role to ordered candidates', async () => {
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

      const chain = await router.resolve('planner');
      // Should be: github/primary/gpt-5.5, github/secondary/gpt-5.5, opencode/_/kimi-k2.6
      expect(chain.length).toBeGreaterThanOrEqual(3);
      expect(chain[0]).toEqual({ provider: 'github', account: 'primary', model: 'gpt-5.5' });
      expect(chain[1]).toEqual({ provider: 'github', account: 'secondary', model: 'gpt-5.5' });
      expect(chain[2].model).toBe('kimi-k2.6');
    });

    it('should skip providers/accounts in cooldown', async () => {
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

      const chain = await router.resolve('planner');
      // github/primary is in cooldown — should skip to opencode
      expect(chain).toHaveLength(1);
      expect(chain[0].provider).toBe('opencode');
    });

    it('should advance to next model only after all candidates for current model exhausted', async () => {
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

      const chain = await router.resolve('planner');
      // gpt-5.5 has no healthy candidates → advance to kimi-k2.6
      expect(chain).toHaveLength(1);
      expect(chain[0].model).toBe('kimi-k2.6');
      expect(chain[0].provider).toBe('opencode');
    });

    it('should try model equivalents after exhausting all candidates', async () => {
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

      const chain = await router.resolve('planner');
      // Should try claude-sonnet-4 as equivalent
      expect(chain.length).toBeGreaterThan(0);
      expect(chain[0].model).toBe('claude-sonnet-4');
    });

    it('should try failover chains after equivalents', async () => {
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

      const chain = await router.resolve('planner');
      // Should try deepseek-v4-pro via failover
      expect(chain.length).toBeGreaterThan(0);
      expect(chain[0].model).toBe('deepseek-v4-pro');
    });

    it('should use routing profiles when configured', async () => {
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

      const chain = await router.resolve('planner');
      expect(chain).toHaveLength(2);
      expect(chain[0].model).toBe('gpt-5.5');
      expect(chain[1].model).toBe('kimi-k2.6');
    });

    it('should return empty chain if no providers can serve any model', async () => {
      const cfg = mockConfig({
        models: { planner: ['nonexistent-model'] },
        providers: {
          github: { priority: 10, models: ['gpt-5.5'] },
        },
      });
      const registry = new ProviderRegistry(cfg);
      const router = new ModelRouter(cfg, registry);

      const chain = await router.resolve('planner');
      expect(chain).toHaveLength(0);
    });

    it('should support top-level failover key', async () => {
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

      const chain = await router.resolve('planner');
      expect(chain.length).toBeGreaterThan(0);
      expect(chain[0].model).toBe('deepseek-v4-pro');
    });

    // ── Auth profile integration tests ────────────────────────

    describe('auth profile integration', () => {
      it('includes a candidate when auth profile is valid (not expired)', async () => {
        const root = makeProjectRoot();
        // Write auth profile with future expiry
        writeAuthProfileFile(root, {
          'my-oauth': {
            type: 'oauth',
            provider: 'github',
            accessToken: 'gh-at-123',
            refreshToken: 'gh-rt-456',
            expiresAt: Date.now() + 3600_000, // 1 hour from now
          },
        });

        const cfg = mockConfig({
          models: { planner: ['gpt-5.5'] },
          providers: {
            github: {
              priority: 10,
              models: ['gpt-5.5'],
              authProfile: 'my-oauth',
            },
          },
        });
        const registry = new ProviderRegistry(cfg);
        const router = new ModelRouter(cfg, registry, root);

        const chain = await router.resolve('planner');
        expect(chain).toHaveLength(1);
        expect(chain[0].provider).toBe('github');
      });

      it('includes a candidate when no auth profile is configured', async () => {
        const cfg = mockConfig({
          models: { planner: ['gpt-5.5'] },
          providers: {
            github: {
              priority: 10,
              models: ['gpt-5.5'],
              // no authProfile
            },
          },
        });
        const registry = new ProviderRegistry(cfg);
        const router = new ModelRouter(cfg, registry);

        const chain = await router.resolve('planner');
        expect(chain).toHaveLength(1);
        expect(chain[0].provider).toBe('github');
      });

      it('skips an account when auth profile is expired and refresh fails', async () => {
        const root = makeProjectRoot();
        // Write auth profile with past expiry (already expired)
        writeAuthProfileFile(root, {
          'my-oauth': {
            type: 'oauth',
            provider: 'github',
            accessToken: 'gh-at-expired',
            refreshToken: 'gh-rt-expired',
            expiresAt: Date.now() - 100_000, // expired 100s ago
          },
        });

        const cfg = mockConfig({
          models: { planner: ['gpt-5.5'] },
          providers: {
            github: {
              priority: 10,
              models: ['gpt-5.5'],
              authProfile: 'my-oauth',
            },
            opencode: {
              priority: 20,
              models: ['gpt-5.5'],
              // no auth profile — should be used as fallback
            },
          },
        });
        const registry = new ProviderRegistry(cfg);

        // No tokenEndpoint configured → refreshAuthProfile will fail gracefully
        const router = new ModelRouter(cfg, registry, root);

        const chain = await router.resolve('planner');
        // github with expired auth should be skipped; opencode should be used
        expect(chain).toHaveLength(1);
        expect(chain[0].provider).toBe('opencode');
      });

      it('skips an account when auth profile name is configured but file does not exist', async () => {
        const root = makeProjectRoot();
        // No auth-profiles.json file at all

        const cfg = mockConfig({
          models: { planner: ['gpt-5.5'] },
          providers: {
            github: {
              priority: 10,
              models: ['gpt-5.5'],
              authProfile: 'nonexistent-profile',
            },
            opencode: {
              priority: 20,
              models: ['gpt-5.5'],
            },
          },
        });
        const registry = new ProviderRegistry(cfg);
        const router = new ModelRouter(cfg, registry, root);

        const chain = await router.resolve('planner');
        // github with missing auth profile should be skipped
        expect(chain).toHaveLength(1);
        expect(chain[0].provider).toBe('opencode');
      });

      it('skips an account when profile exists but has no refresh token (and is expired)', async () => {
        const root = makeProjectRoot();
        // Profile without refresh token and with past expiry
        writeAuthProfileFile(root, {
          'no-rt-profile': {
            type: 'oauth',
            provider: 'github',
            accessToken: 'gh-at-no-rt',
            // No refreshToken
            expiresAt: Date.now() - 100_000,
          },
        });

        const cfg = mockConfig({
          models: { planner: ['gpt-5.5'] },
          providers: {
            github: {
              priority: 10,
              models: ['gpt-5.5'],
              authProfile: 'no-rt-profile',
            },
            opencode: {
              priority: 20,
              models: ['gpt-5.5'],
            },
          },
        });
        const registry = new ProviderRegistry(cfg);
        const router = new ModelRouter(cfg, registry, root);

        const chain = await router.resolve('planner');
        // github with expired + no refresh token should be skipped
        expect(chain).toHaveLength(1);
        expect(chain[0].provider).toBe('opencode');
      });

      it('skips an account when profile name is configured but profile not in file', async () => {
        const root = makeProjectRoot();
        // Auth file exists with a different profile
        writeAuthProfileFile(root, {
          'other-profile': {
            type: 'oauth',
            provider: 'other',
            accessToken: 'other-at',
          },
        });

        const cfg = mockConfig({
          models: { planner: ['gpt-5.5'] },
          providers: {
            github: {
              priority: 10,
              models: ['gpt-5.5'],
              authProfile: 'my-oauth',
            },
            opencode: {
              priority: 20,
              models: ['gpt-5.5'],
            },
          },
        });
        const registry = new ProviderRegistry(cfg);
        const router = new ModelRouter(cfg, registry, root);

        const chain = await router.resolve('planner');
        // github with profile name that doesn't match should be skipped
        expect(chain).toHaveLength(1);
        expect(chain[0].provider).toBe('opencode');
      });

      it('uses account-level authProfile when set (overrides provider-level)', async () => {
        const root = makeProjectRoot();
        writeAuthProfileFile(root, {
          'acct-oauth': {
            type: 'oauth',
            provider: 'github',
            accessToken: 'acct-at-valid',
            refreshToken: 'acct-rt-valid',
            expiresAt: Date.now() + 3600_000, // not expired
          },
        });

        const cfg = mockConfig({
          models: { planner: ['gpt-5.5'] },
          providers: {
            github: {
              priority: 10,
              models: ['gpt-5.5'],
              accounts: {
                primary: {
                  priority: 10,
                  authProfile: 'acct-oauth',
                },
                secondary: {
                  priority: 20,
                  // no authProfile → inherits from provider (none here)
                },
              },
            },
          },
        });
        const registry = new ProviderRegistry(cfg);
        const router = new ModelRouter(cfg, registry, root);

        const chain = await router.resolve('planner');
        // primary has valid auth, secondary has no auth → both should appear
        expect(chain.length).toBe(2);
        expect(chain[0].provider).toBe('github');
        expect(chain[0].account).toBe('primary');
      });
    });
  });

  describe('nextCandidate', () => {
    it('should return the first healthy candidate', async () => {
      const cfg = mockConfig({
        models: { planner: ['gpt-5.5'] },
        providers: {
          github: { priority: 10, models: ['gpt-5.5'] },
        },
      });
      const registry = new ProviderRegistry(cfg);
      const router = new ModelRouter(cfg, registry);

      const c = await router.nextCandidate('planner');
      expect(c).not.toBeNull();
      expect(c!.model).toBe('gpt-5.5');
    });

    it('should return null if no candidates available', async () => {
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

      const c = await router.nextCandidate('planner');
      expect(c).toBeNull();
    });
  });
});
