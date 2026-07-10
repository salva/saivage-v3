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

function codexToken(accountId = 'acct_test'): string {
  const payload = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })).toString('base64url');
  return `header.${payload}.sig`;
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

  it('honors explicit auth profiles before inline key fallback', async () => {
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
    expect(accountKey.apiKey).toBe(ACCOUNT_PROFILE_TOKEN_SECRET);

    const providerKeyProvider = provider({
      apiKey: PROVIDER_KEY_SECRET,
      accounts: { primary: { authProfile: 'accountProfile' } },
      authProfile: 'providerProfile',
    });
    const providerKey = await resolver(profiles).resolve(providerKeyProvider, accountFor(providerKeyProvider, 'primary'));
    expect(providerKey.apiKey).toBe(ACCOUNT_PROFILE_TOKEN_SECRET);

    const accountProfileProvider = provider({
      accounts: { primary: { authProfile: 'accountProfile' } },
      authProfile: 'providerProfile',
    });
    const accountProfile = await resolver(profiles).resolve(accountProfileProvider, accountFor(accountProfileProvider, 'primary'));
    expect(accountProfile.apiKey).toBe(ACCOUNT_PROFILE_TOKEN_SECRET);

    const providerProfileProvider = provider({ authProfile: 'providerProfile' });
    const providerProfile = await resolver(profiles).resolve(providerProfileProvider, accountFor(providerProfileProvider));
    expect(providerProfile.apiKey).toBe(PROVIDER_PROFILE_TOKEN_SECRET);

    const inlineOnly = provider({ apiKey: PROVIDER_KEY_SECRET, accounts: { primary: { apiKey: ACCOUNT_KEY_SECRET } } });
    expect((await resolver(profiles).resolve(inlineOnly, accountFor(inlineOnly, 'primary'))).apiKey).toBe(ACCOUNT_KEY_SECRET);
  });

  it('resolves explicit authProfile before alias fallback and rejects missing explicit profiles', async () => {
    const profiles: AuthProfilesFile = {
      version: 1,
      profiles: {
        explicit: profile('unrelated-provider', ACCOUNT_PROFILE_TOKEN_SECRET),
        alias: profile('openai', ALIAS_PROFILE_TOKEN_SECRET),
      },
    };

    const explicitProvider = provider({ authProfile: 'explicit' }, 'openai-chat');
    const explicit = await resolver(profiles).resolve(explicitProvider, accountFor(explicitProvider));
    expect(explicit.apiKey).toBe(ACCOUNT_PROFILE_TOKEN_SECRET);

    const missingProvider = provider({ authProfile: 'missing-profile' }, 'openai-chat');
    await expect(resolver(profiles).resolve(missingProvider, accountFor(missingProvider)))
      .rejects.toMatchObject({ failure: { kind: 'local_setup_error', reason: 'missing_auth_profile' } });
  });

  it('uses only same-provider implicit auth profiles and returns none when absent', async () => {
    const profiles: AuthProfilesFile = {
      version: 1,
      profiles: { alias: profile('openai-codex', codexToken('acct_alias')), publicOpenAi: profile('openai', ACCOUNT_PROFILE_TOKEN_SECRET) },
    };
    const p = provider({}, 'openai-codex');
    const resolved = await resolver(profiles).resolve(p, accountFor(p));
    expect(resolved.openAICodexAccountId).toBe('acct_alias');

    await expect(resolver(null).resolve(p, accountFor(p)))
      .rejects.toMatchObject({ failure: { kind: 'local_setup_error', reason: 'missing_required_credential' } });
  });

  it('does not treat public OpenAI and Codex profiles as aliases', async () => {
    const profiles: AuthProfilesFile = {
      version: 1,
      profiles: {
        alpha: profile('openai', ACCOUNT_PROFILE_TOKEN_SECRET),
        beta: profile('openai-codex', codexToken('acct_beta')),
      },
    };
    const p = provider({}, 'openai-codex');
    const resolved = await resolver(profiles).resolve(p, accountFor(p));
    expect(resolved.openAICodexAccountId).toBe('acct_beta');
  });

  it('does not return cache keys or secret-bearing diagnostic identities', async () => {
    const p = provider({
      apiKey: PROVIDER_KEY_SECRET,
      accounts: { primary: { apiKey: ACCOUNT_KEY_SECRET } },
    });
    const resolved = await resolver().resolve(p, accountFor(p, 'primary'));
    expect(resolved.apiKey).toBe(ACCOUNT_KEY_SECRET);
    expect('cacheKey' in resolved).toBe(false);
    expectNoSecrets({ resolvedShape: Object.keys(resolved) });
  });
});
