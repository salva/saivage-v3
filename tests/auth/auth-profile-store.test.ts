import { afterEach, describe, expect, it } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AuthProfileConflictError,
  AuthProfileRecoveryRequiredError,
  AuthProfileRepository,
  authProfileRevision,
  type AuthProfile,
} from '../../src/auth/auth-profile-store.js';
import { createMutationLane } from '../../src/application/mutation-lane.js';

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
  const mutation = createMutationLane();
  const repository = new AuthProfileRepository(projectRoot, mutation.lane);
  repository.restabilize(mutation.authority);
  return { projectRoot, repository, authority: mutation.authority };
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
    const mutation = createMutationLane();
    const repository = new AuthProfileRepository(projectRoot, mutation.lane);
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

  it('creates and replaces a profile under the expected revision', () => {
    const { projectRoot, repository, authority } = setup();
    const first = profile({ provider: 'first' });
    repository.replaceProfile(authority, 'account', null, first);
    const projection = repository.profile('account');
    expect(projection).toEqual({ profile: first, revision: authProfileRevision(first) });

    const second = profile({ provider: 'second', accessToken: 'second-access' });
    repository.replaceProfile(authority, 'account', projection!.revision, second);
    expect(repository.profile('account')?.profile).toEqual(second);
    expect(readFileSync(file(projectRoot), 'utf8').endsWith('\n')).toBe(true);
    expect(statSync(file(projectRoot)).mode & 0o077).toBe(0);
  });

  it('rejects stale replacement and deletion revisions without changing the file', () => {
    const { projectRoot, repository, authority } = setup();
    const initial = profile();
    repository.replaceProfile(authority, 'account', null, initial);
    const before = readFileSync(file(projectRoot), 'utf8');
    expect(() => repository.replaceProfile(authority, 'account', 'stale', profile({ provider: 'other' }))).toThrow(AuthProfileConflictError);
    expect(() => repository.deleteProfile(authority, 'account', 'stale')).toThrow(AuthProfileConflictError);
    expect(readFileSync(file(projectRoot), 'utf8')).toBe(before);
  });

  it('deletes only the exact projected profile revision', () => {
    const { repository, authority } = setup();
    repository.replaceProfile(authority, 'account', null, profile());
    repository.deleteProfile(authority, 'account', repository.profile('account')!.revision);
    expect(repository.load()).toEqual({ version: 1, profiles: {} });
  });

  it('fails closed with credential-safe diagnostics for malformed JSON and schema', () => {
    for (const content of [
      '{ invalid synthetic-access synthetic-refresh',
      JSON.stringify({ version: 1, profiles: { bad: { type: 'oauth', provider: 'synthetic', accessToken: 7, refreshToken: 'synthetic-refresh' } } }),
    ]) {
      const projectRoot = root();
      mkdirSync(join(projectRoot, '.saivage'));
      writeFileSync(file(projectRoot), content, { mode: 0o600 });
      const { repository, authority } = setup(projectRoot);
      let caught: unknown;
      try { repository.replaceProfile(authority, 'new', null, profile()); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(AuthProfileRecoveryRequiredError);
      expect(String(caught)).not.toContain('synthetic-access');
      expect(String(caught)).not.toContain('synthetic-refresh');
      expect(readFileSync(file(projectRoot), 'utf8')).toBe(content);
    }
  });
});
