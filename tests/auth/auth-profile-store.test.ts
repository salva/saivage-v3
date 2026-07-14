import { afterEach, describe, expect, it } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AuthProfileRepository,
  authProfileRevision,
  type AuthProfile,
} from '../../src/auth/auth-profile-store.js';
import { AuthProfileConflictError, replaceRefreshedAuthProfile } from '../../src/auth/auth-profile-service.js';
import { ApplicationPersistenceHealth } from '../../src/application/persistence-health.js';

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'saivage-auth-repository-'));
  roots.push(value);
  return value;
}

function profile(overrides: Partial<AuthProfile> = {}): AuthProfile {
  return { type: 'oauth', provider: 'synthetic', accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresAt: 42, ...overrides };
}

function setup(projectRoot = root()) {
  const repository = new AuthProfileRepository(projectRoot, new ApplicationPersistenceHealth());
  repository.restabilize();
  return { projectRoot, repository };
}

function file(projectRoot: string): string {
  return join(projectRoot, '.saivage', 'auth-profiles.json');
}

afterEach(() => {
  for (const value of roots) rmSync(value, { recursive: true, force: true });
  roots.length = 0;
});

describe('AuthProfileRepository', () => {
  it('reads an absent store without mutating the filesystem', () => {
    const projectRoot = root();
    const repository = new AuthProfileRepository(projectRoot, new ApplicationPersistenceHealth());
    expect(repository.load()).toBeNull();
    expect(existsSync(join(projectRoot, '.saivage'))).toBe(false);
  });

  it('restabilizes exact owned temporaries and file mode before reads', () => {
    const projectRoot = root();
    const directory = join(projectRoot, '.saivage');
    mkdirSync(directory);
    writeFileSync(file(projectRoot), JSON.stringify({ version: 1, profiles: {} }), { mode: 0o644 });
    const temporary = join(directory, '.auth-profiles.json.saivage-write-11111111-1111-4111-8111-111111111111.tmp');
    writeFileSync(temporary, 'incomplete');
    const { repository } = setup(projectRoot);
    expect(repository.load()).toEqual({ version: 1, profiles: {} });
    expect(existsSync(temporary)).toBe(false);
    expect(statSync(file(projectRoot)).mode & 0o777).toBe(0o600);
  });

  it('persists complete profile documents supplied by the application owner', () => {
    const { projectRoot, repository } = setup();
    const first = profile({ provider: 'first' });
    repository.replace({ version: 1, profiles: { account: first } });
    const projection = repository.profile('account');
    expect(projection).toEqual({ profile: first, revision: authProfileRevision(first) });

    const second = profile({ provider: 'second', accessToken: 'second-access' });
    replaceRefreshedAuthProfile(repository, 'account', projection!.revision, second);
    expect(repository.profile('account')?.profile).toEqual(second);
    expect(readFileSync(file(projectRoot), 'utf8').endsWith('\n')).toBe(true);
    expect(statSync(file(projectRoot)).mode & 0o077).toBe(0);
  });

  it('keeps expected-revision checks in the application owner', () => {
    const { projectRoot, repository } = setup();
    const initial = profile();
    repository.replace({ version: 1, profiles: { account: initial } });
    const before = readFileSync(file(projectRoot), 'utf8');
    expect(() => replaceRefreshedAuthProfile(repository, 'account', 'stale', profile({ provider: 'other' }))).toThrow(AuthProfileConflictError);
    expect(readFileSync(file(projectRoot), 'utf8')).toBe(before);
  });

  it('fails closed with credential-safe diagnostics for malformed JSON and schema', () => {
    for (const content of [
      '{ invalid synthetic-access synthetic-refresh',
      JSON.stringify({ version: 1, profiles: { bad: { type: 'oauth', provider: 'synthetic', accessToken: 7, refreshToken: 'synthetic-refresh' } } }),
    ]) {
      const projectRoot = root();
      mkdirSync(join(projectRoot, '.saivage'));
      writeFileSync(file(projectRoot), content, { mode: 0o600 });
      const { repository } = setup(projectRoot);
      let caught: unknown;
      try { replaceRefreshedAuthProfile(repository, 'new', 'missing', profile()); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(Error);
      expect(String(caught)).not.toContain('synthetic-access');
      expect(String(caught)).not.toContain('synthetic-refresh');
      expect(readFileSync(file(projectRoot), 'utf8')).toBe(content);
    }
  });
});
