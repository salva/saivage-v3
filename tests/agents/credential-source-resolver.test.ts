import { describe, it, expect } from '@jest/globals';
import type { AuthProfile, AuthProfilesFile } from '../../src/auth/oauth-profiles.js';
import { CredentialSourceResolver } from '../../src/agents/credential-source-resolver.js';
import { Provider } from '../../src/agents/provider.js';

const ACCOUNT_KEY_SECRET = 'synthetic-account-api-key-SECRET';
const PROVIDER_KEY_SECRET = 'synthetic-provider-api-key-SECRET';
const ACCOUNT_PROFILE_TOKEN_SECRET = 'synthetic-account-profile-access-token-SECRET';
const PROVIDER_PROFILE_TOKEN_SECRET = 'synthetic-provider-profile-access-token-SECRET';
const ALIAS_PROFILE_TOKEN_SECRET = 'synthetic-alias-profile-access-token-SECRET';
const REFRESH_TOKEN_SECRET = 'synthetic-refresh-token-SECRET';

function provider(entry: ConstructorParameters<typeof Provider>[1], name = 'test-provider'): Provider {
  return new Provider(name, { models: ['test-model'], ...entry });
}

function accountFor(p: Provider, name: string | null = null) {
  if (name == null) return p.implicitAccount;
  const account = p.getAllAccounts().find((a) => a.name === name);
  if (!account) throw new Error(`test account not found: ${name}`);
  return account;
}

function profile(providerName: string, accessToken: string): AuthProfile {
  return {
    type: 'oauth',
    provider: providerName,
    accessToken,
    refreshToken: REFRESH_TOKEN_SECRET,
    expiresAt: Date.now() + 60_000,
  };
}

function resolver(file: AuthProfilesFile | null = null): CredentialSourceResolver {
  return new CredentialSourceResolver({
    loadAuthProfiles: async () => file,
    usableProfileAccessToken: async (_name, p) => p.accessToken,
  });
}

function serializedNonSecret(value: unknown): string {
  return JSON.stringify(value);
}

function expectNoSecrets(value: unknown): void {
  const serialized = serializedNonSecret(value);
  for (const secret of [
    ACCOUNT_KEY_SECRET,
    PROVIDER_KEY_SECRET,
    ACCOUNT_PROFILE_TOKEN_SECRET,
    PROVIDER_PROFILE_TOKEN_SECRET,
    ALIAS_PROFILE_TOKEN_SECRET,
    REFRESH_TOKEN_SECRET,
  ]) {
    expect(serialized).not.toContain(secret);
  }
}

