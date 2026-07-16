/**
 * Auth package public surface.
 *
 * Cross-package consumers should import only the auth-profile loading and
 * persistence helpers required for provider credential resolution.
 */

export { readAuthProfile, readAuthProfiles, replaceAuthProfiles } from './auth-profile-file.js';
export type { AuthProfile, AuthProfilesFile } from './auth-profile-file.js';
export { isProfileExpired } from './oauth-profiles.js';
