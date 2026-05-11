/**
 * OAuth Auth Profile Loader Tests
 *
 * Verifies:
 * - loadAuthProfiles() reads .saivage/auth-profiles.json and normalizes fields
 * - Canonical field names (accessToken, refreshToken, expiresAt) are handled
 * - Shorthand field names (access, refresh, expires) are handled
 * - File mode is set to 0o600 on read
 * - getAuthProfile() returns a single profile by name
 * - saveAuthProfile() writes with mode 0o600 and preserves existing profiles
 * - deleteAuthProfile() removes a profile from the file
 * - isProfileExpired() correctly detects expired and near-expiry tokens
 * - refreshAuthProfile() returns existing profile gracefully (logs warning)
 * - Profiles are blocked by existing file-access-security
 * - loadAuthProfiles() returns null for missing file
 * - Validation rejects malformed profiles
 * - Both field formats coexist in the same file
 */

import { describe, it, expect, afterEach, beforeEach, jest } from '@jest/globals';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
  rmSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  loadAuthProfiles,
  getAuthProfile,
  saveAuthProfile,
  deleteAuthProfile,
  isProfileExpired,
  refreshAuthProfile,
  type AuthProfile,
} from '../../src/auth/oauth-profiles.js';

import {
  isReadBlocked,
  isSensitivePath,
} from '../../src/utils/file-access-security.js';

// ═══════════════════════════════════════════════════════════════
// Test helpers
// ═══════════════════════════════════════════════════════════════

let testRoots: string[] = [];

function makeProjectRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'saivage-oauth-test-'));
  testRoots.push(dir);
  return dir;
}

function writeAuthProfiles(projectRoot: string, content: string): void {
  const saivageDir = join(projectRoot, '.saivage');
  const filePath = join(saivageDir, 'auth-profiles.json');
  mkdirSync(saivageDir, { recursive: true });
  writeFileSync(filePath, content, { mode: 0o644 }); // insecure initially
}

afterEach(() => {
  // Clean up test directories
  for (const dir of testRoots) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
  testRoots = [];
});

function makeValidProfile(overrides: Partial<AuthProfile> = {}): AuthProfile {
  return {
    type: 'oauth',
    provider: 'test-provider',
    accessToken: 'at-test-token-123',
    refreshToken: 'rt-test-token-456',
    expiresAt: Date.now() + 3600_000, // 1 hour from now
    ...overrides,
  };
}

function canonicalJson(profiles: Record<string, AuthProfile>): string {
  const obj = {
    version: 1,
    profiles: {} as Record<string, Record<string, unknown>>,
  };
  for (const [name, p] of Object.entries(profiles)) {
    const entry: Record<string, unknown> = {
      type: p.type,
      provider: p.provider,
      accessToken: p.accessToken,
    };
    if (p.refreshToken !== undefined) entry['refreshToken'] = p.refreshToken;
    if (p.expiresAt !== undefined) entry['expiresAt'] = p.expiresAt;
    obj.profiles[name] = entry;
  }
  return JSON.stringify(obj, null, 2);
}

function shorthandJson(profiles: Record<string, Record<string, unknown>>): string {
  const obj = {
    version: 1,
    profiles,
  };
  return JSON.stringify(obj, null, 2);
}


// ── Mock fetch helpers ────────────────────────────────────────

/** Install a mock for globalThis.fetch. Returns the mock. */
function mockFetch(
  responseFactory: (url: string, init: RequestInit) => Response | Promise<Response>,
): jest.Mock {
  const mock = jest.fn((url: string, init: RequestInit) => {
    return Promise.resolve(responseFactory(url, init));
  }) as jest.Mock;
  (globalThis as Record<string, unknown>).fetch = mock;
  return mock;
}

/** Restore the original globalThis.fetch (if saved). */
function restoreFetch(originalFetch: typeof globalThis.fetch): void {
  (globalThis as Record<string, unknown>).fetch = originalFetch;
}

/** Build a standard OAuth2 token success response. */
function oauthTokenResponse(overrides: Record<string, unknown> = {}): object {
  return {
    access_token: 'new-access-token-abc',
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: 'new-refresh-token-xyz',
    scope: 'read write',
    ...overrides,
  };
}

/** Build a mock Response object (Node 18+ compatible). */
function mockResponse(
  body: unknown,
  status: number = 200,
  ok: boolean = true,
  headers: Record<string, string> = { 'Content-Type': 'application/json' },
): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : status === 400 ? 'Bad Request' : 'Internal Server Error',
    headers: new Headers(headers),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(
      typeof body === 'string' ? body : JSON.stringify(body),
    ),
    // Minimal stubs
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    blob: () => Promise.resolve(new Blob()),
    formData: () => Promise.resolve(new FormData()),
    clone: function () { return this; },
    body: null,
    bodyUsed: false,
    redirected: false,
    type: 'basic' as ResponseType,
    url: '',
  } as Response;
}