describe('CredentialSourceResolver', () => {
  it('resolves base URL precedence account > provider > provider default > OpenAI default', async () => {
    const withAccount = provider({
      baseUrl: 'https://provider.example.test/v1',
      accounts: { primary: { baseUrl: 'https://account.example.test/v1' } },
    });
    expect((await resolver().resolve(withAccount, accountFor(withAccount, 'primary'))).baseUrl)
      .toBe('https://account.example.test/v1');

    const withProvider = provider({ baseUrl: 'https://provider.example.test/v1' });
    expect((await resolver().resolve(withProvider, accountFor(withProvider))).baseUrl)
      .toBe('https://provider.example.test/v1');

    const withDefault = provider({}, 'opencode');
    expect((await resolver().resolve(withDefault, accountFor(withDefault))).baseUrl)
      .toBe('https://opencode.ai/zen/v1');

    const withOpenAiDefault = provider({}, 'unknown-provider');
    const resolved = await resolver().resolve(withOpenAiDefault, accountFor(withOpenAiDefault));
    expect(resolved.baseUrl).toBe('https://api.openai.com');
  });

  it('resolves access credential precedence through account/provider keys and explicit profiles', async () => {
    const profiles: AuthProfilesFile = {
      version: 1,
      profiles: {
        accountProfile: profile('test-provider', ACCOUNT_PROFILE_TOKEN_SECRET),
        providerProfile: profile('test-provider', PROVIDER_PROFILE_TOKEN_SECRET),
      },
    };

    const accountKeyProvider = provider({
      apiKey: PROVIDER_KEY_SECRET,
      accounts: { primary: { apiKey: ACCOUNT_KEY_SECRET, authProfile: 'accountProfile' } },
      authProfile: 'providerProfile',
    });
    const accountKey = await resolver(profiles).resolve(accountKeyProvider, accountFor(accountKeyProvider, 'primary'));
    expect(accountKey.apiKey).toBe(ACCOUNT_KEY_SECRET);
    expect(accountKey.cacheKey).toContain(':account-api-key:');

    const providerKeyProvider = provider({
      apiKey: PROVIDER_KEY_SECRET,
      accounts: { primary: { authProfile: 'accountProfile' } },
      authProfile: 'providerProfile',
    });
    const providerKey = await resolver(profiles).resolve(providerKeyProvider, accountFor(providerKeyProvider, 'primary'));
    expect(providerKey.apiKey).toBe(PROVIDER_KEY_SECRET);
    expect(providerKey.cacheKey).toContain(':provider-api-key:');

    const accountProfileProvider = provider({
      accounts: { primary: { authProfile: 'accountProfile' } },
      authProfile: 'providerProfile',
    });
    const accountProfile = await resolver(profiles).resolve(accountProfileProvider, accountFor(accountProfileProvider, 'primary'));
    expect(accountProfile.apiKey).toBe(ACCOUNT_PROFILE_TOKEN_SECRET);
    expect(accountProfile.cacheKey).toContain(':explicit-account-auth-profile:accountProfile:');

    const providerProfileProvider = provider({ authProfile: 'providerProfile' });
    const providerProfile = await resolver(profiles).resolve(providerProfileProvider, accountFor(providerProfileProvider));
    expect(providerProfile.apiKey).toBe(PROVIDER_PROFILE_TOKEN_SECRET);
    expect(providerProfile.cacheKey).toContain(':explicit-provider-auth-profile:providerProfile:');
  });

  it('resolves explicit authProfile before alias fallback and treats missing explicit profiles as no credential', async () => {
    const profiles: AuthProfilesFile = {
      version: 1,
      profiles: {
        explicit: profile('unrelated-provider', ACCOUNT_PROFILE_TOKEN_SECRET),
        alias: profile('openai', ALIAS_PROFILE_TOKEN_SECRET),
      },
    };

    const explicitProvider = provider({ authProfile: 'explicit' }, 'openai-codex');
    const explicit = await resolver(profiles).resolve(explicitProvider, accountFor(explicitProvider));
    expect(explicit.apiKey).toBe(ACCOUNT_PROFILE_TOKEN_SECRET);
    expect(explicit.cacheKey).toContain(':explicit-provider-auth-profile:explicit:');

    const missingProvider = provider({ authProfile: 'missing-profile' }, 'openai-codex');
    const missing = await resolver(profiles).resolve(missingProvider, accountFor(missingProvider));
    expect(missing.apiKey).toBeUndefined();
    expect(missing.cacheKey).toContain(':explicit-provider-auth-profile:missing-profile:');
  });

  it('uses only same-provider implicit auth profiles and returns none when absent', async () => {
    const profiles: AuthProfilesFile = {
      version: 1,
      profiles: { alias: profile('openai-codex', ALIAS_PROFILE_TOKEN_SECRET), publicOpenAi: profile('openai', ACCOUNT_PROFILE_TOKEN_SECRET) },
    };
    const p = provider({}, 'openai-codex');
    const resolved = await resolver(profiles).resolve(p, accountFor(p));
    expect(resolved.apiKey).toBe(ALIAS_PROFILE_TOKEN_SECRET);
    expect(resolved.cacheKey).toContain(':provider-alias-auth-profile:alias:openai-codex');

    const absent = await resolver(null).resolve(p, accountFor(p));
    expect(absent.apiKey).toBeUndefined();
    expect(absent.cacheKey).toContain(':none:_:_');
  });

  it('does not treat public OpenAI and Codex profiles as aliases', async () => {
    const profiles: AuthProfilesFile = {
      version: 1,
      profiles: {
        alpha: profile('openai', ACCOUNT_PROFILE_TOKEN_SECRET),
        beta: profile('openai-codex', PROVIDER_PROFILE_TOKEN_SECRET),
      },
    };
    const p = provider({}, 'openai-codex');
    const resolved = await resolver(profiles).resolve(p, accountFor(p));
    expect(resolved.apiKey).toBe(PROVIDER_PROFILE_TOKEN_SECRET);
    expect(resolved.cacheKey).toContain(':provider-alias-auth-profile:beta:openai-codex');
  });

  it('keeps cache keys free of raw synthetic secrets', async () => {
    const p = provider({
      apiKey: PROVIDER_KEY_SECRET,
      accounts: { primary: { apiKey: ACCOUNT_KEY_SECRET } },
    });
    const resolved = await resolver().resolve(p, accountFor(p, 'primary'));
    expect(resolved.apiKey).toBe(ACCOUNT_KEY_SECRET);
    expectNoSecrets({ cacheKey: resolved.cacheKey });
  });
});
