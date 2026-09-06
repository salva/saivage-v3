import type { Candidate } from '../contracts/provider-candidate.js';
import type { ProviderRegistry } from './provider.js';
import { CredentialSourceResolver } from './credential-source-resolver.js';
import { LlmRequestError, localSetupFailure } from '../contracts/llm-failure.js';
import { type AuthProfile, isProfileExpired } from '../auth/index.js';
import { readAuthProfiles, replaceAuthProfiles } from '../auth/auth-profile-file.js';
import type { LlmCredentialRequirement } from './llm-protocol-adapter.js';

const OPENAI_CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

export interface LlmTransportConfig {
  baseUrl: string;
  apiKey?: string;
  openAICodexAccountId?: string;
}

export async function resolveLlmTransportConfig(
  projectRoot: string,
  registry: ProviderRegistry,
  candidate: Candidate,
  credentialRequirement: LlmCredentialRequirement,
  abortSignal?: AbortSignal,
): Promise<LlmTransportConfig> {
  const provider = registry.get(candidate.provider);
  if (!provider) {
    throw localSetupFailure({
      provider: candidate.provider,
      model: candidate.model,
      account: candidate.account,
      reason: 'missing_provider',
      message: `Provider '${candidate.provider}' not found in registry.`,
    });
  }
  const account =
    candidate.account != null
      ? provider.getAllAccounts().find((a) => a.name === candidate.account)
      : provider.implicitAccount;
  if (!account)
    throw localSetupFailure({
      provider: candidate.provider,
      model: candidate.model,
      account: candidate.account,
      reason: 'missing_account',
      message: `Account '${candidate.account}' not found for provider '${candidate.provider}'.`,
    });
  if (credentialRequirement === 'openai_responses_api_key') {
    if (account.authProfile || provider.authProfile) {
      throw localSetupFailure({
        provider: candidate.provider,
        model: candidate.model,
        account: candidate.account,
        reason: 'invalid_account',
        message: `Provider '${candidate.provider}' account '${candidate.account ?? '_implicit'}' uses openai-responses and must use an OpenAI API key, not an authProfile.`,
      });
    }
    const apiKey = account.apiKey ?? provider.apiKey;
    if (!apiKey) {
      throw localSetupFailure({
        provider: candidate.provider,
        model: candidate.model,
        account: candidate.account,
        reason: 'missing_required_credential',
        message: `Provider '${candidate.provider}' account '${candidate.account ?? '_implicit'}' uses openai-responses and requires an OpenAI API key.`,
      });
    }
    const baseUrl = account.baseUrl ?? provider.baseUrl ?? 'https://api.openai.com';
    return { baseUrl, apiKey };
  }

  const resolver = new CredentialSourceResolver({
    loadAuthProfiles: async () => readAuthProfiles(projectRoot),
    usableProfileAccessToken: (profileName, profile, ownerSignal) =>
      usableProfileAccessToken(projectRoot, profileName, profile, ownerSignal),
  });
  const resolved = await resolver.resolve(provider, account, abortSignal);

  return {
    baseUrl: resolved.baseUrl,
    apiKey: resolved.apiKey,
    openAICodexAccountId: resolved.openAICodexAccountId,
  };
}

async function usableProfileAccessToken(
  projectRoot: string,
  profileName: string,
  profile: AuthProfile,
  abortSignal?: AbortSignal,
): Promise<string | undefined> {
  if (profile.provider === 'openai-codex' && isProfileExpired(profile) && profile.refreshToken) {
    const refreshed = await refreshOpenAICodexProfile(
      projectRoot,
      profileName,
      profile,
      abortSignal,
    );
    return refreshed?.accessToken ?? profile.accessToken;
  }
  if (profile.provider === 'github-copilot' && isProfileExpired(profile) && profile.refreshToken) {
    const refreshed = await refreshGitHubCopilotProfile(
      projectRoot,
      profileName,
      profile,
      abortSignal,
    );
    return refreshed?.accessToken ?? profile.accessToken;
  }
  return profile.accessToken;
}

async function refreshOpenAICodexProfile(
  projectRoot: string,
  profileName: string,
  profile: AuthProfile,
  abortSignal?: AbortSignal,
): Promise<AuthProfile | null> {
  if (!profile.refreshToken) return null;
  let response: Response;
  try {
    response = await fetch(OPENAI_CODEX_TOKEN_URL, {
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
      signal: abortSignal,
    });
  } catch {
    abortSignal?.throwIfAborted();
    throw refreshServerTransient('openai-codex', 0);
  }
  abortSignal?.throwIfAborted();
  if (response.status >= 500 && response.status <= 599)
    throw refreshServerTransient('openai-codex', response.status);
  if (!response.ok) return null;
  const data = await response.json().catch(() => null);
  abortSignal?.throwIfAborted();
  if (typeof data?.access_token !== 'string') return null;
  const refreshed: AuthProfile = {
    ...profile,
    accessToken: data.access_token,
    refreshToken:
      typeof data.refresh_token === 'string' ? data.refresh_token : profile.refreshToken,
    expiresAt:
      typeof data.expires_in === 'number'
        ? Date.now() + data.expires_in * 1000
        : profile.expiresAt,
  };
  commitRefreshedAuthProfile(projectRoot, profileName, refreshed, abortSignal);
  return refreshed;
}

async function refreshGitHubCopilotProfile(
  projectRoot: string,
  profileName: string,
  profile: AuthProfile,
  abortSignal?: AbortSignal,
): Promise<AuthProfile | null> {
  if (!profile.refreshToken) return null;
  let response: Response;
  try {
    response = await fetch('https://api.github.com/copilot_internal/v2/token', {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${profile.refreshToken}`,
        'User-Agent': 'GitHubCopilotChat/0.35.0',
        'Editor-Version': 'vscode/1.107.0',
        'Editor-Plugin-Version': 'copilot-chat/0.35.0',
        'Copilot-Integration-Id': 'vscode-chat',
        Connection: 'close',
      },
      signal: abortSignal,
    });
  } catch {
    abortSignal?.throwIfAborted();
    throw refreshServerTransient('github-copilot', 0);
  }
  abortSignal?.throwIfAborted();
  if (response.status >= 500 && response.status <= 599)
    throw refreshServerTransient('github-copilot', response.status);
  if (!response.ok) return null;
  const data = await response.json().catch(() => null);
  abortSignal?.throwIfAborted();
  if (typeof data?.token !== 'string') return null;
  const refreshed: AuthProfile = {
    ...profile,
    accessToken: data.token,
    expiresAt:
      typeof data.expires_at === 'number'
        ? data.expires_at * 1000 - 5 * 60 * 1000
        : profile.expiresAt,
  };
  commitRefreshedAuthProfile(projectRoot, profileName, refreshed, abortSignal);
  return refreshed;
}

function refreshServerTransient(provider: 'openai-codex' | 'github-copilot', status: number): LlmRequestError {
  return new LlmRequestError({
    kind: 'server_transient',
    provider,
    status,
    message: `OAuth credential refresh for provider '${provider}' failed before provider request.`,
  });
}

function commitRefreshedAuthProfile(
  projectRoot: string,
  profileName: string,
  refreshed: AuthProfile,
  abortSignal?: AbortSignal,
): void {
  abortSignal?.throwIfAborted();
  const file = readAuthProfiles(projectRoot);
  if (!file?.profiles[profileName])
    throw new Error(`Auth profile '${profileName}' no longer exists.`);
  file.profiles[profileName] = refreshed;
  replaceAuthProfiles(projectRoot, file);
}