// ═══════════════════════════════════════════════════════════════
// loadAuthProfiles
// ═══════════════════════════════════════════════════════════════

describe('loadAuthProfiles', () => {
  it('returns null when the file does not exist', async () => {
    const root = makeProjectRoot();
    const result = await loadAuthProfiles(root);
    expect(result).toBeNull();
  });

  it('loads and normalizes canonical field names', async () => {
    const root = makeProjectRoot();
    const content = canonicalJson({
      'my-profile': {
        type: 'oauth',
        provider: 'test',
        accessToken: 'at-abc',
        refreshToken: 'rt-xyz',
        expiresAt: 1778576995998,
      },
    });
    writeAuthProfiles(root, content);

    const result = await loadAuthProfiles(root);
    expect(result).not.toBeNull();
    expect(result!.version).toBe(1);
    expect(result!.profiles['my-profile']).toBeDefined();
    expect(result!.profiles['my-profile'].accessToken).toBe('at-abc');
    expect(result!.profiles['my-profile'].refreshToken).toBe('rt-xyz');
    expect(result!.profiles['my-profile'].expiresAt).toBe(1778576995998);
    expect(result!.profiles['my-profile'].provider).toBe('test');
    expect(result!.profiles['my-profile'].type).toBe('oauth');
  });

  it('loads and normalizes shorthand field names (access/refresh/expires)', async () => {
    const root = makeProjectRoot();
    const content = shorthandJson({
      'shorthand-profile': {
        type: 'oauth',
        provider: 'shorthand-provider',
        access: 'sh-access-token',
        refresh: 'sh-refresh-token',
        expires: 1778576995998,
      },
    });
    writeAuthProfiles(root, content);

    const result = await loadAuthProfiles(root);
    expect(result).not.toBeNull();
    expect(result!.profiles['shorthand-profile'].accessToken).toBe('sh-access-token');
    expect(result!.profiles['shorthand-profile'].refreshToken).toBe('sh-refresh-token');
    expect(result!.profiles['shorthand-profile'].expiresAt).toBe(1778576995998);
    expect(result!.profiles['shorthand-profile'].provider).toBe('shorthand-provider');
  });

  it('loads the real auth-profiles.json from the project', async () => {
    const result = await loadAuthProfiles('/work/saivage-v3');
    expect(result).not.toBeNull();
    expect(result!.version).toBe(1);
    // The real file uses shorthand field names
    const profileNames = Object.keys(result!.profiles);
    expect(profileNames.length).toBeGreaterThanOrEqual(1);
    for (const name of profileNames) {
      const profile = result!.profiles[name];
      expect(profile.accessToken).toBeTruthy();
      expect(profile.provider).toBeTruthy();
    }
  });

  it('sets file mode to 0600 after reading', async () => {
    const root = makeProjectRoot();

    // Write with insecure mode first
    const filePath = join(root, '.saivage', 'auth-profiles.json');
    mkdirSync(join(root, '.saivage'), { recursive: true });
    writeFileSync(filePath, canonicalJson({ 'p1': makeValidProfile() }), { mode: 0o644 });

    // Verify it's 644 before load
    const beforeStat = statSync(filePath);
    expect(beforeStat.mode & 0o777).toBe(0o644);

    // Load (should chmod to 0600)
    await loadAuthProfiles(root);

    // Verify it's now 0600
    const afterStat = statSync(filePath);
    const mode = afterStat.mode & 0o777;
    // On some systems, umask may affect this; check that the file is
    // at least not world/group readable
    expect(mode & 0o077).toBe(0); // No group/other permissions
    // The mode should be exactly 0o600 or related restrictive
    // (umask can tighten it further to 0o400 or 0o000)
    expect([0o600, 0o400, 0o000].includes(mode)).toBe(true);
  });

  it('handles multiple profiles in one file', async () => {
    const root = makeProjectRoot();
    const content = canonicalJson({
      'p1': { type: 'oauth', provider: 'a', accessToken: 'at1' },
      'p2': { type: 'oauth', provider: 'b', accessToken: 'at2', refreshToken: 'rt2' },
      'p3': { type: 'oauth', provider: 'c', accessToken: 'at3', expiresAt: 1000 },
    });
    writeAuthProfiles(root, content);

    const result = await loadAuthProfiles(root);
    expect(result).not.toBeNull();
    expect(Object.keys(result!.profiles)).toHaveLength(3);
    expect(result!.profiles['p2'].refreshToken).toBe('rt2');
    expect(result!.profiles['p3'].expiresAt).toBe(1000);
  });

  it('throws on malformed JSON', async () => {
    const root = makeProjectRoot();
    writeAuthProfiles(root, '{ this is not valid json }');

    await expect(loadAuthProfiles(root)).rejects.toThrow(/parse/i);
  });

  it('throws when a profile is missing both accessToken and access', async () => {
    const root = makeProjectRoot();
    const content = shorthandJson({
      'bad-profile': {
        type: 'oauth',
        provider: 'test',
        // no access or accessToken
      },
    });
    writeAuthProfiles(root, content);

    await expect(loadAuthProfiles(root)).rejects.toThrow(/missing access token/i);
  });

  it('throws when validation fails (missing provider)', async () => {
    const root = makeProjectRoot();
    const content = shorthandJson({
      'bad-profile': {
        type: 'oauth',
        access: 'some-token',
        // provider is missing
      },
    });
    writeAuthProfiles(root, content);

    await expect(loadAuthProfiles(root)).rejects.toThrow(/validation/i);
  });

  it('handles empty profiles object', async () => {
    const root = makeProjectRoot();
    const content = JSON.stringify({ version: 1, profiles: {} });
    writeAuthProfiles(root, content);

    const result = await loadAuthProfiles(root);
    expect(result).not.toBeNull();
    expect(result!.profiles).toEqual({});
  });

  it('defaults version to 1 when missing', async () => {
    const root = makeProjectRoot();
    const content = JSON.stringify({
      profiles: {
        'p1': {
          provider: 'test',
          accessToken: 'tok',
        },
      },
    });
    writeAuthProfiles(root, content);

    const result = await loadAuthProfiles(root);
    expect(result).not.toBeNull();
    expect(result!.version).toBe(1);
  });

  it('defaults type to oauth when missing', async () => {
    const root = makeProjectRoot();
    const content = shorthandJson({
      'p1': {
        provider: 'test',
        access: 'tok',
      },
    });
    writeAuthProfiles(root, content);

    const result = await loadAuthProfiles(root);
    expect(result!.profiles['p1'].type).toBe('oauth');
  });

  it('handles mixed canonical and shorthand fields in same file', async () => {
    const root = makeProjectRoot();
    const content = JSON.stringify({
      version: 1,
      profiles: {
        canonical: {
          type: 'oauth',
          provider: 'p1',
          accessToken: 'at-1',
          refreshToken: 'rt-1',
          expiresAt: 100,
        },
        shorthand: {
          type: 'oauth',
          provider: 'p2',
          access: 'at-2',
          refresh: 'rt-2',
          expires: 200,
        },
      },
    });
    writeAuthProfiles(root, content);

    const result = await loadAuthProfiles(root);
    expect(result!.profiles['canonical'].accessToken).toBe('at-1');
    expect(result!.profiles['canonical'].expiresAt).toBe(100);
    expect(result!.profiles['shorthand'].accessToken).toBe('at-2');
    expect(result!.profiles['shorthand'].expiresAt).toBe(200);
  });

  it('canonical fields take precedence over shorthand when both present', async () => {
    const root = makeProjectRoot();
    const content = JSON.stringify({
      version: 1,
      profiles: {
        mixed: {
          provider: 'test',
          accessToken: 'canonical-at',
          access: 'shorthand-at',
          refreshToken: 'canonical-rt',
          refresh: 'shorthand-rt',
          expiresAt: 999,
          expires: 111,
        },
      },
    });
    writeAuthProfiles(root, content);

    const result = await loadAuthProfiles(root);
    // Canonical takes precedence
    expect(result!.profiles['mixed'].accessToken).toBe('canonical-at');
    expect(result!.profiles['mixed'].refreshToken).toBe('canonical-rt');
    expect(result!.profiles['mixed'].expiresAt).toBe(999);
  });
});

