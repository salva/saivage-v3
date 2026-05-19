import type { Candidate, ProviderRegistry } from './provider.js';
import {
  type AuthProfile,
  isProfileExpired,
  loadAuthProfiles,
  saveAuthProfile,
} from '../auth/oauth-profiles.js';

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com';
const OPENAI_CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

const PROVIDER_DEFAULT_BASE_URLS: Record<string, string> = {
  'github-copilot': 'https://api.individual.githubcopilot.com',
  'openai-codex': 'https://chatgpt.com/backend-api',
  opencode: 'https://opencode.ai/zen/v1',
  'opencode-go': 'https://opencode.ai/zen/go/v1',
};

const PROVIDER_AUTH_PROFILE_ALIASES: Record<string, string[]> = {
  copilot: ['github-copilot'],
  'github-copilot': ['github-copilot', 'copilot'],
  'openai-codex': ['openai-codex', 'openai'],
  openai: ['openai', 'openai-codex'],
};

export interface LlmTransportConfig {
  baseUrl: string;
  apiKey?: string;
  cacheKey: string;
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
  const baseUrl = account.effectiveBaseUrl(provider.baseUrl) ??
    PROVIDER_DEFAULT_BASE_URLS[provider.name] ??
    DEFAULT_OPENAI_BASE_URL;
  const apiKey = account.effectiveApiKey(provider.apiKey) ??
    await resolveProfileAccessToken(projectRoot, provider.name, account.authProfile ?? provider.authProfile);
  const cacheKey = apiKey != null ? `${baseUrl}:${apiKey}` : baseUrl;
  return { baseUrl, apiKey, cacheKey };
}

async function resolveProfileAccessToken(
  projectRoot: string,
  providerName: string,
  authProfileName?: string,
): Promise<string | undefined> {
  const file = await loadAuthProfiles(projectRoot);
  if (!file) return undefined;
  if (authProfileName) {
    const profile = file.profiles[authProfileName];
    return profile
      ? await usableProfileAccessToken(projectRoot, authProfileName, profile)
      : undefined;
  }
  const providerAliases = new Set([
    providerName,
    ...(PROVIDER_AUTH_PROFILE_ALIASES[providerName] ?? []),
  ]);
  const entry = Object.entries(file.profiles).find(([, profile]) => providerAliases.has(profile.provider));
  return entry
    ? await usableProfileAccessToken(projectRoot, entry[0], entry[1])
    : undefined;
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
