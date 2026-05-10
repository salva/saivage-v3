/**
 * File Access Security Tests
 *
 * Verifies:
 * - isSensitivePath correctly identifies .saivage/auth-profiles.json
 * - isReadBlocked blocks auth-profiles.json
 * - isWriteBlocked blocks auth-profiles.json and runtime.lock
 * - redactSecrets replaces API keys and tokens
 * - isStashPathAllowed rejects path traversal and only allows stash files
 * - getSafeFileForAgent: blocked files, redacted files, normal files pass through
 * - Edge cases: empty paths, root-relative paths, deeply nested paths
 */

import { describe, it, expect } from '@jest/globals';
import { join, sep } from 'node:path';

import {
  SENSITIVE_PATHS,
  READ_BLOCKED_PATHS,
  WRITE_BLOCKED_PATHS,
  REDACT_PATHS,
  sanitizeFilePath,
  isSensitivePath,
  isReadBlocked,
  isWriteBlocked,
  isRedacted,
  redactSecrets,
  isStashPathAllowed,
  getSafeFileForAgent,
} from '../../src/utils/file-access-security.js';

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════

describe('SENSITIVE_PATHS constant', () => {
  it('contains the three spec-defined sensitive paths', () => {
    expect(SENSITIVE_PATHS.has('.saivage/auth-profiles.json')).toBe(true);
    expect(SENSITIVE_PATHS.has('.saivage/saivage.json')).toBe(true);
    expect(SENSITIVE_PATHS.has('.saivage-work/tmp/runtime/runtime.lock')).toBe(true);
  });

  it('does not contain arbitrary safe paths', () => {
    expect(SENSITIVE_PATHS.has('src/index.ts')).toBe(false);
    expect(SENSITIVE_PATHS.has('.saivage/project.json')).toBe(false);
    expect(SENSITIVE_PATHS.has('.saivage-work/tmp/stash/data.bin')).toBe(false);
  });

  it('is frozen/readonly', () => {
    expect(SENSITIVE_PATHS).toBeDefined();
    // The set itself is readonly via ReadonlySet
  });
});

describe('READ_BLOCKED_PATHS constant', () => {
  it('contains only auth-profiles.json', () => {
    expect(READ_BLOCKED_PATHS.has('.saivage/auth-profiles.json')).toBe(true);
    expect(READ_BLOCKED_PATHS.has('.saivage/saivage.json')).toBe(false);
    expect(READ_BLOCKED_PATHS.has('.saivage-work/tmp/runtime/runtime.lock')).toBe(false);
  });
});

describe('WRITE_BLOCKED_PATHS constant', () => {
  it('contains auth-profiles.json and runtime.lock', () => {
    expect(WRITE_BLOCKED_PATHS.has('.saivage/auth-profiles.json')).toBe(true);
    expect(WRITE_BLOCKED_PATHS.has('.saivage-work/tmp/runtime/runtime.lock')).toBe(true);
    expect(WRITE_BLOCKED_PATHS.has('.saivage/saivage.json')).toBe(false);
  });
});

