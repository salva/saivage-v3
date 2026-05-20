import { describe, it, expect, afterEach } from '@jest/globals';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
  rmSync,
  mkdirSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  AuthProfileRecoveryRequiredError,
  AuthProfileStore,
  type AuthProfile,
} from '../../src/auth/auth-profile-store.js';
import {
  deleteAuthProfile,
  loadAuthProfiles,
  saveAuthProfile,
} from '../../src/auth/oauth-profiles.js';

let testRoots: string[] = [];

function makeProjectRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'saivage-auth-store-test-'));
  testRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of testRoots) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
  testRoots = [];
});

function authFilePath(root: string): string {
  return join(root, '.saivage', 'auth-profiles.json');
}

function authDir(root: string): string {
  return join(root, '.saivage');
}

function writeAuthProfiles(root: string, content: string, mode = 0o644): void {
  mkdirSync(authDir(root), { recursive: true });
  writeFileSync(authFilePath(root), content, { mode });
}

function makeProfile(overrides: Partial<AuthProfile> = {}): AuthProfile {
  return {
    type: 'oauth',
    provider: 'synthetic-provider',
    accessToken: 'at-synthetic-access-token',
    refreshToken: 'rt-synthetic-refresh-token',
    expiresAt: 1893456000000,
    ...overrides,
  };
}

function canonicalJson(profiles: Record<string, AuthProfile>): string {
  return JSON.stringify({ version: 1, profiles }, null, 2) + '\n';
}

function tempFiles(root: string): string[] {
  if (!existsSync(authDir(root))) return [];
  return readdirSync(authDir(root)).filter((name) => name.includes('.tmp'));
}

function expectRestrictiveMode(path: string): void {
  const mode = statSync(path).mode & 0o777;
  expect(mode & 0o077).toBe(0);
}

function expectNoRawSecrets(output: string): void {
  expect(output).not.toContain('at-synthetic-access-token');
  expect(output).not.toContain('rt-synthetic-refresh-token');
  expect(output).not.toContain('accessToken');
  expect(output).not.toContain('refreshToken');
  expect(output).not.toContain('access');
  expect(output).not.toContain('refresh');
}

describe('AuthProfileStore read states', () => {
  it('classifies an absent auth profile store', async () => {
    const root = makeProjectRoot();
    const state = await new AuthProfileStore(root).read();
    expect(state.state).toBe('absent');
    await expect(loadAuthProfiles(root)).resolves.toBeNull();
  });

  it('classifies and normalizes a loaded auth profile store', async () => {
    const root = makeProjectRoot();
    writeAuthProfiles(root, JSON.stringify({
      version: 1,
      profiles: {
        shorthand: {
          provider: 'synthetic-provider',
          access: 'at-synthetic-access-token',
          refresh: 'rt-synthetic-refresh-token',
          expires: 1893456000000,
        },
      },
    }));

    const state = await new AuthProfileStore(root).read();
    expect(state.state).toBe('loaded');
    if (state.state === 'loaded') {
      expect(state.file.profiles['shorthand'].accessToken).toBe('at-synthetic-access-token');
      expect(state.file.profiles['shorthand'].refreshToken).toBe('rt-synthetic-refresh-token');
    }
    expectRestrictiveMode(authFilePath(root));
  });

  it('classifies corrupt JSON without exposing raw file content', async () => {
    const root = makeProjectRoot();
    writeAuthProfiles(root, '{ invalid json at-synthetic-access-token rt-synthetic-refresh-token }');

    const state = await new AuthProfileStore(root).read();
    expect(state.state).toBe('corrupt_json');
    if (state.state === 'corrupt_json') {
      expectNoRawSecrets(state.causeMessage);
    }
    await expect(loadAuthProfiles(root)).rejects.toThrow(/parse/i);
  });

  it('classifies invalid schema and keeps diagnostics token-safe', async () => {
    const root = makeProjectRoot();
    writeAuthProfiles(root, JSON.stringify({
      version: 1,
      profiles: {
        bad: {
          provider: 'synthetic-provider',
          refreshToken: 'rt-synthetic-refresh-token',
        },
      },
    }));

    const state = await new AuthProfileStore(root).read();
    expect(state.state).toBe('invalid_schema');
    if (state.state === 'invalid_schema') {
      expect(state.causeMessage).toContain('missing required credential');
      expectNoRawSecrets(state.causeMessage);
    }
    await expect(loadAuthProfiles(root)).rejects.toThrow(/missing required credential|missing access token/i);
  });
});

