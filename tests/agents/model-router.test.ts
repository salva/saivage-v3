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
import { MemoryCandidateAvailability, type AvailabilityDecision } from '../../src/agents/candidate-availability.js';
import { resolveLlmTransportConfig } from '../../src/agents/llm-transport.js';
import type { SaivageConfig } from '../../src/agents/config-schema.js';
import { testAuthProfiles, testCompositionAuthority } from '../helpers/canonical-project.js';

function blockedDecision(ms = 60000): AvailabilityDecision {
  return { state: 'COOLING', untilMs: Date.now() + ms, reason: 'test' };
}

function mockConfig(overrides: Partial<SaivageConfig> = {}): SaivageConfig {
  return {
    models: { default: ['test-model'] },
    providers: {},
    server: { port: 8080, host: '0.0.0.0' },
    runtime: {
      candidateAvailabilityCompactBytes: 262144,
      continuousImprovement: false, maxReviewRetries: 3, processTimeouts: { plannerMs: 1200000, executorMs: 1200000, reviewerMs: 1200000 },
    },
    security: {
      injectionScanner: true,
      maxScanLengthBytes: 102400,
    },
    ...overrides,
  };
}

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
      expect(chain.length).toBeGreaterThanOrEqual(3);
      expect(chain[0]).toEqual({ provider: 'github', account: 'primary', model: 'gpt-5.5' });
      expect(chain[1]).toEqual({ provider: 'github', account: 'secondary', model: 'gpt-5.5' });
      expect(chain[2].model).toBe('kimi-k2.6');
    });

    it('keeps cooled candidates in route order because invocation owns live availability', async () => {
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
      const availability = new MemoryCandidateAvailability();
      await availability.markFailed(
        { provider: 'github', account: 'primary', model: 'gpt-5.5' },
        blockedDecision(),
      );
      const router = new ModelRouter(cfg, registry);

      const chain = await router.resolve('planner');
      expect(chain).toHaveLength(2);
      expect(chain[0].provider).toBe('github');
      expect(chain[1].provider).toBe('opencode');
    });

    it('orders candidates by configured model before advancing to the next configured model', async () => {
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
      const availability = new MemoryCandidateAvailability();
      await availability.markFailed(
        { provider: 'github', account: null, model: 'gpt-5.5' },
        blockedDecision(),
      );
      const router = new ModelRouter(cfg, registry);

      const chain = await router.resolve('planner');
      expect(chain).toHaveLength(2);
      expect(chain[0].model).toBe('gpt-5.5');
      expect(chain[0].provider).toBe('github');
      expect(chain[1].model).toBe('kimi-k2.6');
      expect(chain[1].provider).toBe('opencode');
    });

    it('appends model equivalents after base candidates', async () => {
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
      const availability = new MemoryCandidateAvailability();
      await availability.markFailed(
        { provider: 'github', account: null, model: 'gpt-5.5' },
        blockedDecision(),
      );
      const router = new ModelRouter(cfg, registry);

      const chain = await router.resolve('planner');
      expect(chain.map((candidate) => candidate.model)).toEqual(['gpt-5.5', 'claude-sonnet-4']);
    });

    it('appends failover chains after base candidates and equivalents', async () => {
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
      const availability = new MemoryCandidateAvailability();
      await availability.markFailed(
        { provider: 'github', account: null, model: 'gpt-5.5' },
        blockedDecision(),
      );
      const router = new ModelRouter(cfg, registry);

      const chain = await router.resolve('planner');
      expect(chain.map((candidate) => candidate.model)).toEqual(['gpt-5.5', 'deepseek-v4-pro']);
    });

    it('processes every configured base route root even when already emitted as an equivalent', async () => {
      const cfg = mockConfig({
        models: {
          planner: ['model-a', 'model-b'],
          equivalents: [['model-a', 'model-b']],
          failover: { 'model-b': ['model-c'] },
        },
        providers: {
          p: { priority: 10, models: ['model-a', 'model-b', 'model-c'] },
        },
      });
      const registry = new ProviderRegistry(cfg);
      const router = new ModelRouter(cfg, registry);

      const chain = await router.resolve('planner');

      expect(chain.map((candidate) => candidate.model)).toEqual(['model-a', 'model-b', 'model-c']);
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

    it('top-level failover is no longer honoured by the router', async () => {
      const cfg = mockConfig({
        models: {
          planner: ['gpt-5.5'],
        },
        providers: {
          github: { priority: 10, models: ['gpt-5.5'] },
          opencode: { priority: 20, models: ['deepseek-v4-pro'] },
        },
      });
      // Synthetically inject a top-level failover key (no longer in SaivageConfig type);
      // F07 requires the router to ignore it entirely.
      (cfg as Record<string, unknown>).failover = { 'gpt-5.5': ['deepseek-v4-pro'] };
      const registry = new ProviderRegistry(cfg);
      const availability = new MemoryCandidateAvailability();
      await availability.markFailed(
        { provider: 'github', account: null, model: 'gpt-5.5' },
        blockedDecision(),
      );
      const router = new ModelRouter(cfg, registry);

      const chain = await router.resolve('planner');
      expect(chain.find((c) => c.model === 'deepseek-v4-pro')).toBeUndefined();
    });

    describe('auth profile integration', () => {
      it('includes a candidate when auth profile is valid (not expired)', async () => {
        const root = makeProjectRoot();
        writeAuthProfileFile(root, {
          'my-oauth': {
            type: 'oauth',
            provider: 'github',
            accessToken: 'gh-at-123',
            refreshToken: 'gh-rt-456',
            expiresAt: Date.now() + 3600_000,
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
        const router = new ModelRouter(cfg, registry);

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
            },
          },
        });
        const registry = new ProviderRegistry(cfg);
        const router = new ModelRouter(cfg, registry);

        const chain = await router.resolve('planner');
        expect(chain).toHaveLength(1);
        expect(chain[0].provider).toBe('github');
      });

      it('keeps expired auth-profile candidates in the router chain so transport resolution can own refresh/failure', async () => {
        const root = makeProjectRoot();
        writeAuthProfileFile(root, {
          'my-oauth': {
            type: 'oauth',
            provider: 'github',
            accessToken: 'gh-at-expired',
            refreshToken: 'gh-rt-expired',
            expiresAt: Date.now() - 100_000,
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
        const router = new ModelRouter(cfg, registry);

        const chain = await router.resolve('planner');
        expect(chain).toHaveLength(2);
        expect(chain[0].provider).toBe('github');
        expect(chain[1].provider).toBe('opencode');
      });

      it('keeps configured auth-profile candidates in the router chain even when the file does not exist', async () => {
        const root = makeProjectRoot();
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
        const router = new ModelRouter(cfg, registry);

        const chain = await router.resolve('planner');
        expect(chain).toHaveLength(2);
        expect(chain[0].provider).toBe('github');
        expect(chain[1].provider).toBe('opencode');
      });

      it('fails explicit provider authProfile misses even when a static API key is configured', async () => {
        const root = makeProjectRoot();
        writeAuthProfileFile(root, {
          'other-profile': {
            type: 'oauth',
            provider: 'github',
            accessToken: 'other-at',
          },
        });

        const cfg = mockConfig({
          models: { planner: ['gpt-5.5'] },
          providers: {
            github: {
              priority: 10,
              models: ['gpt-5.5'],
              apiKey: 'static-api-key',
              baseUrl: 'https://example.invalid/v1',
              authProfile: 'my-oauth',
            },
          },
        });
        const registry = new ProviderRegistry(cfg);
        const router = new ModelRouter(cfg, registry);

        const candidate = (await router.resolve('planner'))[0];
        await expect(resolveLlmTransportConfig(testAuthProfiles(root), testCompositionAuthority(root), registry, candidate))
          .rejects.toMatchObject({ failure: { kind: 'local_setup_error', reason: 'missing_auth_profile' } });
      });

      it('uses account-level authProfile when set (overrides provider-level)', async () => {
        const root = makeProjectRoot();
        writeAuthProfileFile(root, {
          'acct-oauth': {
            type: 'oauth',
            provider: 'github',
            accessToken: 'acct-at-valid',
            refreshToken: 'acct-rt-valid',
            expiresAt: Date.now() + 3600_000,
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
                },
              },
            },
          },
        });
        const registry = new ProviderRegistry(cfg);
        const router = new ModelRouter(cfg, registry);

        const chain = await router.resolve('planner');
        expect(chain.length).toBe(2);
        expect(chain[0].provider).toBe('github');
        expect(chain[0].account).toBe('primary');
      });
    });
  });

});

