/**
 * OAuth Auth Profile Loader
 *
 * Implements loading, refresh, and storage of OAuth profiles from
 * .saivage/auth-profiles.json as described in docs/design/configuration.md
 * § Authentication.
 *
 * The file format is:
 *   {
 *     "version": 1,
 *     "profiles": {
 *       "profile-name": {
 *         "type": "oauth",
 *         "provider": "provider-name",
 *         "accessToken": "...",
 *         "refreshToken": "...",   // optional
 *         "expiresAt": 1778576995998 // optional, milliseconds timestamp
 *       }
 *     }
 *   }
 *
 * The actual file uses shorthand field names 'access', 'refresh',
 * and 'expires' (millisecond timestamp). This module handles both
 * formats transparently.
 *
 * Security:
 * - On read, file mode is set to 0o600 via fs.promises.chmod.
 * - On write, file is written with mode 0o600.
 * - Auth profiles are already blocked from agent/API access by
 *   file-access-security.ts — no additional blocking needed here.
 */

import { readFile, writeFile, chmod, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import {
  logOAuthRefreshException,
  logOAuthRefreshHttpFailure,
  logOAuthRefreshMissingAccessToken,
  logOAuthRefreshStart,
} from './oauth-refresh-logger.js';

// ── Types ─────────────────────────────────────────────────────

/** A single OAuth auth profile after normalization. */
export interface AuthProfile {
  type: string;
  provider: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number; // milliseconds timestamp
}

/** The top-level auth-profiles.json structure. */
export interface AuthProfilesFile {
  version: number;
  profiles: Record<string, AuthProfile>;
}

// ── Zod Schemas ───────────────────────────────────────────────

/**
 * Raw profile from disk — accepts BOTH canonical and shorthand names.
 * After parsing, fields are normalized to the canonical names.
 */
const rawProfileSchema = z.object({
  // Canonical field names
  type: z.string().optional(),
  provider: z.string(),
  accessToken: z.string().optional(),
  refreshToken: z.string().optional(),
  expiresAt: z.number().optional(),

  // Shorthand field names used by the actual file format
  access: z.string().optional(),
  refresh: z.string().optional(),
  expires: z.number().optional(),
});

const rawAuthProfilesSchema = z.object({
  version: z.number().default(1),
  profiles: z.record(z.string(), rawProfileSchema),
});

// ── Constants ─────────────────────────────────────────────────

const AUTH_FILE_REL = '.saivage/auth-profiles.json';
const FILE_MODE = 0o600;

// ── Normalization ─────────────────────────────────────────────

/**
 * Normalize a raw profile from disk into the canonical format.
 *
 * Handles both canonical field names (accessToken, refreshToken, expiresAt)
 * and shorthand field names (access, refresh, expires). Access token is
 * required; if neither shorthand nor canonical name is provided an error
 * is thrown during validation rather than at this point (the caller is
 * expected to validate first).
 */
function normalizeProfile(
  raw: z.infer<typeof rawProfileSchema>,
  name: string,
): AuthProfile {
  const accessToken = raw.accessToken ?? raw.access;
  if (!accessToken) {
    throw new Error(
      `OAuth profile '${name}' is missing access token (neither 'accessToken' nor 'access' field found).`,
    );
  }

  return {
    type: raw.type ?? 'oauth',
    provider: raw.provider,
    accessToken,
    refreshToken: raw.refreshToken ?? raw.refresh,
    expiresAt: raw.expiresAt ?? raw.expires,
  };
}

/**
 * Normalize all profiles in the file structure.
 */
function normalizeProfiles(
  raw: z.infer<typeof rawAuthProfilesSchema>,
): AuthProfilesFile {
  const profiles: Record<string, AuthProfile> = {};
  for (const [name, rawProfile] of Object.entries(raw.profiles)) {
    profiles[name] = normalizeProfile(rawProfile, name);
  }
  return { version: raw.version, profiles };
}

// ── Serialization ─────────────────────────────────────────────

/**
 * Convert normalized profiles back to the canonical file format.
 */
function serializeProfiles(file: AuthProfilesFile): string {
  const obj = {
    version: file.version,
    profiles: {} as Record<string, Record<string, unknown>>,
  };
  for (const [name, profile] of Object.entries(file.profiles)) {
    const entry: Record<string, unknown> = {
      type: profile.type,
      provider: profile.provider,
      accessToken: profile.accessToken,
    };
    if (profile.refreshToken !== undefined) {
      entry['refreshToken'] = profile.refreshToken;
    }
    if (profile.expiresAt !== undefined) {
      entry['expiresAt'] = profile.expiresAt;
    }
    obj.profiles[name] = entry;
  }
  return JSON.stringify(obj, null, 2) + '\n';
}

// ── Helpers ───────────────────────────────────────────────────

function authFilePath(projectRoot: string): string {
  return join(projectRoot, AUTH_FILE_REL);
}

// ── Public API ────────────────────────────────────────────────

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
  const filePath = authFilePath(projectRoot);

  if (!existsSync(filePath)) {
    return null;
  }

  // Read the file
  const raw = await readFile(filePath, 'utf-8');

  // Set file mode to 0o600 (defense-in-depth)
  await chmod(filePath, FILE_MODE);

  // Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse auth-profiles.json: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Validate schema
  const result = rawAuthProfilesSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Auth profiles validation failed:\n${issues}`);
  }

  // Normalize field names
  return normalizeProfiles(result.data);
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
  let file: AuthProfilesFile;
  try {
    const existing = await loadAuthProfiles(projectRoot);
    file = existing ?? { version: 1, profiles: {} };
  } catch {
    // If loading fails (corrupt file), start fresh
    file = { version: 1, profiles: {} };
  }

  file.profiles[name] = profile;

  const filePath = authFilePath(projectRoot);

  // Ensure parent directory exists
  const parent = dirname(filePath);
  await mkdir(parent, { recursive: true });

  // Write with mode 0o600
  await writeFile(filePath, serializeProfiles(file), { mode: FILE_MODE });
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
    // No expiry set — assume never expires
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

    // Build the updated profile
    const updatedProfile: AuthProfile = {
      type: profile.type,
      provider: profile.provider,
      accessToken,
      refreshToken: data.refresh_token ?? profile.refreshToken,
      expiresAt: data.expires_in
        ? Date.now() + data.expires_in * 1000
        : profile.expiresAt,
    };

    // Save via saveAuthProfile() — writes with mode 0o600
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
 *
 * @param projectRoot - Project root directory.
 * @param name - The profile name to delete.
 */
export async function deleteAuthProfile(
  projectRoot: string,
  name: string,
): Promise<void> {
  const filePath = authFilePath(projectRoot);

  if (!existsSync(filePath)) {
    return; // Nothing to delete
  }

  const file = await loadAuthProfiles(projectRoot);
  if (!file) return;

  if (!(name in file.profiles)) {
    return; // Profile not found — nothing to do
  }

  delete file.profiles[name];

  // Write the modified file back
  await writeFile(filePath, serializeProfiles(file), { mode: FILE_MODE });
}