describe('AuthProfileStore atomic persistence', () => {
  it('saves an absent store atomically with restrictive mode and no temp files left behind', async () => {
    const root = makeProjectRoot();
    await new AuthProfileStore(root).saveProfile('synthetic', makeProfile());

    expect(existsSync(authFilePath(root))).toBe(true);
    expectRestrictiveMode(authFilePath(root));
    expect(tempFiles(root)).toEqual([]);

    const loaded = await loadAuthProfiles(root);
    expect(loaded!.profiles['synthetic'].accessToken).toBe('at-synthetic-access-token');
  });

  it('deletes from a loaded store atomically and leaves no temp files behind', async () => {
    const root = makeProjectRoot();
    writeAuthProfiles(root, canonicalJson({
      keep: makeProfile({ provider: 'keep' }),
      remove: makeProfile({ provider: 'remove' }),
    }));

    await new AuthProfileStore(root).deleteProfile('remove');

    const loaded = await loadAuthProfiles(root);
    expect(Object.keys(loaded!.profiles)).toEqual(['keep']);
    expectRestrictiveMode(authFilePath(root));
    expect(tempFiles(root)).toEqual([]);
  });

  it('cleans up temp files and leaves previous target intact on write failure', async () => {
    const root = makeProjectRoot();
    const original = canonicalJson({ keep: makeProfile({ accessToken: 'original-synthetic-access' }) });
    writeAuthProfiles(root, original, 0o600);

    const store = new AuthProfileStore(root, {
      atomicWriteOptions: { simulateFailureAt: 'write' },
      tempNameFactory: () => 'deterministic-write-failure',
    });

    await expect(store.saveProfile('new', makeProfile())).rejects.toThrow(/Failed to persist auth profiles atomically/);
    expect(readFileSync(authFilePath(root), 'utf-8')).toBe(original);
    expect(tempFiles(root)).toEqual([]);
  });

  it('cleans up temp files and leaves previous target intact on rename failure', async () => {
    const root = makeProjectRoot();
    const original = canonicalJson({ keep: makeProfile({ accessToken: 'original-synthetic-access' }) });
    writeAuthProfiles(root, original, 0o600);

    const store = new AuthProfileStore(root, {
      atomicWriteOptions: { simulateFailureAt: 'rename' },
      tempNameFactory: () => 'deterministic-rename-failure',
    });

    await expect(store.deleteProfile('keep')).rejects.toThrow(/Failed to persist auth profiles atomically/);
    expect(readFileSync(authFilePath(root), 'utf-8')).toBe(original);
    expect(tempFiles(root)).toEqual([]);
  });
});

describe('AuthProfileStore refusal semantics', () => {
  it('refuses save on corrupt JSON and preserves the original file', async () => {
    const root = makeProjectRoot();
    const corrupt = '{ invalid json at-synthetic-access-token rt-synthetic-refresh-token }';
    writeAuthProfiles(root, corrupt, 0o600);

    await expect(saveAuthProfile(root, 'new', makeProfile())).rejects.toBeInstanceOf(
      AuthProfileRecoveryRequiredError,
    );

    expect(readFileSync(authFilePath(root), 'utf-8')).toBe(corrupt);
    expect(tempFiles(root)).toEqual([]);
  });

  it('refuses delete on invalid schema and preserves the original file', async () => {
    const root = makeProjectRoot();
    const invalid = JSON.stringify({
      version: 1,
      profiles: {
        bad: { provider: 'synthetic-provider', refreshToken: 'rt-synthetic-refresh-token' },
      },
    });
    writeAuthProfiles(root, invalid, 0o600);

    await expect(deleteAuthProfile(root, 'bad')).rejects.toBeInstanceOf(
      AuthProfileRecoveryRequiredError,
    );

    expect(readFileSync(authFilePath(root), 'utf-8')).toBe(invalid);
    expect(tempFiles(root)).toEqual([]);
  });

  it('recovery-required errors expose only redacted metadata, not synthetic token values', async () => {
    const root = makeProjectRoot();
    writeAuthProfiles(root, '{ invalid json at-synthetic-access-token rt-synthetic-refresh-token }', 0o600);

    let caught: unknown;
    try {
      await saveAuthProfile(root, 'new', makeProfile());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AuthProfileRecoveryRequiredError);
    const message = String(caught);
    expect(message).toContain('corrupt_json');
    expect(message).toContain('ordinary write refused');
    expectNoRawSecrets(message);
    const details = (caught as AuthProfileRecoveryRequiredError).details;
    expect(details.state).toBe('corrupt_json');
    expect(details.action).toBe('refused');
    expectNoRawSecrets(JSON.stringify(details));
  });

  it('keeps public save/delete APIs compatible for clean stores', async () => {
    const root = makeProjectRoot();

    await saveAuthProfile(root, 'first', makeProfile({ provider: 'one' }));
    await saveAuthProfile(root, 'second', makeProfile({ provider: 'two' }));
    await deleteAuthProfile(root, 'first');
    await deleteAuthProfile(root, 'missing');

    const loaded = await loadAuthProfiles(root);
    expect(Object.keys(loaded!.profiles)).toEqual(['second']);
    expect(loaded!.profiles['second'].provider).toBe('two');
  });
});
