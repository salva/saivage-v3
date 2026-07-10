import { Buffer } from 'node:buffer';
import type { AuthProfile, AuthProfilesFile } from '../auth/index.js';
import { localSetupFailure } from '../contracts/llm-failure.js';
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
  openAICodexAccountId?: string;
}

export type AuthProfileDependency = 'none' | 'requires_explicit_auth_profile' | 'requires_implicit_auth_profile';

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
    if (provider.name === 'openai-codex') {
      if (!credential.apiKey) throw localSetupFailure({ provider: provider.name, account: account.name, reason: 'missing_required_credential', message: `Provider '${provider.name}' requires a resolved credential before provider I/O.` });
      return { baseUrl, apiKey: credential.apiKey, openAICodexAccountId: deriveOpenAICodexAccountId(credential.apiKey, provider.name, account.name) };
    }
    return { baseUrl, apiKey: credential.apiKey };
  }

  authProfileDependency(provider: Provider, account: Account): AuthProfileDependency {
    if (isExplicitAccount(account) && account.authProfile) return 'requires_explicit_auth_profile';
    if (provider.authProfile) return 'requires_explicit_auth_profile';
    if (isExplicitAccount(account) && account.apiKey) return 'none';
    if (provider.apiKey) return 'none';
    if (this.providerNeedsCredential(provider.name)) return 'requires_implicit_auth_profile';
    return 'none';
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
    if (isExplicitAccount(account) && account.authProfile) {
      const profile = await this.resolveExplicitProfile(provider.name, account.name, account.authProfile);
      return {
        source: 'explicit-account-auth-profile',
        apiKey: profile.apiKey,
        profileName: profile.profileName,
      };
    }
    if (provider.authProfile) {
      const profile = await this.resolveExplicitProfile(provider.name, account.name, provider.authProfile);
      return {
        source: 'explicit-provider-auth-profile',
        apiKey: profile.apiKey,
        profileName: profile.profileName,
      };
    }

    if (isExplicitAccount(account) && account.apiKey) {
      return { source: 'account-api-key', apiKey: account.apiKey };
    }
    if (provider.apiKey) return { source: 'provider-api-key', apiKey: provider.apiKey };

    const profile = await this.resolveImplicitAliasProfile(provider.name, account.name);
    if (!profile.profileName) {
      if (this.providerNeedsCredential(provider.name)) throw localSetupFailure({ provider: provider.name, account: account.name, reason: 'missing_required_credential', message: `Provider '${provider.name}' requires a resolved credential before provider I/O.` });
      return { source: 'none' };
    }
    return {
      source: 'provider-alias-auth-profile',
      apiKey: profile.apiKey,
      profileName: profile.profileName,
      aliasProvider: profile.aliasProvider,
    };
  }

  private async resolveExplicitProfile(providerName: string, accountName: string, profileName: string): Promise<ProfileCredentialResult> {
    const file = await this.loadAuthProfileStore(providerName, accountName, profileName);
    const profile = file?.profiles[profileName];
    if (!profile) throw localSetupFailure({ provider: providerName, account: accountName, reason: 'missing_auth_profile', message: `Configured auth profile '${profileName}' was not found for provider '${providerName}'.` });
    const apiKey = await this.usableProfileAccessToken(profileName, profile);
    if (!apiKey) throw localSetupFailure({ provider: providerName, account: accountName, reason: 'invalid_auth_profile', message: `Configured auth profile '${profileName}' for provider '${providerName}' has no usable access token.` });
    return {
      profileName,
      aliasProvider: profile.provider,
      apiKey,
    };
  }

  private async resolveImplicitAliasProfile(providerName: string, accountName: string): Promise<ProfileCredentialResult> {
    const file = await this.loadAuthProfileStore(providerName, accountName);
    if (!file) return {};
    const aliases = new Set(this.aliasesForProvider(providerName));
    const matches = Object.entries(file.profiles)
      .filter(([, profile]) => aliases.has(profile.provider))
      .map(([profileName, profile]) => ({ profileName, profile }))
      .sort((a, b) => a.profileName.localeCompare(b.profileName));

    if (matches.length === 0) return {};
    if (matches.length > 1) {
      throw localSetupFailure({ provider: providerName, account: accountName, reason: 'ambiguous_auth_profile', message: `Ambiguous auth profile match for provider '${providerName}'. Configure account.authProfile or provider.authProfile explicitly.` });
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

  private async loadAuthProfileStore(providerName: string, accountName: string, profileName?: string): Promise<AuthProfilesFile | null> {
    try {
      return await this.loadAuthProfiles();
    } catch {
      throw localSetupFailure({ provider: providerName, account: accountName, reason: 'auth_profile_store_error', message: `Auth-profile store could not be loaded for provider '${providerName}'${profileName ? ` profile '${profileName}'` : ''}.` });
    }
  }

  private providerNeedsCredential(providerName: string): boolean {
    return providerName === 'openai-codex';
  }
}

const OPENAI_CODEX_JWT_CLAIM = 'https://api.openai.com/auth';

export function deriveOpenAICodexAccountId(token: string, providerName = 'openai-codex', accountName?: string): string {
  try {
    const [, payload] = token.split('.');
    if (!payload) throw new Error('invalid token');
    const decoded = Buffer.from(payload, 'base64url').toString('utf8');
    const claims = JSON.parse(decoded) as Record<string, unknown>;
    const authClaims = claims[OPENAI_CODEX_JWT_CLAIM];
    if (!authClaims || typeof authClaims !== 'object') throw new Error('invalid token');
    const accountId = (authClaims as Record<string, unknown>)['chatgpt_account_id'];
    if (typeof accountId !== 'string' || accountId.length === 0) throw new Error('invalid token');
    return accountId;
  } catch {
    throw localSetupFailure({ provider: providerName, account: accountName, reason: 'invalid_required_credential', message: `Provider '${providerName}' has an unusable credential for required local setup.` });
  }
}

function isExplicitAccount(account: Account): boolean {
  return account.name !== '_implicit';
}
