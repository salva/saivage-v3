import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderRegistry } from '../../src/agents/provider.js';
import { resolveLlmTransportConfig } from '../../src/agents/llm-transport.js';
import type { SaivageConfig } from '../../src/agents/config-schema.js';

const SYNTHETIC_ACCESS_SECRET = 'transport-synthetic-access-token-SECRET';
const SYNTHETIC_REFRESH_SECRET = 'transport-synthetic-refresh-token-SECRET';
const SYNTHETIC_ACCOUNT_KEY_SECRET = 'transport-synthetic-account-api-key-SECRET';

let roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'saivage-llm-transport-test-'));
  roots.push(root);
  return root;
}

function writeProfiles(root: string, profiles: Record<string, Record<string, unknown>>): void {
  mkdirSync(join(root, '.saivage'), { recursive: true });
  writeFileSync(join(root, '.saivage', 'auth-profiles.json'), JSON.stringify({ version: 1, profiles }, null, 2));
}

function config(providers: SaivageConfig['providers']): SaivageConfig {
  return {
    models: { default: ['m1'] },
    providers,
    server: { port: 8080, host: '127.0.0.1' },
    runtime: {
      candidateAvailabilityCompactBytes: 262144,
      recoverAgentInvocations: true,
      healthCheckIntervalMs: 30000,
      idleShutdownMs: 300000,
      maxGoalDepth: 5,
      recoveryDelayMs: 60000,
      autoDispatchBacklog: true,
      continuousImprovement: false,
      maxReviewRetries: 3,
      processTimeouts: { plannerMs: 1200000, executorMs: 1200000, reviewerMs: 1200000 },
      compactionThreshold: 0.8,
      maxCompactions: 3,
      compactionTimeoutMs: 1200000,
      compactionKeepFraction: 0.2,
      maxRecoveryRetries: 3, maxToolTurns: 16,
    },
    security: { injectionScanner: true, maxScanLengthBytes: 102400 },
    supervisor: {
      enabled: true,
      intervalMs: 1200000,
      consecutiveStuckVerdicts: 3,
      logLines: 400,
    },
  };
}

function expectNoTransportSecrets(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const secret of [SYNTHETIC_ACCESS_SECRET, SYNTHETIC_REFRESH_SECRET, SYNTHETIC_ACCOUNT_KEY_SECRET]) {
    expect(serialized).not.toContain(secret);
  }
}

afterEach(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
  roots = [];
});

describe('resolveLlmTransportConfig', () => {
  it('delegates base URL, credential, token endpoint, and non-secret metadata to the resolver', async () => {
    const root = makeRoot();
    writeProfiles(root, {
      explicit: {
        type: 'oauth',
        provider: 'openai',
        accessToken: SYNTHETIC_ACCESS_SECRET,
        refreshToken: SYNTHETIC_REFRESH_SECRET,
      },
    });
    const registry = new ProviderRegistry(config({
      'openai-codex': {
        models: ['m1'],
        baseUrl: 'https://provider.example.test/v1',
        tokenEndpoint: 'https://provider.example.test/oauth/provider',
        authProfile: 'explicit',
        accounts: {
          primary: {
            baseUrl: 'https://account.example.test/v1',
            apiKey: SYNTHETIC_ACCOUNT_KEY_SECRET,
            tokenEndpoint: 'https://account.example.test/oauth/account',
          },
        },
      },
    }));

    const transport = await resolveLlmTransportConfig(root, registry, {
      provider: 'openai-codex',
      account: 'primary',
      model: 'm1',
    });

    expect(transport.baseUrl).toBe('https://account.example.test/v1');
    expect(transport.apiKey).toBe(SYNTHETIC_ACCOUNT_KEY_SECRET);
    expect(transport.tokenEndpoint).toBe('https://account.example.test/oauth/account');
    expect(transport.credentialMetadata).toMatchObject({
      providerName: 'openai-codex',
      accountName: 'primary',
      baseUrlSource: 'account-base-url',
      credentialSource: 'account-api-key',
      tokenEndpointSource: 'account-token-endpoint',
    });
    expectNoTransportSecrets(transport.credentialMetadata);
    expectNoTransportSecrets({ cacheKey: transport.cacheKey });
  });

  it('uses unambiguous provider alias profile through resolver wiring', async () => {
    const root = makeRoot();
    writeProfiles(root, {
      alias: {
        type: 'oauth',
        provider: 'openai',
        accessToken: SYNTHETIC_ACCESS_SECRET,
        refreshToken: SYNTHETIC_REFRESH_SECRET,
      },
    });
    const registry = new ProviderRegistry(config({
      'openai-codex': { models: ['m1'] },
    }));

    const transport = await resolveLlmTransportConfig(root, registry, {
      provider: 'openai-codex',
      account: null,
      model: 'm1',
    });

    expect(transport.apiKey).toBe(SYNTHETIC_ACCESS_SECRET);
    expect(transport.credentialMetadata?.credentialSource).toBe('provider-alias-auth-profile');
    expect(transport.credentialMetadata?.profileName).toBe('alias');
    expectNoTransportSecrets(transport.credentialMetadata);
    expectNoTransportSecrets({ cacheKey: transport.cacheKey });
  });

  it('fails closed on ambiguous implicit aliases without exposing synthetic secrets', async () => {
    const root = makeRoot();
    writeProfiles(root, {
      alpha: { type: 'oauth', provider: 'openai', accessToken: SYNTHETIC_ACCESS_SECRET },
      beta: { type: 'oauth', provider: 'openai-codex', accessToken: 'another-transport-secret-SECRET' },
    });
    const registry = new ProviderRegistry(config({
      'openai-codex': { models: ['m1'] },
    }));

    await expect(resolveLlmTransportConfig(root, registry, {
      provider: 'openai-codex',
      account: null,
      model: 'm1',
    })).rejects.toThrow(/Ambiguous auth profile match.*alpha.*beta.*authProfile/i);
    await expect(resolveLlmTransportConfig(root, registry, {
      provider: 'openai-codex',
      account: null,
      model: 'm1',
    })).rejects.not.toThrow(SYNTHETIC_ACCESS_SECRET);
  });
});
