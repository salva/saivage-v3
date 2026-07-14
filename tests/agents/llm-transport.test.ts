import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderRegistry } from '../../src/agents/provider.js';
import { resolveLlmTransportConfig } from '../../src/agents/llm-transport.js';
import type { SaivageConfig } from '../../src/agents/config-schema.js';
import { testAuthProfiles } from '../helpers/canonical-project.js';
import { AuthProfileConflictError } from '../../src/auth/auth-profile-store.js';

const SYNTHETIC_ACCESS_SECRET = 'transport-synthetic-access-token-SECRET';
const SYNTHETIC_REFRESH_SECRET = 'transport-synthetic-refresh-token-SECRET';
const SYNTHETIC_ACCOUNT_KEY_SECRET = 'transport-synthetic-account-api-key-SECRET';

function codexToken(accountId = 'acct_transport'): string {
  const payload = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })).toString('base64url');
  return `header.${payload}.sig`;
}

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
      continuousImprovement: false,
      maxReviewRetries: 3,
      processTimeouts: { plannerMs: 1200000, executorMs: 1200000, reviewerMs: 1200000 },
    },
    security: { injectionScanner: true, maxScanLengthBytes: 102400 },
  };
}

function expectNoTransportSecrets(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const secret of [SYNTHETIC_ACCESS_SECRET, SYNTHETIC_REFRESH_SECRET, SYNTHETIC_ACCOUNT_KEY_SECRET]) {
    expect(serialized).not.toContain(secret);
  }
}

afterEach(() => {
  jest.restoreAllMocks();
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
  roots = [];
});

describe('resolveLlmTransportConfig', () => {
  it('delegates base URL, credential, and Codex account-id construction to the resolver', async () => {
    const root = makeRoot();
    writeProfiles(root, {
      explicit: {
        type: 'oauth',
        provider: 'openai-codex',
        accessToken: codexToken('acct_profile'),
        refreshToken: SYNTHETIC_REFRESH_SECRET,
      },
    });
    const registry = new ProviderRegistry(config({
      'openai-codex': {
        models: ['m1'],
        baseUrl: 'https://provider.example.test/v1',
        authProfile: 'explicit',
        accounts: {
          primary: {
            baseUrl: 'https://account.example.test/v1',
            apiKey: codexToken('acct_primary'),
          },
        },
      },
    }));

    const transport = await resolveLlmTransportConfig(testAuthProfiles(root), registry, {
      provider: 'openai-codex',
      account: 'primary',
      model: 'm1',
    });

    expect(transport.baseUrl).toBe('https://account.example.test/v1');
    expect(transport.openAICodexAccountId).toBe('acct_profile');
    expect('cacheKey' in transport).toBe(false);
    expectNoTransportSecrets({ shape: Object.keys(transport) });
  });

  it('uses unambiguous provider alias profile through resolver wiring', async () => {
    const root = makeRoot();
    writeProfiles(root, {
      alias: {
        type: 'oauth',
        provider: 'openai-codex',
        accessToken: codexToken('acct_alias'),
        refreshToken: SYNTHETIC_REFRESH_SECRET,
      },
    });
    const registry = new ProviderRegistry(config({
      'openai-codex': { models: ['m1'] },
    }));

    const transport = await resolveLlmTransportConfig(testAuthProfiles(root), registry, {
      provider: 'openai-codex',
      account: null,
      model: 'm1',
    });

    expect(transport.openAICodexAccountId).toBe('acct_alias');
    expect('cacheKey' in transport).toBe(false);
  });

  it('fails closed on ambiguous implicit aliases without exposing synthetic secrets', async () => {
    const root = makeRoot();
    writeProfiles(root, {
      alpha: { type: 'oauth', provider: 'openai-codex', accessToken: codexToken('acct_alpha') },
      beta: { type: 'oauth', provider: 'openai-codex', accessToken: 'another-transport-secret-SECRET' },
    });
    const registry = new ProviderRegistry(config({
      'openai-codex': { models: ['m1'] },
    }));

    await expect(resolveLlmTransportConfig(testAuthProfiles(root), registry, {
      provider: 'openai-codex',
      account: null,
      model: 'm1',
    })).rejects.toMatchObject({ failure: { kind: 'local_setup_error', reason: 'ambiguous_auth_profile' } });
    await expect(resolveLlmTransportConfig(testAuthProfiles(root), registry, {
      provider: 'openai-codex',
      account: null,
      model: 'm1',
    })).rejects.not.toThrow(SYNTHETIC_ACCESS_SECRET);
  });

  it('rejects refreshed credentials after a concurrent profile revision conflict', async () => {
    const root = makeRoot();
    writeProfiles(root, {
      copilot: { type: 'oauth', provider: 'github-copilot', accessToken: 'expired-access', refreshToken: 'refresh-source', expiresAt: 0 },
    });
    const registry = new ProviderRegistry(config({
      github: { models: ['m1'], authProfile: 'copilot' },
    }));
    const repository = testAuthProfiles(root);
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      const projection = repository.profile('copilot');
      repository.replaceProfile('copilot', projection!.revision, { ...projection!.profile, accessToken: 'newer-concurrent-access' });
      return new Response(JSON.stringify({ token: 'stale-network-access', expires_at: Math.floor(Date.now() / 1000) + 3600 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    await expect(resolveLlmTransportConfig(repository, registry, { provider: 'github', account: null, model: 'm1' })).rejects.toBeInstanceOf(AuthProfileConflictError);
    expect(repository.profile('copilot')?.profile.accessToken).toBe('newer-concurrent-access');
  });
});
