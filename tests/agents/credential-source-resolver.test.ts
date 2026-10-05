import { describe, it, expect, jest } from '@jest/globals';
import type { AuthProfile, AuthProfilesFile } from '../../src/auth/auth-profile-file.js';
import { CredentialSourceResolver } from '../../src/agents/credential-source-resolver.js';
import { Provider } from '../../src/agents/provider.js';
import { LlmRequestError } from '../../src/contracts/index.js';

const ACCOUNT_KEY_SECRET = 'synthetic-account-api-key-SECRET';
const PROVIDER_KEY_SECRET = 'synthetic-provider-api-key-SECRET';
const ACCOUNT_PROFILE_TOKEN_SECRET = 'synthetic-account-profile-access-token-SECRET';
const PROVIDER_PROFILE_TOKEN_SECRET = 'synthetic-provider-profile-access-token-SECRET';
const ALIAS_PROFILE_TOKEN_SECRET = 'synthetic-alias-profile-access-token-SECRET';
const REFRESH_TOKEN_SECRET = 'synthetic-refresh-token-SECRET';
const MALFORMED_CODEX_TOKEN_SECRET = 'synthetic-malformed-codex-token-SECRET';

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
    MALFORMED_CODEX_TOKEN_SECRET,
  ]) {
    expect(serialized).not.toContain(secret);
  }
}

