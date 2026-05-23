/**
 * Auth package public surface.
 *
 * Cross-package consumers should import only the auth-profile loading and
 * persistence helpers required for provider credential resolution.
 */

export type { AuthProfile, AuthProfilesFile } from './auth-profile-store.js';
export {
  isProfileExpired,
  loadAuthProfiles,
  saveAuthProfile,
} from './oauth-profiles.js';
