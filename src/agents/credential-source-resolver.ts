import type { AuthProfile, AuthProfilesFile } from '../auth/index.js';
import type { Account, Provider } from './provider.js';

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com';

export const PROVIDER_DEFAULT_BASE_URLS: Record<string, string> = {
  'github-copilot': 'https://api.individual.githubcopilot.com',
  'openai-codex': 'https://chatgpt.com/backend-api',
  opencode: 'https://opencode.ai/zen/v1',
  'opencode-go': 'https://opencode.ai/zen/go/v1',
};

export const PROVIDER_AUTH_PROFILE_ALIASES: Record<string, string[]> = {
  copilot: ['github-copilot'],
  'github-copilot': ['github-copilot', 'copilot'],
  'openai-codex': ['openai-codex'],
  openai: ['openai'],
};

export type BaseUrlSource =
  | 'account-base-url'
  | 'provider-base-url'
  | 'provider-default'
  | 'openai-default';

export type CredentialSource =
  | 'account-api-key'
  | 'provider-api-key'
  | 'explicit-account-auth-profile'
  | 'explicit-provider-auth-profile'
  | 'provider-alias-auth-profile'
  | 'none';

export interface ResolvedCredentialSources {
  baseUrl: string;
  apiKey?: string;
  cacheKey: string;
}

export interface CredentialSourceResolverOptions {
  loadAuthProfiles: () => Promise<AuthProfilesFile | null>;
  usableProfileAccessToken: (profileName: string, profile: AuthProfile) => Promise<string | undefined>;
  providerDefaultBaseUrls?: Record<string, string>;
  providerAuthProfileAliases?: Record<string, string[]>;
  defaultOpenAiBaseUrl?: string;
}

interface ProfileCredentialResult {
  apiKey?: string;
  profileName?: string;
  aliasProvider?: string;
}

/**
 * Resolve non-routing provider credential sources after a concrete provider/account
 * candidate has already been selected.
 *
 * Precedence:
 * - base URL: account > provider > provider default > OpenAI default
 * - access credential: account apiKey > provider apiKey > explicit account
 *   authProfile > explicit provider authProfile > unambiguous provider/alias profile > none
 * Only apiKey carries secret material. Cache keys and errors are built from
 * source labels and provider/account/profile identifiers only.
 */
export class CredentialSourceResolver {
  private readonly loadAuthProfiles: () => Promise<AuthProfilesFile | null>;
  private readonly usableProfileAccessToken: (profileName: string, profile: AuthProfile) => Promise<string | undefined>;
  private readonly providerDefaultBaseUrls: Record<string, string>;
  private readonly providerAuthProfileAliases: Record<string, string[]>;
  private readonly defaultOpenAiBaseUrl: string;

  constructor(options: CredentialSourceResolverOptions) {
    this.loadAuthProfiles = options.loadAuthProfiles;
    this.usableProfileAccessToken = options.usableProfileAccessToken;
    this.providerDefaultBaseUrls = options.providerDefaultBaseUrls ?? PROVIDER_DEFAULT_BASE_URLS;
    this.providerAuthProfileAliases = options.providerAuthProfileAliases ?? PROVIDER_AUTH_PROFILE_ALIASES;
    this.defaultOpenAiBaseUrl = options.defaultOpenAiBaseUrl ?? DEFAULT_OPENAI_BASE_URL;
  }

  async resolve(provider: Provider, account: Account): Promise<ResolvedCredentialSources> {
    const { baseUrl, source: baseUrlSource } = this.resolveBaseUrl(provider, account);
    const credential = await this.resolveCredential(provider, account);
    return {
      baseUrl,
      apiKey: credential.apiKey,
      cacheKey: buildNonSecretCacheKey(provider.name, account.name, baseUrl, credential),
    };
  }