async function expectLocalSetupError(
  result: Promise<unknown>,
  expected: { provider: string; account: string; reason: string; message: string },
): Promise<void> {
  try {
    await result;
  } catch (error) {
    expect(error).toBeInstanceOf(LlmRequestError);
    if (!(error instanceof LlmRequestError)) throw error;
    expect(error.failure).toStrictEqual({ kind: 'local_setup_error', ...expected });
    expect(error.message).toBe(expected.message);
    expectNoSecrets({ message: error.message, failure: error.failure });
    return;
  }
  throw new Error('Expected local setup failure');
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
    expect(resolved).toStrictEqual({ baseUrl: 'https://api.openai.com', apiKey: undefined });
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
    expect(await resolver(profiles).resolve(inlineOnly, accountFor(inlineOnly, 'primary')))
      .toStrictEqual({ baseUrl: 'https://api.openai.com', apiKey: ACCOUNT_KEY_SECRET });
    expect(await resolver(profiles).resolve(inlineOnly, accountFor(inlineOnly)))
      .toStrictEqual({ baseUrl: 'https://api.openai.com', apiKey: PROVIDER_KEY_SECRET });
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

    const missingProvider = provider({
      authProfile: 'missing-profile',
      apiKey: PROVIDER_KEY_SECRET,
      accounts: { primary: { apiKey: ACCOUNT_KEY_SECRET } },
    }, 'openai-chat');
    await expectLocalSetupError(
      resolver(profiles).resolve(missingProvider, accountFor(missingProvider, 'primary')),
      {
        provider: 'openai-chat',
        account: 'primary',
        reason: 'missing_auth_profile',
        message: "Configured auth profile 'missing-profile' was not found for provider 'openai-chat'.",
      },
    );
  });

  it('uses only same-provider implicit auth profiles and returns none when absent', async () => {
    const profiles: AuthProfilesFile = {
      version: 1,
      profiles: { alias: profile('openai-codex', codexToken('acct_alias')), publicOpenAi: profile('openai', ACCOUNT_PROFILE_TOKEN_SECRET) },
    };
    const p = provider({}, 'openai-codex');
    const resolved = await resolver(profiles).resolve(p, accountFor(p));
    expect(resolved).toStrictEqual({
      baseUrl: 'https://chatgpt.com/backend-api',
      apiKey: profiles.profiles.alias.accessToken,
      openAICodexAccountId: 'acct_alias',
    });

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

  it.each(['copilot', 'openai-codex'])('preserves a matched %s profile with an undefined token', async (providerName) => {
    const matchedProfile = profile(
      providerName === 'copilot' ? 'github-copilot' : providerName,
      ALIAS_PROFILE_TOKEN_SECRET,
    );
    const loadAuthProfiles = jest.fn(async (): Promise<AuthProfilesFile> => ({
      version: 1,
      profiles: { matched: matchedProfile },
    }));
    const usableProfileAccessToken = jest.fn(async (
      _name: string, _profile: AuthProfile, _signal?: AbortSignal,
    ): Promise<string | undefined> => undefined);
    const subject = new CredentialSourceResolver({ loadAuthProfiles, usableProfileAccessToken });
    const p = provider({}, providerName);
    const signal = new AbortController().signal;
    const result = subject.resolve(p, accountFor(p), signal);

    if (providerName === 'openai-codex') {
      await expectLocalSetupError(result, {
        provider: providerName,
        account: '_implicit',
        reason: 'missing_required_credential',
        message: `Provider '${providerName}' requires a resolved credential before provider I/O.`,
      });
    } else {
      expect(await result).toStrictEqual({ baseUrl: 'https://api.openai.com', apiKey: undefined });
    }
    expect(loadAuthProfiles).toHaveBeenCalledTimes(1);
    expect(usableProfileAccessToken).toHaveBeenCalledTimes(1);
    expect(usableProfileAccessToken).toHaveBeenCalledWith('matched', matchedProfile, signal);
    expect(usableProfileAccessToken.mock.calls[0][1]).toBe(matchedProfile);
    expect(usableProfileAccessToken.mock.calls[0][2]).toBe(signal);
  });

  it('rejects ambiguous aliases without requesting a token', async () => {
    const usableProfileAccessToken = jest.fn(async (_name: string, p: AuthProfile) => p.accessToken);
    const subject = new CredentialSourceResolver({
      loadAuthProfiles: async () => ({
        version: 1,
        profiles: {
          beta: profile('copilot', ACCOUNT_PROFILE_TOKEN_SECRET),
          alpha: profile('github-copilot', ALIAS_PROFILE_TOKEN_SECRET),
        },
      }),
      usableProfileAccessToken,
    });
    const p = provider({}, 'github-copilot');
    await expectLocalSetupError(subject.resolve(p, accountFor(p)), {
      provider: p.name,
      account: '_implicit',
      reason: 'ambiguous_auth_profile',
      message: "Ambiguous auth profile match for provider 'github-copilot'. Configure account.authProfile or provider.authProfile explicitly.",
    });
    expect(usableProfileAccessToken).not.toHaveBeenCalled();
  });

  it('rejects an empty explicit account profile without falling through to other credentials', async () => {
    const p = provider({
      authProfile: 'providerProfile',
      apiKey: PROVIDER_KEY_SECRET,
      accounts: { primary: { authProfile: 'empty', apiKey: ACCOUNT_KEY_SECRET } },
    });
    await expectLocalSetupError(resolver({
      version: 1,
      profiles: {
        empty: profile(p.name, ''),
        providerProfile: profile(p.name, PROVIDER_PROFILE_TOKEN_SECRET),
      },
    }).resolve(p, accountFor(p, 'primary')), {
      provider: p.name,
      account: 'primary',
      reason: 'invalid_auth_profile',
      message: "Configured auth profile 'empty' for provider 'test-provider' has no usable access token.",
    });
  });

  it('translates auth-profile store failures without exposing their secret-bearing cause', async () => {
    const usableProfileAccessToken = jest.fn(async (_name: string, p: AuthProfile) => p.accessToken);
    const subject = new CredentialSourceResolver({
      loadAuthProfiles: async () => { throw new Error(REFRESH_TOKEN_SECRET); },
      usableProfileAccessToken,
    });
    const p = provider({ authProfile: 'explicit', apiKey: PROVIDER_KEY_SECRET });
    await expectLocalSetupError(subject.resolve(p, accountFor(p)), {
      provider: p.name,
      account: '_implicit',
      reason: 'auth_profile_store_error',
      message: "Auth-profile store could not be loaded for provider 'test-provider' profile 'explicit'.",
    });
    expect(usableProfileAccessToken).not.toHaveBeenCalled();
  });

  it('rejects a malformed Codex token with a secret-free typed failure', async () => {
    const p = provider({ apiKey: MALFORMED_CODEX_TOKEN_SECRET }, 'openai-codex');
    await expectLocalSetupError(resolver().resolve(p, accountFor(p)), {
      provider: p.name,
      account: '_implicit',
      reason: 'invalid_required_credential',
      message: "Provider 'openai-codex' has an unusable credential for required local setup.",
    });
  });
});