describe('ModelRouter capability filtering', () => {
  it('skips incompatible primary candidates before health filtering and continues failover without marking failed', async () => {
    const cfg = mockConfig({
      models: {
        planner: ['m1'],
        failover: { m1: ['m2'] },
      },
      providers: {
        p1: { priority: 10, models: ['m1'], capabilities: { toolsMode: 'unsupported' } },
        p2: { priority: 20, models: ['m2'], capabilities: { toolsMode: 'native' } },
      },
    });
    const registry = new ProviderRegistry(cfg);
    const availability = new MemoryCandidateAvailability();
    const router = new ModelRouter(cfg, registry);

    const chain = await router.resolve('planner', { requiresTools: true });

    expect(chain).toEqual([{ provider: 'p2', account: null, model: 'm2' }]);
    expect(router.getLastCapabilitySkips()).toEqual([
      { candidate: { provider: 'p1', account: null, model: 'm1' }, reasons: ['unsupported_tools_mode'] },
    ]);
    expect(availability.isAvailable({ provider: 'p1', account: null, model: 'm1' })).toBe(true);
  });

  it('keeps availability cooldown semantics separate from capability skips', async () => {
    const cfg = mockConfig({
      models: { planner: ['m1'] },
      providers: {
        healthyButIncompatible: { priority: 10, models: ['m1'], capabilities: { exclusiveToolChoiceSupport: 'unsupported' } },
        compatibleButCooling: { priority: 20, models: ['m1'] },
      },
    });
    const registry = new ProviderRegistry(cfg);
    const availability = new MemoryCandidateAvailability();
    await availability.markFailed({ provider: 'compatibleButCooling', account: null, model: 'm1' }, blockedDecision());
    const router = new ModelRouter(cfg, registry);

    const chain = await router.resolve('planner', { requiresExclusiveToolChoice: true });

    expect(chain).toEqual([{ provider: 'compatibleButCooling', account: null, model: 'm1' }]);
    expect(router.getLastCapabilitySkips()[0].reasons).toEqual(['unsupported_exclusive_tool_choice']);
    expect(availability.isAvailable({ provider: 'compatibleButCooling', account: null, model: 'm1' })).toBe(false);
  });
});