  private resolveBaseUrl(provider: Provider, account: Account): { baseUrl: string; source: BaseUrlSource } {
    if (isExplicitAccount(account) && account.baseUrl) {
      return { baseUrl: account.baseUrl, source: 'account-base-url' };
    }
    if (provider.baseUrl) return { baseUrl: provider.baseUrl, source: 'provider-base-url' };
    const providerDefault = this.providerDefaultBaseUrls[provider.name];
    if (providerDefault) return { baseUrl: providerDefault, source: 'provider-default' };
    return { baseUrl: this.defaultOpenAiBaseUrl, source: 'openai-default' };
  }

  private async resolveCredential(
    provider: Provider,
    account: Account,
  ): Promise<{ source: CredentialSource; apiKey?: string; profileName?: string; aliasProvider?: string }> {
    if (isExplicitAccount(account) && account.apiKey) {
      return { source: 'account-api-key', apiKey: account.apiKey };
    }
    if (provider.apiKey) return { source: 'provider-api-key', apiKey: provider.apiKey };

    if (isExplicitAccount(account) && account.authProfile) {
      const profile = await this.resolveExplicitProfile(account.authProfile);
      return {
        source: 'explicit-account-auth-profile',
        apiKey: profile.apiKey,
        profileName: profile.profileName,
      };
    }
    if (provider.authProfile) {
      const profile = await this.resolveExplicitProfile(provider.authProfile);
      return {
        source: 'explicit-provider-auth-profile',
        apiKey: profile.apiKey,
        profileName: profile.profileName,
      };
    }

    const profile = await this.resolveImplicitAliasProfile(provider.name);
    if (!profile.profileName) return { source: 'none' };
    return {
      source: 'provider-alias-auth-profile',
      apiKey: profile.apiKey,
      profileName: profile.profileName,
      aliasProvider: profile.aliasProvider,
    };
  }

  private async resolveExplicitProfile(profileName: string): Promise<ProfileCredentialResult> {
    const file = await this.loadAuthProfiles();
    const profile = file?.profiles[profileName];
    if (!profile) return { profileName };
    return {
      profileName,
      aliasProvider: profile.provider,
      apiKey: await this.usableProfileAccessToken(profileName, profile),
    };
  }

  private async resolveImplicitAliasProfile(providerName: string): Promise<ProfileCredentialResult> {
    const file = await this.loadAuthProfiles();
    if (!file) return {};
    const aliases = new Set(this.aliasesForProvider(providerName));
    const matches = Object.entries(file.profiles)
      .filter(([, profile]) => aliases.has(profile.provider))
      .map(([profileName, profile]) => ({ profileName, profile }))
      .sort((a, b) => a.profileName.localeCompare(b.profileName));

    if (matches.length === 0) return {};
    if (matches.length > 1) {
      throw new Error(
        `Ambiguous auth profile match for provider '${providerName}' using aliases ` +
          `[${Array.from(aliases).sort().join(', ')}]: matched profiles ` +
          `[${matches.map((m) => m.profileName).join(', ')}]. ` +
          `Configure account.authProfile or provider.authProfile explicitly.`,
      );
    }

    const match = matches[0];
    return {
      profileName: match.profileName,
      aliasProvider: match.profile.provider,
      apiKey: await this.usableProfileAccessToken(match.profileName, match.profile),
    };
  }

  private aliasesForProvider(providerName: string): string[] {
    return Array.from(new Set([providerName, ...(this.providerAuthProfileAliases[providerName] ?? [])]));
  }
}

function buildNonSecretCacheKey(
  providerName: string,
  accountName: string,
  baseUrl: string,
  credential: { source: CredentialSource; profileName?: string; aliasProvider?: string },
): string {
  return [
    baseUrl,
    providerName,
    accountName,
    credential.source,
    credential.profileName ?? '_',
    credential.aliasProvider ?? '_',
  ].join(':');
}

function isExplicitAccount(account: Account): boolean {
  return account.name !== '_implicit';
}
