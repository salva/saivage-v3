/**
 * OAuth Auth Profile Loader
 *
 * Implements loading and storage of OAuth profiles from
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
