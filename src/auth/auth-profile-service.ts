import {
  authProfileRevision,
  type AuthProfile,
  type AuthProfileRepository,
} from './auth-profile-store.js';

export class AuthProfileConflictError extends Error {
  readonly name = 'AuthProfileConflictError';
  constructor(profileName: string) { super(`Auth profile '${profileName}' changed before replacement.`); }
}

export function replaceRefreshedAuthProfile(
  repository: AuthProfileRepository,
  name: string,
  expectedRevision: string,
  profile: AuthProfile,
): void {
  const file = structuredClone(repository.load() ?? { version: 1, profiles: {} });
  const current = file.profiles[name];
  if (!current || authProfileRevision(current) !== expectedRevision) throw new AuthProfileConflictError(name);
  file.profiles[name] = profile;
  repository.replace(file);
}
