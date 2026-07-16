import type { AuthProfile } from './auth-profile-file.js';

export type { AuthProfile, AuthProfilesFile } from './auth-profile-file.js';

export function isProfileExpired(profile: AuthProfile, bufferMs = 60_000): boolean {
  if (profile.expiresAt === undefined) return false;
  return Date.now() >= profile.expiresAt - bufferMs;
}
