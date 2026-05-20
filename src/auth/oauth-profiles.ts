/**
 * OAuth Auth Profile Loader
 *
 * Implements loading, refresh, and storage of OAuth profiles from
 * .saivage/auth-profiles.json as described in docs/design/configuration.md
 * § Authentication.
 *
 * Security:
 * - On read, file mode is set to 0o600 via AuthProfileStore.
 * - On write, AuthProfileStore uses same-directory atomic temp files,
 *   fsync/rename, and mode 0o600.
 * - Auth profiles are already blocked from agent/API access by
 *   file-access-security.ts — no additional blocking needed here.
 */

import {
  AuthProfileStore,
  type AuthProfile,
  type AuthProfilesFile,
} from './auth-profile-store.js';
import {
  logOAuthRefreshException,
  logOAuthRefreshHttpFailure,
  logOAuthRefreshMissingAccessToken,
  logOAuthRefreshStart,
} from './oauth-refresh-logger.js';

export type { AuthProfile, AuthProfilesFile } from './auth-profile-store.js';

/**
 * Load all auth profiles from .saivage/auth-profiles.json.
 *
 * Sets the file mode to 0o600 after reading (defense-in-depth).
 * Returns null if the file does not exist.
 *
 * @param projectRoot - Absolute or relative path to the project root.
 * @returns The parsed and normalized profiles, or null if file absent.
 */
export async function loadAuthProfiles(
  projectRoot: string,
): Promise<AuthProfilesFile | null> {
  return new AuthProfileStore(projectRoot).load();
}

/**
 * Get a single auth profile by name.
 *
 * @param projectRoot - Project root directory.
 * @param name - The profile name key.
 * @returns The normalized profile, or null if not found.
 */
export async function getAuthProfile(
  projectRoot: string,
  name: string,
): Promise<AuthProfile | null> {
  const file = await loadAuthProfiles(projectRoot);
  if (!file) return null;
  return file.profiles[name] ?? null;
}

/**
 * Save a profile back to disk with mode 0o600.
 *
 * If the file already exists, it is read, updated, and written back.
 * If it does not exist, a new file is created with just this profile.
 * Corrupt/invalid/unreadable existing stores are refused rather than
 * silently overwritten.
 *
 * @param projectRoot - Project root directory.
 * @param name - The profile name key.
 * @param profile - The profile to save.
 */
export async function saveAuthProfile(
  projectRoot: string,
  name: string,
  profile: AuthProfile,
): Promise<void> {
  await new AuthProfileStore(projectRoot).saveProfile(name, profile);
}

/**
 * Check if a profile is expired or will expire within the buffer window.
 *
 * @param profile - The profile to check.
 * @param bufferMs - How many ms before actual expiry to consider "expired".
 *                   Default: 60000 (60 seconds).
 * @returns true if the profile is expired or within the buffer window.
 */
export function isProfileExpired(
  profile: AuthProfile,
  bufferMs = 60_000,
): boolean {
  if (profile.expiresAt === undefined) {
    return false;
  }

  const now = Date.now();
  const effectiveExpiry = profile.expiresAt - bufferMs;
  return now >= effectiveExpiry;
}

/**
 * Attempt to refresh an OAuth token by POSTing the refresh token
 * to the provider's token endpoint.
 *
 * On success, saves the updated profile via saveAuthProfile() and
 * returns the updated profile.
 *
 * On failure (network error, invalid grant, missing refresh token),
 * logs the error and returns null. Never throws.
 *
 * @param projectRoot - Project root directory.
 * @param name - The profile name to refresh.
 * @param tokenEndpoint - The OAuth token endpoint URL. If omitted,
 *                        the refresh is gracefully skipped (logged and
 *                        returns null) since there is no endpoint to call.
 * @returns The refreshed profile on success, null on failure.
 */
export async function refreshAuthProfile(
  projectRoot: string,
  name: string,
  tokenEndpoint?: string,
): Promise<AuthProfile | null> {
  const profile = await getAuthProfile(projectRoot, name);
  if (!profile) {
    console.error(
      `[oauth-profiles] Refresh failed: Auth profile '${name}' not found.`,
    );
    return null;
  }

  if (!profile.refreshToken) {
    console.error(
      `[oauth-profiles] Refresh failed: Auth profile '${name}' has no refresh token.`,
    );
    return null;
  }

  if (!tokenEndpoint) {
    console.error(
      `[oauth-profiles] Refresh failed: No token endpoint available for profile '${name}'. ` +
        `Configure tokenEndpoint in the provider or account config.`,
    );
    return null;
  }

  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: profile.refreshToken,
    });

    logOAuthRefreshStart({ name, tokenEndpoint });

    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      logOAuthRefreshHttpFailure({ name, status: response.status, body: errorText });
      return null;
    }

    const data = await response.json().catch(() => null);
    if (!data) {
      console.error(
        `[oauth-profiles] Token refresh for '${name}' returned non-JSON response.`,
      );
      return null;
    }

    const accessToken = data.access_token;
    if (!accessToken) {
      logOAuthRefreshMissingAccessToken({ name, response: data });
      return null;
    }

    const updatedProfile: AuthProfile = {
      type: profile.type,
      provider: profile.provider,
      accessToken,
      refreshToken: data.refresh_token ?? profile.refreshToken,
      expiresAt: data.expires_in
        ? Date.now() + data.expires_in * 1000
        : profile.expiresAt,
    };

    await saveAuthProfile(projectRoot, name, updatedProfile);

    console.error(
      `[oauth-profiles] Token refreshed successfully for '${name}'. ` +
        `New expiry: ${updatedProfile.expiresAt ? new Date(updatedProfile.expiresAt).toISOString() : 'never'}.`,
    );

    return updatedProfile;
  } catch (err) {
    logOAuthRefreshException({ name, error: err });
    return null;
  }
}

/**
 * Delete a profile from the auth-profiles.json file.
 *
 * If the profile does not exist, this is a no-op.
 * If the file does not exist, this is a no-op.
 * Corrupt/invalid/unreadable existing stores are refused rather than
 * silently overwritten.
 *
 * @param projectRoot - Project root directory.
 * @param name - The profile name to delete.
 */
export async function deleteAuthProfile(
  projectRoot: string,
  name: string,
): Promise<void> {
  await new AuthProfileStore(projectRoot).deleteProfile(name);
}
