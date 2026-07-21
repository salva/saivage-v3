import { describe, expect, it } from '@jest/globals';

import { isProfileExpired, type AuthProfile } from '../../src/auth/oauth-profiles.js';
import { isReadBlocked } from '../../src/workspace/file-access-security.js';

function profile(expiresAt?: number): AuthProfile {
  return { type: 'oauth', provider: 'test', accessToken: 'token', ...(expiresAt === undefined ? {} : { expiresAt }) };
}

describe('isProfileExpired', () => {
  it('applies the expiry buffer and permits profiles without expiry', () => {
    expect(isProfileExpired(profile())).toBe(false);
    expect(isProfileExpired(profile(Date.now() + 30_000))).toBe(true);
    expect(isProfileExpired(profile(Date.now() + 120_000))).toBe(false);
    expect(isProfileExpired(profile(Date.now() - 1), 0)).toBe(true);
  });
});

describe('auth profile file access', () => {
  it('keeps the canonical auth file unavailable to agents', () => {
    expect(isReadBlocked('.saivage/auth-profiles.json')).toBe(true);
    expect(isReadBlocked('.saivage/foo/../auth-profiles.json')).toBe(true);
  });
});
