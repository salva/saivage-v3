import { afterEach, describe, expect, it } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { authProfilePath, readAuthProfile, readAuthProfiles, replaceAuthProfiles, type AuthProfile } from '../../src/auth/auth-profile-file.js';

const roots: string[] = [];
const tempId = () => '11111111-1111-4111-8111-111111111111';

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'saivage-auth-file-'));
  roots.push(value);
  return value;
}

function profile(overrides: Partial<AuthProfile> = {}): AuthProfile {
  return { type: 'oauth', provider: 'synthetic', accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresAt: 42, ...overrides };
}

afterEach(() => {
  for (const value of roots) rmSync(value, { recursive: true, force: true });
  roots.length = 0;
});

describe('direct auth profile file operations', () => {
  it('treats exact canonical ENOENT as absence without creating directories', () => {
    const projectRoot = root();
    expect(readAuthProfiles(projectRoot)).toBeNull();
    expect(readAuthProfile(projectRoot, 'missing')).toBeNull();
    expect(existsSync(join(projectRoot, '.saivage'))).toBe(false);
  });

  it('strictly replaces and reads one complete document through replaceFile', () => {
    const projectRoot = root();
    const account = profile();
    replaceAuthProfiles(projectRoot, { version: 1, profiles: { account } }, tempId);
    expect(readAuthProfiles(projectRoot)).toEqual({ version: 1, profiles: { account } });
    expect(readAuthProfile(projectRoot, 'account')).toEqual(account);
    expect(readFileSync(authProfilePath(projectRoot), 'utf8').endsWith('\n')).toBe(true);
  });

  it('fails with credential-safe diagnostics for malformed JSON and schema', () => {
    for (const content of [
      '{ invalid synthetic-access synthetic-refresh',
      JSON.stringify({ version: 1, profiles: { bad: { type: 'oauth', provider: 'synthetic', accessToken: 7 } } }),
    ]) {
      const projectRoot = root();
      mkdirSync(join(projectRoot, '.saivage'));
      writeFileSync(authProfilePath(projectRoot), content);
      let caught: unknown;
      try { readAuthProfiles(projectRoot); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(Error);
      expect(String(caught)).not.toContain('synthetic-access');
      expect(String(caught)).not.toContain('synthetic-refresh');
    }
  });

  it('rejects invalid complete replacement documents before publication', () => {
    const projectRoot = root();
    expect(() => replaceAuthProfiles(projectRoot, { version: 0, profiles: {} }, tempId)).toThrow();
    expect(existsSync(authProfilePath(projectRoot))).toBe(false);
  });
});