// ═══════════════════════════════════════════════════════════════
// getAuthProfile
// ═══════════════════════════════════════════════════════════════

describe('getAuthProfile', () => {
  it('returns a profile by name', async () => {
    const root = makeProjectRoot();
    const content = canonicalJson({
      'target': makeValidProfile({ provider: 'target-provider' }),
      'other': makeValidProfile({ provider: 'other-provider' }),
    });
    writeAuthProfiles(root, content);

    const profile = await getAuthProfile(root, 'target');
    expect(profile).not.toBeNull();
    expect(profile!.provider).toBe('target-provider');
    expect(profile!.accessToken).toBe('at-test-token-123');
  });

  it('returns null for a non-existent profile name', async () => {
    const root = makeProjectRoot();
    const content = canonicalJson({
      'existing': makeValidProfile(),
    });
    writeAuthProfiles(root, content);

    const profile = await getAuthProfile(root, 'nonexistent');
    expect(profile).toBeNull();
  });

  it('returns null when the file does not exist', async () => {
    const root = makeProjectRoot();
    const profile = await getAuthProfile(root, 'anything');
    expect(profile).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// saveAuthProfile
// ═══════════════════════════════════════════════════════════════

describe('saveAuthProfile', () => {
  it('creates a new auth profiles file when none exists', async () => {
    const root = makeProjectRoot();
    const profile = makeValidProfile({ provider: 'new-provider' });

    await saveAuthProfile(root, 'new-profile', profile);

    const result = await loadAuthProfiles(root);
    expect(result).not.toBeNull();
    expect(result!.profiles['new-profile'].provider).toBe('new-provider');
    expect(result!.profiles['new-profile'].accessToken).toBe('at-test-token-123');

    // Verify file mode
    const filePath = join(root, '.saivage', 'auth-profiles.json');
    const stat = statSync(filePath);
    expect(stat.mode & 0o077).toBe(0); // No group/other permissions
  });

  it('adds a profile to an existing file', async () => {
    const root = makeProjectRoot();
    const content = canonicalJson({
      'existing': makeValidProfile({ provider: 'existing' }),
    });
    writeAuthProfiles(root, content);

    await saveAuthProfile(root, 'new-profile', makeValidProfile({ provider: 'new' }));

    const result = await loadAuthProfiles(root);
    expect(Object.keys(result!.profiles)).toHaveLength(2);
    expect(result!.profiles['existing'].provider).toBe('existing');
    expect(result!.profiles['new-profile'].provider).toBe('new');
  });

  it('overwrites an existing profile', async () => {
    const root = makeProjectRoot();
    const content = canonicalJson({
      'profile': makeValidProfile({ provider: 'old', accessToken: 'old-token' }),
    });
    writeAuthProfiles(root, content);

    await saveAuthProfile(root, 'profile', makeValidProfile({ provider: 'updated', accessToken: 'new-token' }));

    const result = await loadAuthProfiles(root);
    expect(Object.keys(result!.profiles)).toHaveLength(1);
    expect(result!.profiles['profile'].provider).toBe('updated');
    expect(result!.profiles['profile'].accessToken).toBe('new-token');
  });

  it('writes with mode 0600', async () => {
    const root = makeProjectRoot();

    await saveAuthProfile(root, 'p1', makeValidProfile());

    const filePath = join(root, '.saivage', 'auth-profiles.json');
    const stat = statSync(filePath);
    const mode = stat.mode & 0o777;
    expect([0o600, 0o400, 0o000].includes(mode)).toBe(true);
    expect(mode & 0o077).toBe(0); // No group/other permissions
  });

  it('preserves refreshToken when saving', async () => {
    const root = makeProjectRoot();
    const profile = makeValidProfile({
      refreshToken: 'my-refresh-token',
      expiresAt: Date.now() + 5000,
    });

    await saveAuthProfile(root, 'p1', profile);

    const result = await loadAuthProfiles(root);
    expect(result!.profiles['p1'].refreshToken).toBe('my-refresh-token');
    expect(result!.profiles['p1'].expiresAt).toBe(profile.expiresAt);
  });

  it('omits refreshToken from serialized JSON when undefined', async () => {
    const root = makeProjectRoot();
    const profile = makeValidProfile();
    delete (profile as Partial<AuthProfile>).refreshToken;

    await saveAuthProfile(root, 'p1', profile);

    const filePath = join(root, '.saivage', 'auth-profiles.json');
    const raw = readFileSync(filePath, 'utf-8');
    expect(raw).not.toContain('refreshToken'); // omitted entirely
  });

  it('omits expiresAt from serialized JSON when undefined', async () => {
    const root = makeProjectRoot();
    const profile = makeValidProfile();
    delete (profile as Partial<AuthProfile>).expiresAt;

    await saveAuthProfile(root, 'p1', profile);

    const filePath = join(root, '.saivage', 'auth-profiles.json');
    const raw = readFileSync(filePath, 'utf-8');
    expect(raw).not.toContain('expiresAt');
  });
});

// ═══════════════════════════════════════════════════════════════
// deleteAuthProfile
// ═══════════════════════════════════════════════════════════════

describe('deleteAuthProfile', () => {
  it('removes a profile from the file', async () => {
    const root = makeProjectRoot();
    const content = canonicalJson({
      'keep': makeValidProfile({ provider: 'keep' }),
      'remove': makeValidProfile({ provider: 'remove' }),
    });
    writeAuthProfiles(root, content);

    await deleteAuthProfile(root, 'remove');

    const result = await loadAuthProfiles(root);
    expect(Object.keys(result!.profiles)).toHaveLength(1);
    expect(result!.profiles['keep']).toBeDefined();
    expect(result!.profiles['remove']).toBeUndefined();
  });

  it('is a no-op when the profile does not exist', async () => {
    const root = makeProjectRoot();
    const content = canonicalJson({
      'keep': makeValidProfile(),
    });
    writeAuthProfiles(root, content);

    await deleteAuthProfile(root, 'nonexistent');

    const result = await loadAuthProfiles(root);
    expect(Object.keys(result!.profiles)).toHaveLength(1);
    expect(result!.profiles['keep']).toBeDefined();
  });

  it('is a no-op when the file does not exist', async () => {
    const root = makeProjectRoot();
    // Should not throw
    await deleteAuthProfile(root, 'anything');
  });

  it('deletes the last profile, leaving an empty profiles map', async () => {
    const root = makeProjectRoot();
    const content = canonicalJson({
      'only': makeValidProfile(),
    });
    writeAuthProfiles(root, content);

    await deleteAuthProfile(root, 'only');

    const result = await loadAuthProfiles(root);
    expect(result).not.toBeNull();
    expect(result!.profiles).toEqual({});
  });
});

// ═══════════════════════════════════════════════════════════════
// isProfileExpired
// ═══════════════════════════════════════════════════════════════

describe('isProfileExpired', () => {
  it('returns false for a future expiry', () => {
    const profile = makeValidProfile({ expiresAt: Date.now() + 3600_000 });
    expect(isProfileExpired(profile)).toBe(false);
  });

  it('returns true for a past expiry', () => {
    const profile = makeValidProfile({ expiresAt: Date.now() - 1000 });
    expect(isProfileExpired(profile)).toBe(true);
  });

  it('returns false when no expiry is set', () => {
    const profile = makeValidProfile();
    delete (profile as Partial<AuthProfile>).expiresAt;
    expect(isProfileExpired(profile)).toBe(false);
  });

  it('returns true when expiry is within the buffer window', () => {
    // Expires in 30 seconds, default buffer is 60 seconds
    const profile = makeValidProfile({ expiresAt: Date.now() + 30_000 });
    expect(isProfileExpired(profile)).toBe(true);
  });

  it('returns false when expiry is outside the buffer window', () => {
    // Expires in 2 minutes, default buffer is 60 seconds
    const profile = makeValidProfile({ expiresAt: Date.now() + 120_000 });
    expect(isProfileExpired(profile)).toBe(false);
  });

  it('respects custom bufferMs', () => {
    // Expires in 10 seconds, buffer of 5 seconds
    const profile = makeValidProfile({ expiresAt: Date.now() + 10_000 });
    expect(isProfileExpired(profile, 5_000)).toBe(false);

    // Same expiry, buffer of 15 seconds
    expect(isProfileExpired(profile, 15_000)).toBe(true);
  });

  it('returns true for exactly-at-expiry with zero buffer', () => {
    const now = Date.now();
    const profile = makeValidProfile({ expiresAt: now });
    expect(isProfileExpired(profile, 0)).toBe(true);
  });

  it('returns false for exactly-at-expiry with negative buffer (unrealistic but handled)', () => {
    const now = Date.now();
    const profile = makeValidProfile({ expiresAt: now });
    // Negative buffer means "expired only after expiry + buffer"
    expect(isProfileExpired(profile, -1000)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// refreshAuthProfile — mock-based HTTP tests
// ═══════════════════════════════════════════════════════════════

describe('refreshAuthProfile', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).fetch = originalFetch;
    jest.restoreAllMocks();
  });

  // ── Graceful pre-flight failures (no HTTP call needed) ──────

  it('returns null when the profile does not exist', async () => {
    const root = makeProjectRoot();
    const result = await refreshAuthProfile(root, 'nonexistent');
    expect(result).toBeNull();
  });

  it('returns null when the profile has no refresh token', async () => {
    const root = makeProjectRoot();
    const profile = makeValidProfile();
    delete (profile as Partial<AuthProfile>).refreshToken;
    const content = canonicalJson({ 'no-rt': profile });
    writeAuthProfiles(root, content);

    const result = await refreshAuthProfile(root, 'no-rt');
    expect(result).toBeNull();
  });

  it('returns null when no token endpoint is provided (profile exists and has refresh token)', async () => {
    const root = makeProjectRoot();
    const profile = makeValidProfile({
      provider: 'test',
      accessToken: 'original-at',
      refreshToken: 'original-rt',
    });
    const content = canonicalJson({ 'p1': profile });
    writeAuthProfiles(root, content);

    // Without a tokenEndpoint, refresh is gracefully skipped
    const result = await refreshAuthProfile(root, 'p1');
    expect(result).toBeNull();
  });

  // ── Successful refresh ──────────────────────────────────────

  it('POSTs to tokenEndpoint with correct URL, method, headers, and form-encoded body', async () => {
    const root = makeProjectRoot();
    const profile = makeValidProfile({
      provider: 'test',
      accessToken: 'original-at',
      refreshToken: 'original-rt',
    });
    const content = canonicalJson({ 'p1': profile });
    writeAuthProfiles(root, content);

    const fetchMock = mockFetch((_url, _init) => {
      return mockResponse(oauthTokenResponse(), 200);
    });

    await refreshAuthProfile(root, 'p1', 'https://example.com/oauth/token');

    // Verify fetch was called
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const callUrl = fetchMock.mock.calls[0][0] as string;
    const callInit = fetchMock.mock.calls[0][1] as RequestInit;

    // URL
    expect(callUrl).toBe('https://example.com/oauth/token');

    // Method
    expect(callInit.method).toBe('POST');

    // Headers
    expect(callInit.headers).toBeDefined();
    const headers = callInit.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(headers['Accept']).toBe('application/json');

    // Body — should contain form-encoded grant_type and refresh_token
    const body = callInit.body as string;
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('refresh_token=original-rt');
  });

  it('parses valid OAuth2 JSON response and reads access_token, refresh_token, expires_in', async () => {
    const root = makeProjectRoot();
    const profile = makeValidProfile({
      provider: 'test',
      accessToken: 'original-at',
      refreshToken: 'original-rt',
      expiresAt: Date.now() - 1000, // already expired
    });
    const content = canonicalJson({ 'p1': profile });
    writeAuthProfiles(root, content);

    const beforeRefresh = Date.now();

    mockFetch((_url, _init) => {
      return mockResponse(
        oauthTokenResponse({
          access_token: 'fresh-at-token',
          refresh_token: 'fresh-rt-token',
          expires_in: 7200,
        }),
        200,
      );
    });

    const result = await refreshAuthProfile(
      root, 'p1', 'https://example.com/oauth/token',
    );

    expect(result).not.toBeNull();
    expect(result!.accessToken).toBe('fresh-at-token');
    expect(result!.refreshToken).toBe('fresh-rt-token');
    // expiresAt should be computed from Date.now() + expires_in * 1000
    expect(result!.expiresAt).toBeDefined();
    expect(result!.expiresAt!).toBeGreaterThanOrEqual(beforeRefresh + 7200 * 1000 - 5000);
    expect(result!.expiresAt!).toBeLessThanOrEqual(Date.now() + 7200 * 1000 + 5000);
  });

  it('saves updated profile via saveAuthProfile() and persists to disk', async () => {
    const root = makeProjectRoot();
    const profile = makeValidProfile({
      provider: 'test',
      accessToken: 'original-at',
      refreshToken: 'original-rt',
      expiresAt: Date.now() - 1000,
    });
    const content = canonicalJson({ 'p1': profile });
    writeAuthProfiles(root, content);

    mockFetch((_url, _init) => {
      return mockResponse(
        oauthTokenResponse({
          access_token: 'persisted-at',
          refresh_token: 'persisted-rt',
          expires_in: 1800,
        }),
        200,
      );
    });

    const result = await refreshAuthProfile(
      root, 'p1', 'https://example.com/oauth/token',
    );

    expect(result).not.toBeNull();

    // Re-load from disk — should have the updated tokens
    const reloaded = await getAuthProfile(root, 'p1');
    expect(reloaded).not.toBeNull();
    expect(reloaded!.accessToken).toBe('persisted-at');
    expect(reloaded!.refreshToken).toBe('persisted-rt');
    expect(reloaded!.expiresAt).toBeDefined();
  });

  it('sets expiresAt to Date.now() + expires_in * 1000 from response', async () => {
    const root = makeProjectRoot();
    const profile = makeValidProfile({
      provider: 'test',
      accessToken: 'original-at',
      refreshToken: 'original-rt',
    });
    const content = canonicalJson({ 'p1': profile });
    writeAuthProfiles(root, content);

    const beforeCall = Date.now();

    mockFetch((_url, _init) => {
      return mockResponse(
        oauthTokenResponse({
          access_token: 'expiry-at',
          expires_in: 900, // 15 minutes
        }),
        200,
      );
    });

    const result = await refreshAuthProfile(
      root, 'p1', 'https://example.com/oauth/token',
    );

    expect(result).not.toBeNull();
    const expectedMin = beforeCall + 900 * 1000;
    const expectedMax = Date.now() + 900 * 1000;
    expect(result!.expiresAt!).toBeGreaterThanOrEqual(expectedMin - 2000); // allow 2s clock drift
    expect(result!.expiresAt!).toBeLessThanOrEqual(expectedMax + 2000);
  });

  it('falls back to original refreshToken when response does not include refresh_token', async () => {
    const root = makeProjectRoot();
    const profile = makeValidProfile({
      provider: 'test',
      accessToken: 'original-at',
      refreshToken: 'keep-this-rt',
    });
    const content = canonicalJson({ 'p1': profile });
    writeAuthProfiles(root, content);

    mockFetch((_url, _init) => {
      return mockResponse(
        { access_token: 'new-at', expires_in: 3600 },
        // No refresh_token → original should be kept
        200,
      );
    });

    const result = await refreshAuthProfile(
      root, 'p1', 'https://example.com/oauth/token',
    );

    expect(result).not.toBeNull();
    expect(result!.accessToken).toBe('new-at');
    expect(result!.refreshToken).toBe('keep-this-rt');
  });

  it('falls back to original expiresAt when response does not include expires_in', async () => {
    const root = makeProjectRoot();
    const originalExpiry = Date.now() + 999_000;
    const profile = makeValidProfile({
      provider: 'test',
      accessToken: 'original-at',
      refreshToken: 'original-rt',
      expiresAt: originalExpiry,
    });
    const content = canonicalJson({ 'p1': profile });
    writeAuthProfiles(root, content);

    mockFetch((_url, _init) => {
      return mockResponse(
        { access_token: 'new-at' },
        // No expires_in → original expiresAt should be kept
        200,
      );
    });

    const result = await refreshAuthProfile(
      root, 'p1', 'https://example.com/oauth/token',
    );

    expect(result).not.toBeNull();
    expect(result!.expiresAt).toBe(originalExpiry);
  });

  // ── Graceful failure on HTTP errors ─────────────────────────

  it('returns null on HTTP 400 (invalid_grant) and logs error', async () => {
    const root = makeProjectRoot();
    const profile = makeValidProfile({
      provider: 'test',
      accessToken: 'original-at',
      refreshToken: 'original-rt',
    });
    const content = canonicalJson({ 'p1': profile });
    writeAuthProfiles(root, content);

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    mockFetch((_url, _init) => {
      return mockResponse(
        { error: 'invalid_grant', error_description: 'Token expired/revoked' },
        400,
        false,
      );
    });

    const result = await refreshAuthProfile(
      root, 'p1', 'https://example.com/oauth/token',
    );

    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('HTTP 400'),
    );

    consoleSpy.mockRestore();
  });

  it('returns null on HTTP 500 (server error) and logs error', async () => {
    const root = makeProjectRoot();
    const profile = makeValidProfile({
      provider: 'test',
      accessToken: 'original-at',
      refreshToken: 'original-rt',
    });
    const content = canonicalJson({ 'p1': profile });
    writeAuthProfiles(root, content);

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    mockFetch((_url, _init) => {
      return mockResponse(
        'Internal Server Error',
        500,
        false,
        { 'Content-Type': 'text/plain' },
      );
    });

    const result = await refreshAuthProfile(
      root, 'p1', 'https://example.com/oauth/token',
    );

    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('HTTP 500'),
    );

    consoleSpy.mockRestore();
  });

  it('returns null on network error (fetch throws) and logs error', async () => {
    const root = makeProjectRoot();
    const profile = makeValidProfile({
      provider: 'test',
      accessToken: 'original-at',
      refreshToken: 'original-rt',
    });
    const content = canonicalJson({ 'p1': profile });
    writeAuthProfiles(root, content);

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    mockFetch((_url, _init) => {
      throw new Error('ECONNREFUSED');
    });

    const result = await refreshAuthProfile(
      root, 'p1', 'https://example.com/oauth/token',
    );

    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('ECONNREFUSED'),
    );

    consoleSpy.mockRestore();
  });

  it('returns null on non-JSON response and logs error', async () => {
    const root = makeProjectRoot();
    const profile = makeValidProfile({
      provider: 'test',
      accessToken: 'original-at',
      refreshToken: 'original-rt',
    });
    const content = canonicalJson({ 'p1': profile });
    writeAuthProfiles(root, content);

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    // response.json() throws (simulating non-JSON response)
    mockFetch((_url, _init) => {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'Content-Type': 'text/html' }),
        json: () => Promise.reject(new Error('Unexpected token <')),
        text: () => Promise.resolve('<html>nope</html>'),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
        blob: () => Promise.resolve(new Blob()),
        formData: () => Promise.resolve(new FormData()),
        clone: function () { return this; },
        body: null,
        bodyUsed: false,
        redirected: false,
        type: 'basic' as ResponseType,
        url: '',
      } as Response;
    });

    const result = await refreshAuthProfile(
      root, 'p1', 'https://example.com/oauth/token',
    );

    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('non-JSON'),
    );

    consoleSpy.mockRestore();
  });

  it('returns null when response JSON is missing access_token and logs error', async () => {
    const root = makeProjectRoot();
    const profile = makeValidProfile({
      provider: 'test',
      accessToken: 'original-at',
      refreshToken: 'original-rt',
    });
    const content = canonicalJson({ 'p1': profile });
    writeAuthProfiles(root, content);

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    mockFetch((_url, _init) => {
      return mockResponse(
        { refresh_token: 'rt-only', expires_in: 3600 },
        // No access_token field — malformed response
        200,
      );
    });

    const result = await refreshAuthProfile(
      root, 'p1', 'https://example.com/oauth/token',
    );

    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('missing access_token'),
    );

    consoleSpy.mockRestore();
  });

  it('returns null on network error as rejected promise (fetch throws via rejection)', async () => {
    const root = makeProjectRoot();
    const profile = makeValidProfile({
      provider: 'test',
      accessToken: 'original-at',
      refreshToken: 'original-rt',
    });
    const content = canonicalJson({ 'p1': profile });
    writeAuthProfiles(root, content);

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    // fetch returns a rejected promise
    (globalThis as Record<string, unknown>).fetch = () =>
      Promise.reject(new Error('ETIMEDOUT'));

    const result = await refreshAuthProfile(
      root, 'p1', 'https://example.com/oauth/token',
    );

    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('ETIMEDOUT'),
    );

    consoleSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════
// Cross-check with file-access-security
// ═══════════════════════════════════════════════════════════════

describe('file-access-security integration', () => {
  it('auth-profiles.json is a known sensitive path', () => {
    expect(isSensitivePath('.saivage/auth-profiles.json')).toBe(true);
  });

  it('auth-profiles.json is blocked from read by agents', () => {
    expect(isReadBlocked('.saivage/auth-profiles.json')).toBe(true);
    expect(isReadBlocked('./.saivage/auth-profiles.json')).toBe(true);
  });

  it('auth-profiles.json is blocked with .. traversal variants', () => {
    // The file-access-security module handles normalization, so
    // .. tricks that resolve to the same path are caught
    expect(isReadBlocked('.saivage/foo/../auth-profiles.json')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// Edge cases and robustness
// ═══════════════════════════════════════════════════════════════

describe('edge cases', () => {
  it('handle profile with only access token and provider (minimal valid)', async () => {
    const root = makeProjectRoot();
    const content = shorthandJson({
      'minimal': {
        provider: 'min-provider',
        access: 'min-access',
      },
    });
    writeAuthProfiles(root, content);

    const result = await loadAuthProfiles(root);
    expect(result!.profiles['minimal'].provider).toBe('min-provider');
    expect(result!.profiles['minimal'].accessToken).toBe('min-access');
    expect(result!.profiles['minimal'].refreshToken).toBeUndefined();
    expect(result!.profiles['minimal'].expiresAt).toBeUndefined();
    expect(result!.profiles['minimal'].type).toBe('oauth');
  });

  it('handles zero-value expires timestamp', async () => {
    const root = makeProjectRoot();
    const content = shorthandJson({
      'zero-expiry': {
        provider: 'test',
        access: 'tok',
        expires: 0,
      },
    });
    writeAuthProfiles(root, content);

    const result = await loadAuthProfiles(root);
    expect(result!.profiles['zero-expiry'].expiresAt).toBe(0);
  });

  it('handles very large expiresAt timestamp', async () => {
    const root = makeProjectRoot();
    const content = shorthandJson({
      'far-future': {
        provider: 'test',
        access: 'tok',
        expires: 9999999999999,
      },
    });
    writeAuthProfiles(root, content);

    const result = await loadAuthProfiles(root);
    expect(result!.profiles['far-future'].expiresAt).toBe(9999999999999);
  });

  it('handles special characters in profile names', async () => {
    const root = makeProjectRoot();
    const content = shorthandJson({
      'profile-with-dashes': { provider: 'p1', access: 'tok1' },
      'profile.with.dots': { provider: 'p2', access: 'tok2' },
      'profile_with_underscores': { provider: 'p3', access: 'tok3' },
    });
    writeAuthProfiles(root, content);

    const result = await loadAuthProfiles(root);
    expect(Object.keys(result!.profiles)).toHaveLength(3);
    expect(result!.profiles['profile-with-dashes']).toBeDefined();
    expect(result!.profiles['profile.with.dots']).toBeDefined();
    expect(result!.profiles['profile_with_underscores']).toBeDefined();
  });

  it('saveAuthProfile preserves the entire file structure after add', async () => {
    const root = makeProjectRoot();
    // First create with 2 profiles
    const content = canonicalJson({
      'p1': makeValidProfile({ provider: 'first' }),
      'p2': makeValidProfile({ provider: 'second' }),
    });
    writeAuthProfiles(root, content);

    // Add a third
    await saveAuthProfile(root, 'p3', makeValidProfile({ provider: 'third' }));

    const result = await loadAuthProfiles(root);
    expect(Object.keys(result!.profiles)).toHaveLength(3);
    expect(result!.version).toBe(1);
  });

  it('saveAuthProfile overwrites an existing profile preserving others', async () => {
    const root = makeProjectRoot();
    const content = canonicalJson({
      'keep': makeValidProfile({ provider: 'keep' }),
      'update': makeValidProfile({ provider: 'old' }),
    });
    writeAuthProfiles(root, content);

    await saveAuthProfile(root, 'update', makeValidProfile({ provider: 'new', accessToken: 'new-at' }));

    const result = await loadAuthProfiles(root);
    expect(result!.profiles['keep'].provider).toBe('keep');
    expect(result!.profiles['update'].provider).toBe('new');
    expect(result!.profiles['update'].accessToken).toBe('new-at');
  });

  it('getAuthProfile returns normalized fields from shorthand', async () => {
    const root = makeProjectRoot();
    const content = shorthandJson({
      'sh': {
        type: 'oauth',
        provider: 'test',
        access: 'short-access',
        refresh: 'short-refresh',
        expires: 1234567890,
      },
    });
    writeAuthProfiles(root, content);

    const profile = await getAuthProfile(root, 'sh');
    expect(profile).not.toBeNull();
    expect(profile!.accessToken).toBe('short-access');
    expect(profile!.refreshToken).toBe('short-refresh');
    expect(profile!.expiresAt).toBe(1234567890);
  });
});
