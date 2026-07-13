import type { AuthProfile } from './auth-profile-store.js';

export type { AuthProfile, AuthProfilesFile, AuthProfileProjection } from './auth-profile-store.js';

export function isProfileExpired(profile: AuthProfile, bufferMs = 60_000): boolean {
  if (profile.expiresAt === undefined) return false;
  return Date.now() >= profile.expiresAt - bufferMs;
}
