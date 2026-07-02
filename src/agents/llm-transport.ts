import type { Candidate } from '../contracts/provider-candidate.js';
import type { ProviderRegistry } from './provider.js';
import {
  CredentialSourceResolver,
  type CredentialSourceMetadata,
} from './credential-source-resolver.js';
import {
  type AuthProfile,
  isProfileExpired,
  loadAuthProfiles,
  saveAuthProfile,
} from '../auth/index.js';

const OPENAI_CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

export interface LlmTransportConfig {
  baseUrl: string;
  apiKey?: string;
  cacheKey: string;
  credentialMetadata?: CredentialSourceMetadata;
  tokenEndpoint?: string;
}

export async function resolveLlmTransportConfig(
  projectRoot: string,
  registry: ProviderRegistry,
  candidate: Candidate,
): Promise<LlmTransportConfig> {
  const provider = registry.get(candidate.provider);
  if (!provider) {
    throw new Error(
      `Provider '${candidate.provider}' not found in registry. ` +
        `Cannot resolve baseUrl/apiKey for candidate.`,
    );
  }
  const account = candidate.account != null
    ? (provider.getAllAccounts().find((a) => a.name === candidate.account) ??
      provider.implicitAccount)
    : provider.implicitAccount;

  const resolver = new CredentialSourceResolver({
    loadAuthProfiles: () => loadAuthProfiles(projectRoot),
    usableProfileAccessToken: (profileName, profile) =>
      usableProfileAccessToken(projectRoot, profileName, profile),
  });
  const resolved = await resolver.resolve(provider, account);

  return {
    baseUrl: resolved.baseUrl,
    apiKey: resolved.apiKey,
    cacheKey: resolved.cacheKey,
    credentialMetadata: resolved.metadata,
    tokenEndpoint: resolved.tokenEndpoint,
  };
}

async function usableProfileAccessToken(
  projectRoot: string,
  profileName: string,
  profile: AuthProfile,
): Promise<string | undefined> {
  if (profile.provider === 'openai-codex' && isProfileExpired(profile) && profile.refreshToken) {
    const refreshed = await refreshOpenAICodexProfile(projectRoot, profileName, profile);
    return refreshed?.accessToken ?? profile.accessToken;
  }
  if (profile.provider === 'github-copilot' && isProfileExpired(profile) && profile.refreshToken) {
    const refreshed = await refreshGitHubCopilotProfile(projectRoot, profileName, profile);
    return refreshed?.accessToken ?? profile.accessToken;
  }
  return profile.accessToken;
}

async function refreshOpenAICodexProfile(
  projectRoot: string,
  profileName: string,
  profile: AuthProfile,
): Promise<AuthProfile | null> {
  if (!profile.refreshToken) return null;
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
    const refreshed: AuthProfile = {
      ...profile,
      accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === 'string'
        ? data.refresh_token
        : profile.refreshToken,
      expiresAt: typeof data.expires_in === 'number'
        ? Date.now() + data.expires_in * 1000
        : profile.expiresAt,
    };
    await saveAuthProfile(projectRoot, profileName, refreshed);
    return refreshed;
  } catch {
    return null;
  }
}

async function refreshGitHubCopilotProfile(
  projectRoot: string,
  profileName: string,
  profile: AuthProfile,
): Promise<AuthProfile | null> {
  if (!profile.refreshToken) return null;
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
    const refreshed: AuthProfile = {
      ...profile,
      accessToken: data.token,
      expiresAt: typeof data.expires_at === 'number'
        ? data.expires_at * 1000 - 5 * 60 * 1000
        : profile.expiresAt,
    };
    await saveAuthProfile(projectRoot, profileName, refreshed);
    return refreshed;
  } catch {
    return null;
  }
}
