/**
 * Auth package public surface.
 *
 * Cross-package consumers should import only the auth-profile loading and
 * persistence helpers required for provider credential resolution.
 */

export { AuthProfileRepository } from './auth-profile-store.js';
export type { AuthProfile, AuthProfilesFile, AuthProfileProjection } from './auth-profile-store.js';
export { isProfileExpired } from './oauth-profiles.js';
