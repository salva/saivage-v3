import type { Candidate } from '../contracts/provider-candidate.js';
import type { ProviderRegistry } from './provider.js';
import { CredentialSourceResolver } from './credential-source-resolver.js';
import { localSetupFailure } from '../contracts/llm-failure.js';
import {
  type AuthProfile,
  isProfileExpired,
} from '../auth/index.js';
import { authProfileRevision, type AuthProfileRepository } from '../auth/auth-profile-store.js';

const OPENAI_CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

export interface LlmTransportConfig {
  baseUrl: string;
  apiKey?: string;
  openAICodexAccountId?: string;
}

export async function resolveLlmTransportConfig(
  authProfiles: AuthProfileRepository,
  registry: ProviderRegistry,
  candidate: Candidate,
): Promise<LlmTransportConfig> {
  const provider = registry.get(candidate.provider);
  if (!provider) {
    throw localSetupFailure({ provider: candidate.provider, model: candidate.model, account: candidate.account, reason: 'missing_provider', message: `Provider '${candidate.provider}' not found in registry.` });
  }
  const account = candidate.account != null
    ? provider.getAllAccounts().find((a) => a.name === candidate.account)
    : provider.implicitAccount;
  if (!account) throw localSetupFailure({ provider: candidate.provider, model: candidate.model, account: candidate.account, reason: 'missing_account', message: `Account '${candidate.account}' not found for provider '${candidate.provider}'.` });
  const capabilities = registry.getEffectiveCapabilities(candidate);
  if (capabilities.transportProtocol === 'openai-responses') {
    if (account.authProfile || provider.authProfile) {
      throw localSetupFailure({ provider: candidate.provider, model: candidate.model, account: candidate.account, reason: 'invalid_account', message: `Provider '${candidate.provider}' account '${candidate.account ?? '_implicit'}' uses openai-responses and must use an OpenAI API key, not an authProfile.` });
    }
    const apiKey = account.apiKey ?? provider.apiKey;
    if (!apiKey) {
      throw localSetupFailure({ provider: candidate.provider, model: candidate.model, account: candidate.account, reason: 'missing_required_credential', message: `Provider '${candidate.provider}' account '${candidate.account ?? '_implicit'}' uses openai-responses and requires an OpenAI API key.` });
    }
    const baseUrl = account.baseUrl ?? provider.baseUrl ?? 'https://api.openai.com';
    return { baseUrl, apiKey };
  }

  const resolver = new CredentialSourceResolver({
    loadAuthProfiles: async () => authProfiles.load(),
    usableProfileAccessToken: (profileName, profile) =>
      usableProfileAccessToken(authProfiles, profileName, profile),
  });
  const resolved = await resolver.resolve(provider, account);

  return {
    baseUrl: resolved.baseUrl,
    apiKey: resolved.apiKey,
    openAICodexAccountId: resolved.openAICodexAccountId,
  };
}

export function transportAuthProfileDependency(registry: ProviderRegistry, candidate: Candidate): 'none' | 'requires_explicit_auth_profile' | 'requires_implicit_auth_profile' {
  const provider = registry.get(candidate.provider);
  if (!provider) return 'none';
  const account = candidate.account != null
    ? provider.getAllAccounts().find((a) => a.name === candidate.account)
    : provider.implicitAccount;
  if (!account) return 'none';
  const resolver = new CredentialSourceResolver({ loadAuthProfiles: async () => null, usableProfileAccessToken: async () => undefined });
  return resolver.authProfileDependency(provider, account);
}

async function usableProfileAccessToken(
  authProfiles: AuthProfileRepository,
  profileName: string,
  profile: AuthProfile,
): Promise<string | undefined> {
  if (profile.provider === 'openai-codex' && isProfileExpired(profile) && profile.refreshToken) {
    const refreshed = await refreshOpenAICodexProfile(authProfiles, profileName, profile);
    return refreshed?.accessToken ?? profile.accessToken;
  }
  if (profile.provider === 'github-copilot' && isProfileExpired(profile) && profile.refreshToken) {
    const refreshed = await refreshGitHubCopilotProfile(authProfiles, profileName, profile);
    return refreshed?.accessToken ?? profile.accessToken;
  }
  return profile.accessToken;
}

async function refreshOpenAICodexProfile(
  authProfiles: AuthProfileRepository,
  profileName: string,
  profile: AuthProfile,
): Promise<AuthProfile | null> {
  if (!profile.refreshToken) return null;
  let refreshed: AuthProfile;
  try {
    const response = await fetch(OPENAI_CODEX_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        Connection: 'close',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: profile.refreshToken,
        client_id: OPENAI_CODEX_CLIENT_ID,
      }).toString(),
    });
    if (!response.ok) return null;
    const data = await response.json().catch(() => null);
    if (typeof data?.access_token !== 'string') return null;
    refreshed = {
      ...profile,
      accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === 'string'
        ? data.refresh_token
        : profile.refreshToken,
      expiresAt: typeof data.expires_in === 'number'
        ? Date.now() + data.expires_in * 1000
        : profile.expiresAt,
    };
  } catch {
    return null;
  }
  authProfiles.replaceProfile(profileName, authProfileRevision(profile), refreshed);
  return refreshed;
}

async function refreshGitHubCopilotProfile(
  authProfiles: AuthProfileRepository,
  profileName: string,
  profile: AuthProfile,
): Promise<AuthProfile | null> {
  if (!profile.refreshToken) return null;
  let refreshed: AuthProfile;
  try {
    const response = await fetch('https://api.github.com/copilot_internal/v2/token', {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${profile.refreshToken}`,
        'User-Agent': 'GitHubCopilotChat/0.35.0',
        'Editor-Version': 'vscode/1.107.0',
        'Editor-Plugin-Version': 'copilot-chat/0.35.0',
        'Copilot-Integration-Id': 'vscode-chat',
        Connection: 'close',
      },
    });
    if (!response.ok) return null;
    const data = await response.json().catch(() => null);
    if (typeof data?.token !== 'string') return null;
    refreshed = {
      ...profile,
      accessToken: data.token,
      expiresAt: typeof data.expires_at === 'number'
        ? data.expires_at * 1000 - 5 * 60 * 1000
        : profile.expiresAt,
    };
  } catch {
    return null;
  }
  authProfiles.replaceProfile(profileName, authProfileRevision(profile), refreshed);
  return refreshed;
}