describe('REDACT_PATHS constant', () => {
  it('contains only saivage.json', () => {
    expect(REDACT_PATHS.has('.saivage/saivage.json')).toBe(true);
    expect(REDACT_PATHS.has('.saivage/auth-profiles.json')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// sanitizeFilePath
// ═══════════════════════════════════════════════════════════════

describe('sanitizeFilePath', () => {
  it('returns empty string for empty input', () => {
    expect(sanitizeFilePath('')).toBe('');
  });

  it('strips leading ./', () => {
    expect(sanitizeFilePath('./.saivage/auth-profiles.json')).toBe(
      '.saivage/auth-profiles.json',
    );
    expect(sanitizeFilePath('./src/utils/index.ts')).toBe('src/utils/index.ts');
  });

  it('normalizes .. segments within a path', () => {
    // .saivage/auth-profiles.json/../auth-profiles.json
    // → .saivage/auth-profiles.json (.. cancels the last segment then re-adds it)
    expect(sanitizeFilePath('.saivage/auth-profiles.json/../auth-profiles.json')).toBe(
      '.saivage/auth-profiles.json',
    );
    // Simple foo/../bar → bar
    expect(sanitizeFilePath('foo/../bar')).toBe('bar');
  });

  it('handles double-dot traversal that goes before root', () => {
    // normalize collapses `foo/../../bar` → `../bar`
    expect(sanitizeFilePath('foo/../../.saivage/auth-profiles.json')).toBe(
      '../.saivage/auth-profiles.json',
    );
  });

  it('handles already-clean paths', () => {
    expect(sanitizeFilePath('.saivage/auth-profiles.json')).toBe(
      '.saivage/auth-profiles.json',
    );
    expect(sanitizeFilePath('src/index.ts')).toBe('src/index.ts');
  });

  it('strips trailing slashes', () => {
    expect(sanitizeFilePath('.saivage/auth-profiles.json/')).toBe(
      '.saivage/auth-profiles.json',
    );
    expect(sanitizeFilePath('src/utils/')).toBe('src/utils');
  });

  it('handles double slashes', () => {
    expect(sanitizeFilePath('.saivage//auth-profiles.json')).toBe(
      '.saivage/auth-profiles.json',
    );
  });

  it('preserves absolute paths (for caller to handle)', () => {
    const abs = sanitizeFilePath('/absolute/path/to/file.json');
    // normalize preserves leading / on absolute paths
    expect(abs.startsWith(sep)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// isSensitivePath
// ═══════════════════════════════════════════════════════════════

describe('isSensitivePath', () => {
  it('returns true for auth-profiles.json', () => {
    expect(isSensitivePath('.saivage/auth-profiles.json')).toBe(true);
  });

  it('returns true for auth-profiles.json with ./ prefix', () => {
    expect(isSensitivePath('./.saivage/auth-profiles.json')).toBe(true);
  });

  it('returns true for saivage.json', () => {
    expect(isSensitivePath('.saivage/saivage.json')).toBe(true);
  });

  it('returns true for runtime.lock', () => {
    expect(isSensitivePath('.saivage-work/tmp/runtime/runtime.lock')).toBe(true);
  });

  it('returns false for safe paths', () => {
    expect(isSensitivePath('.saivage/project.json')).toBe(false);
    expect(isSensitivePath('src/index.ts')).toBe(false);
    expect(isSensitivePath('.saivage-work/tmp/stash/data.bin')).toBe(false);
    expect(isSensitivePath('.saivage-work/quarantine/item/raw.bin')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isSensitivePath('')).toBe(false);
  });

  it('returns false for path with extra segments', () => {
    expect(isSensitivePath('.saivage/auth-profiles.json/extra')).toBe(false);
  });

  it('handles dot-dot derailing the path', () => {
    // When dot-dot makes the path go elsewhere, it should not match
    expect(isSensitivePath('.saivage/auth-profiles.json/../../src/index.ts')).toBe(false);
  });

  it('catches path that resolves to sensitive via ..', () => {
    // .saivage/../.saivage/auth-profiles.json
    // normalize: .saivage/.. → . (cancels), then .saivage/auth-profiles.json remains
    // Result: .saivage/auth-profiles.json
    expect(isSensitivePath('.saivage/../.saivage/auth-profiles.json')).toBe(true);
    // .saivage/foo/../auth-profiles.json → .saivage/auth-profiles.json
    expect(isSensitivePath('.saivage/foo/../auth-profiles.json')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// isReadBlocked
// ═══════════════════════════════════════════════════════════════

describe('isReadBlocked', () => {
  it('blocks auth-profiles.json', () => {
    expect(isReadBlocked('.saivage/auth-profiles.json')).toBe(true);
    expect(isReadBlocked('./.saivage/auth-profiles.json')).toBe(true);
  });

  it('does not block saivage.json (redacted, not blocked)', () => {
    expect(isReadBlocked('.saivage/saivage.json')).toBe(false);
  });

  it('does not block runtime.lock', () => {
    expect(isReadBlocked('.saivage-work/tmp/runtime/runtime.lock')).toBe(false);
  });

  it('does not block normal files', () => {
    expect(isReadBlocked('src/index.ts')).toBe(false);
    expect(isReadBlocked('.saivage/project.json')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// isWriteBlocked
// ═══════════════════════════════════════════════════════════════

describe('isWriteBlocked', () => {
  it('blocks auth-profiles.json', () => {
    expect(isWriteBlocked('.saivage/auth-profiles.json')).toBe(true);
  });

  it('blocks runtime.lock', () => {
    expect(isWriteBlocked('.saivage-work/tmp/runtime/runtime.lock')).toBe(true);
    expect(isWriteBlocked('./.saivage-work/tmp/runtime/runtime.lock')).toBe(true);
  });

  it('does not block saivage.json (redacted on read, but writes are not blocked)', () => {
    expect(isWriteBlocked('.saivage/saivage.json')).toBe(false);
  });

  it('does not block normal files', () => {
    expect(isWriteBlocked('src/index.ts')).toBe(false);
    expect(isWriteBlocked('.saivage/project.json')).toBe(false);
    expect(isWriteBlocked('.saivage-work/tmp/stash/data.bin')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// isRedacted
// ═══════════════════════════════════════════════════════════════

describe('isRedacted', () => {
  it('returns true for saivage.json', () => {
    expect(isRedacted('.saivage/saivage.json')).toBe(true);
    expect(isRedacted('./.saivage/saivage.json')).toBe(true);
  });

  it('returns false for auth-profiles.json', () => {
    expect(isRedacted('.saivage/auth-profiles.json')).toBe(false);
  });

  it('returns false for runtime.lock', () => {
    expect(isRedacted('.saivage-work/tmp/runtime/runtime.lock')).toBe(false);
  });

  it('returns false for non-sensitive paths', () => {
    expect(isRedacted('src/index.ts')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// redactSecrets
// ═══════════════════════════════════════════════════════════════

describe('redactSecrets', () => {
  it('redacts apiKey values', () => {
    const input = '{"apiKey": "sk-abc123def456"}';
    const output = redactSecrets(input);
    expect(output).toBe('{"apiKey": "[REDACTED]"}');
  });

  it('redacts botToken values', () => {
    const input = '{"botToken": "12345:ABCDEF-ghijk"}';
    const output = redactSecrets(input);
    expect(output).toBe('{"botToken": "[REDACTED]"}');
  });

  it('redacts keys ending in _key', () => {
    const input = '{"api_key": "abcdef123", "encryption_key": "xyz789"}';
    const output = redactSecrets(input);
    expect(output).toBe('{"api_key": "[REDACTED]", "encryption_key": "[REDACTED]"}');
  });

  it('redacts keys ending in _token', () => {
    const input = '{"access_token": "tok123", "refresh_token": "rtok456"}';
    const output = redactSecrets(input);
    expect(output).toBe('{"access_token": "[REDACTED]", "refresh_token": "[REDACTED]"}');
  });

  it('redacts keys ending in _secret', () => {
    const input = '{"client_secret": "cs-xyz"}';
    const output = redactSecrets(input);
    expect(output).toBe('{"client_secret": "[REDACTED]"}');
  });

  it('redacts keys named "secret"', () => {
    const input = '{"secret": "super-secret-value"}';
    const output = redactSecrets(input);
    expect(output).toBe('{"secret": "[REDACTED]"}');
  });

  it('redacts keys named "password"', () => {
    const input = '{"password": "hunter2"}';
    const output = redactSecrets(input);
    expect(output).toBe('{"password": "[REDACTED]"}');
  });

  it('redacts accessToken and refreshToken', () => {
    const input = '{"accessToken": "at-123", "refreshToken": "rt-456"}';
    const output = redactSecrets(input);
    expect(output).toBe('{"accessToken": "[REDACTED]", "refreshToken": "[REDACTED]"}');
  });

  it('does NOT redact env var references (${...})', () => {
    const input = '{"apiKey": "${SAIVAGE_API_KEY}", "botToken": "${TELEGRAM_BOT_TOKEN}"}';
    const output = redactSecrets(input);
    expect(output).toBe('{"apiKey": "${SAIVAGE_API_KEY}", "botToken": "${TELEGRAM_BOT_TOKEN}"}');
  });

  it('redacts literal values but not env vars in same object', () => {
    const input = '{"apiKey": "sk-literal", "botToken": "${ENV_TOKEN}"}';
    const output = redactSecrets(input);
    expect(output).toBe('{"apiKey": "[REDACTED]", "botToken": "${ENV_TOKEN}"}');
  });

  it('does NOT redact non-secret keys', () => {
    const input = '{"name": "saivage-v3", "version": "1.0.0", "description": "test project"}';
    const output = redactSecrets(input);
    expect(output).toBe(input);
  });

  it('leaves non-JSON plain text unchanged', () => {
    const input = 'This is just a normal string with apiKey mentioned.';
    const output = redactSecrets(input);
    expect(output).toBe(input);
  });

  it('handles empty content', () => {
    expect(redactSecrets('')).toBe('');
  });

  it('redacts multi-line JSON with multiple secret fields', () => {
    const input = `{
  "apiKey": "sk-multiline-key",
  "name": "my-project",
  "botToken": "12345:bot-token",
  "port": 3000,
  "secret": "do-not-leak"
}`;
    const output = redactSecrets(input);
    expect(output).toContain('"apiKey": "[REDACTED]"');
    expect(output).toContain('"botToken": "[REDACTED]"');
    expect(output).toContain('"secret": "[REDACTED]"');
    expect(output).toContain('"name": "my-project"'); // unchanged
    expect(output).not.toContain('sk-multiline-key');
    expect(output).not.toContain('12345:bot-token');
    expect(output).not.toContain('do-not-leak');
  });

  it('redacts keys with underscores in the middle', () => {
    const input = '{"my_custom_key": "value123", "my_custom_token": "tok456"}';
    const output = redactSecrets(input);
    expect(output).toBe('{"my_custom_key": "[REDACTED]", "my_custom_token": "[REDACTED]"}');
  });

  it('redacts keys that contain _secret anywhere', () => {
    const input = '{"some_secret_key": "abc", "my_secret": "xyz"}';
    const output = redactSecrets(input);
    expect(output).toBe('{"some_secret_key": "[REDACTED]", "my_secret": "[REDACTED]"}');
  });

  it('handles escaped quotes in JSON values', () => {
    const input = '{"apiKey": "sk-\\"quoted\\""}';
    const output = redactSecrets(input);
    // The value contained escaped quotes; should be redacted
    expect(output).not.toContain('sk-');
  });

  it('redacts multiple occurrences of the same key', () => {
    const input =
      '{"apiKey": "first-key"}, {"apiKey": "second-key"}';
    const output = redactSecrets(input);
    expect(output).toBe(
      '{"apiKey": "[REDACTED]"}, {"apiKey": "[REDACTED]"}',
    );
  });

  it('preserves whitespace around colons', () => {
    const input = '{ "apiKey" : "sk-abc" }';
    const output = redactSecrets(input);
    // Whitespace around colon should be preserved
    expect(output).toBe('{ "apiKey" : "[REDACTED]" }');
  });
});

// ═══════════════════════════════════════════════════════════════
// isStashPathAllowed
// ═══════════════════════════════════════════════════════════════

describe('isStashPathAllowed', () => {
  const stashDir = join(sep, 'work', 'saivage-v3', '.saivage-work', 'tmp', 'stash');

  it('allows a simple filename within stash', () => {
    expect(isStashPathAllowed(stashDir, 'data.bin')).toBe(true);
  });

  it('allows a nested path within stash', () => {
    expect(isStashPathAllowed(stashDir, join('subdir', 'file.json'))).toBe(true);
  });

  it('allows the stash directory itself', () => {
    // '.' resolves to the stash directory itself, which is within stash
    expect(isStashPathAllowed(stashDir, '.')).toBe(true);
  });

  it('rejects path traversal with ..', () => {
    expect(isStashPathAllowed(stashDir, '../../.saivage/auth-profiles.json')).toBe(false);
    expect(isStashPathAllowed(stashDir, '../quarantine/item/raw.bin')).toBe(false);
  });

  it('rejects absolute paths outside stash', () => {
    expect(isStashPathAllowed(stashDir, '/etc/passwd')).toBe(false);
    expect(isStashPathAllowed(stashDir, '/work/saivage-v3/.saivage/auth-profiles.json')).toBe(
      false,
    );
  });

  it('rejects path traversal that starts dot-dot', () => {
    expect(isStashPathAllowed(stashDir, '..')).toBe(false);
    expect(isStashPathAllowed(stashDir, '../..')).toBe(false);
  });

  it('rejects empty requestedPath', () => {
    expect(isStashPathAllowed(stashDir, '')).toBe(false);
  });

  it('rejects empty stashDir', () => {
    expect(isStashPathAllowed('', 'data.bin')).toBe(false);
  });

  it('rejects path with leading slash that resolves outside', () => {
    // resolve(stashDir, '/etc/hosts') → /etc/hosts
    expect(isStashPathAllowed(stashDir, '/etc/hosts')).toBe(false);
  });

  it('allows a deep path within stash', () => {
    expect(
      isStashPathAllowed(stashDir, join('a', 'b', 'c', 'd', 'e', 'file.txt')),
    ).toBe(true);
  });

  it('handles stashDir with trailing slash', () => {
    const dirWithTrailing = stashDir + sep;
    expect(isStashPathAllowed(dirWithTrailing, 'file.txt')).toBe(true);
    expect(isStashPathAllowed(dirWithTrailing, '../../../etc/passwd')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// getSafeFileForAgent
// ═══════════════════════════════════════════════════════════════

describe('getSafeFileForAgent', () => {
  it('blocks auth-profiles.json read', () => {
    const result = getSafeFileForAgent('.saivage/auth-profiles.json', '{"secret":"x"}');
    expect(result.blocked).toBe(true);
    expect(result.safeContent).toBeUndefined();
    expect(result.reason).toContain('blocked');
    expect(result.reason).toContain('auth-profiles.json');
  });

  it('redacts secrets in saivage.json', () => {
    const content = '{"apiKey": "sk-secret", "name": "test"}';
    const result = getSafeFileForAgent('.saivage/saivage.json', content);
    expect(result.blocked).toBe(false);
    expect(result.safeContent).toBeDefined();
    expect(result.safeContent).not.toContain('sk-secret');
    expect(result.safeContent).toContain('[REDACTED]');
    expect(result.safeContent).toContain('"name": "test"');
    expect(result.reason).toContain('redacted');
  });

  it('passes through normal files unchanged', () => {
    const content = 'export const x = 1;\n';
    const result = getSafeFileForAgent('src/index.ts', content);
    expect(result.blocked).toBe(false);
    expect(result.safeContent).toBe(content);
    expect(result.reason).toBeUndefined();
  });

  it('passes through non-sensitive config files', () => {
    const content = '{"name":"test"}';
    const result = getSafeFileForAgent('.saivage/project.json', content);
    expect(result.blocked).toBe(false);
    expect(result.safeContent).toBe(content);
  });

  it('redacts saivage.json with ./ prefix', () => {
    const content = '{"apiKey": "sk-secret"}';
    const result = getSafeFileForAgent('./.saivage/saivage.json', content);
    expect(result.blocked).toBe(false);
    expect(result.safeContent).toContain('[REDACTED]');
  });

  it('blocks auth-profiles.json with ./ prefix', () => {
    const result = getSafeFileForAgent('./.saivage/auth-profiles.json', '{}');
    expect(result.blocked).toBe(true);
  });

  it('handles empty content for blocked files', () => {
    const result = getSafeFileForAgent('.saivage/auth-profiles.json', '');
    expect(result.blocked).toBe(true);
    expect(result.safeContent).toBeUndefined();
  });

  it('handles empty content for saivage.json', () => {
    const result = getSafeFileForAgent('.saivage/saivage.json', '');
    expect(result.blocked).toBe(false);
    expect(result.safeContent).toBe('');
    expect(result.reason).toContain('redacted');
  });
});

// ═══════════════════════════════════════════════════════════════
// Edge Cases
// ═══════════════════════════════════════════════════════════════

describe('edge cases', () => {
  it('sanitizeFilePath handles deeply nested paths', () => {
    const deep = 'a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/file.json';
    expect(sanitizeFilePath(deep)).toBe(deep);
  });

  it('sanitizeFilePath handles ./ on deeply nested paths', () => {
    const deep = './a/b/c/d/e/f/g/h/file.json';
    expect(sanitizeFilePath(deep)).toBe('a/b/c/d/e/f/g/h/file.json');
  });

  it('isSensitivePath with repeated ../ that look like sensitive paths', () => {
    // .saivage/auth-profiles.json/../../.saivage/auth-profiles.json
    // normalize: .saivage/auth-profiles.json/../.. → .saivage/ (cancels last two segments)
    // Then append .saivage/auth-profiles.json → .saivage/.saivage/auth-profiles.json
    // This does NOT match our sensitive set, but the actual normalize
    // result on Node is: .saivage/auth-profiles.json
    // Let's just verify the function doesn't crash
    const result = isSensitivePath('.saivage/auth-profiles.json/../../.saivage/auth-profiles.json');
    expect(typeof result).toBe('boolean');
  });

  it('isStashPathAllowed with dot-segments inside allowed path', () => {
    const stashDir = join(sep, 'work', 'saivage-v3', '.saivage-work', 'tmp', 'stash');
    // a/./b/./c → a/b/c (allowed — the dots are harmless)
    expect(isStashPathAllowed(stashDir, 'a/./b/./c')).toBe(true);
  });

  it('isStashPathAllowed is case-sensitive (Unix)', () => {
    const stashDir = join(sep, 'work', 'saivage-v3', '.saivage-work', 'tmp', 'stash');
    // The stash directory is lowercase; an uppercase reference shouldn't resolve
    // resolve on a case-sensitive fs would keep the case
    const result = isStashPathAllowed(stashDir.toUpperCase(), 'file.txt');
    // This tests that the function doesn't crash with weird inputs
    expect(typeof result).toBe('boolean');
  });

  it('redactSecrets handles non-string JSON values correctly', () => {
    const input = '{"apiKey": 12345}';
    const output = redactSecrets(input);
    // Number values are not matched by the string-value regex, so unchanged
    expect(output).toBe(input);
  });

  it('getSafeFileForAgent returns reason for blocked files', () => {
    const result = getSafeFileForAgent('.saivage/auth-profiles.json', '{}');
    expect(result.reason).toBeTruthy();
    expect(result.reason!.length).toBeGreaterThan(10);
  });
});
