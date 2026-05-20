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
    expect((await resolver().resolve(withAccount, accountFor(withAccount, 'primary'))).metadata.baseUrlSource)
      .toBe('account-base-url');
    expect((await resolver().resolve(withAccount, accountFor(withAccount, 'primary'))).baseUrl)
      .toBe('https://account.example.test/v1');

    const withProvider = provider({ baseUrl: 'https://provider.example.test/v1' });
    expect((await resolver().resolve(withProvider, accountFor(withProvider))).metadata.baseUrlSource)
      .toBe('provider-base-url');

    const withDefault = provider({}, 'opencode');
    expect((await resolver().resolve(withDefault, accountFor(withDefault))).metadata.baseUrlSource)
      .toBe('provider-default');

    const withOpenAiDefault = provider({}, 'unknown-provider');
    const resolved = await resolver().resolve(withOpenAiDefault, accountFor(withOpenAiDefault));
    expect(resolved.metadata.baseUrlSource).toBe('openai-default');
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
    expect(accountKey.metadata.credentialSource).toBe('account-api-key');

    const providerKeyProvider = provider({
      apiKey: PROVIDER_KEY_SECRET,
      accounts: { primary: { authProfile: 'accountProfile' } },
      authProfile: 'providerProfile',
    });
    const providerKey = await resolver(profiles).resolve(providerKeyProvider, accountFor(providerKeyProvider, 'primary'));
    expect(providerKey.apiKey).toBe(PROVIDER_KEY_SECRET);
    expect(providerKey.metadata.credentialSource).toBe('provider-api-key');

    const accountProfileProvider = provider({
      accounts: { primary: { authProfile: 'accountProfile' } },
      authProfile: 'providerProfile',
    });
    const accountProfile = await resolver(profiles).resolve(accountProfileProvider, accountFor(accountProfileProvider, 'primary'));
    expect(accountProfile.apiKey).toBe(ACCOUNT_PROFILE_TOKEN_SECRET);
    expect(accountProfile.metadata.credentialSource).toBe('explicit-account-auth-profile');
    expect(accountProfile.metadata.profileName).toBe('accountProfile');

    const providerProfileProvider = provider({ authProfile: 'providerProfile' });
    const providerProfile = await resolver(profiles).resolve(providerProfileProvider, accountFor(providerProfileProvider));
    expect(providerProfile.apiKey).toBe(PROVIDER_PROFILE_TOKEN_SECRET);
    expect(providerProfile.metadata.credentialSource).toBe('explicit-provider-auth-profile');
    expect(providerProfile.metadata.profileName).toBe('providerProfile');
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
    expect(explicit.metadata.credentialSource).toBe('explicit-provider-auth-profile');
    expect(explicit.metadata.profileName).toBe('explicit');

    const missingProvider = provider({ authProfile: 'missing-profile' }, 'openai-codex');
    const missing = await resolver(profiles).resolve(missingProvider, accountFor(missingProvider));
    expect(missing.apiKey).toBeUndefined();
    expect(missing.metadata.credentialSource).toBe('explicit-provider-auth-profile');
    expect(missing.metadata.profileName).toBe('missing-profile');
  });

  it('uses unambiguous provider/provider-alias auth profile and returns none when absent', async () => {
    const profiles: AuthProfilesFile = {
      version: 1,
      profiles: { alias: profile('openai', ALIAS_PROFILE_TOKEN_SECRET) },
    };
    const p = provider({}, 'openai-codex');
    const resolved = await resolver(profiles).resolve(p, accountFor(p));
    expect(resolved.apiKey).toBe(ALIAS_PROFILE_TOKEN_SECRET);
    expect(resolved.metadata.credentialSource).toBe('provider-alias-auth-profile');
    expect(resolved.metadata.profileName).toBe('alias');
    expect(resolved.metadata.aliasProvider).toBe('openai');

    const absent = await resolver(null).resolve(p, accountFor(p));
    expect(absent.apiKey).toBeUndefined();
    expect(absent.metadata.credentialSource).toBe('none');
  });

  it('fails closed on ambiguous implicit alias profiles without exposing token values', async () => {
    const profiles: AuthProfilesFile = {
      version: 1,
      profiles: {
        alpha: profile('openai', ACCOUNT_PROFILE_TOKEN_SECRET),
        beta: profile('openai-codex', PROVIDER_PROFILE_TOKEN_SECRET),
      },
    };
    const p = provider({}, 'openai-codex');
    await expect(resolver(profiles).resolve(p, accountFor(p))).rejects.toThrow(
      /Ambiguous auth profile match.*openai-codex.*alpha.*beta.*explicit/i,
    );
    await expect(resolver(profiles).resolve(p, accountFor(p))).rejects.not.toThrow(ACCOUNT_PROFILE_TOKEN_SECRET);
    await expect(resolver(profiles).resolve(p, accountFor(p))).rejects.not.toThrow(PROVIDER_PROFILE_TOKEN_SECRET);
  });

  it('resolves token endpoint precedence and ignores malformed provider base URL inference', async () => {
    const accountEndpointProvider = provider({
      baseUrl: 'https://provider.example.test/v1',
      tokenEndpoint: 'https://provider.example.test/oauth/provider',
      accounts: { primary: { tokenEndpoint: 'https://account.example.test/oauth/account' } },
    });
    const accountEndpoint = await resolver().resolve(accountEndpointProvider, accountFor(accountEndpointProvider, 'primary'));
    expect(accountEndpoint.tokenEndpoint).toBe('https://account.example.test/oauth/account');
    expect(accountEndpoint.metadata.tokenEndpointSource).toBe('account-token-endpoint');

    const providerEndpointProvider = provider({
      baseUrl: 'https://provider.example.test/v1',
      tokenEndpoint: 'https://provider.example.test/oauth/provider',
    });
    const providerEndpoint = await resolver().resolve(providerEndpointProvider, accountFor(providerEndpointProvider));
    expect(providerEndpoint.tokenEndpoint).toBe('https://provider.example.test/oauth/provider');
    expect(providerEndpoint.metadata.tokenEndpointSource).toBe('provider-token-endpoint');

    const inferredProvider = provider({ baseUrl: 'https://provider.example.test/v1' });
    const inferred = await resolver().resolve(inferredProvider, accountFor(inferredProvider));
    expect(inferred.tokenEndpoint).toBe('https://provider.example.test/oauth/token');
    expect(inferred.metadata.tokenEndpointSource).toBe('inferred-provider-base');

    const malformedProvider = provider({ baseUrl: 'not a valid url' });
    const malformed = await resolver().resolve(malformedProvider, accountFor(malformedProvider));
    expect(malformed.tokenEndpoint).toBeUndefined();
    expect(malformed.metadata.tokenEndpointSource).toBeUndefined();
  });

  it('keeps metadata and cache keys free of raw synthetic secrets', async () => {
    const p = provider({
      apiKey: PROVIDER_KEY_SECRET,
      accounts: { primary: { apiKey: ACCOUNT_KEY_SECRET } },
    });
    const resolved = await resolver().resolve(p, accountFor(p, 'primary'));
    expect(resolved.apiKey).toBe(ACCOUNT_KEY_SECRET);
    expectNoSecrets(resolved.metadata);
    expectNoSecrets({ cacheKey: resolved.cacheKey });
  });
});
