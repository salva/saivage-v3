/**
 * Security Integration Tests
 *
 * Verifies:
 * - Path-policy behavior
 * - All modules work together without errors
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  writeFileSync,
  rmSync,
  mkdtempSync,
  mkdirSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  isReadBlocked,
  isRedacted,
  resolveContainedProjectPath,
} from '../../src/workspace/file-access-security.js';
import { redactTextForOutbound } from '../../src/redaction/index.js';

// ── Helpers ───────────────────────────────────────────────────

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'saivage-security-integration-'));
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('workspace path policy primitives', () => {
  it('keeps blocked, redacted, and ordinary decisions distinct', () => {
    expect(isReadBlocked('.saivage/auth-profiles.json')).toBe(true);
    expect(isReadBlocked('.saivage/locks')).toBe(true);
    expect(isReadBlocked('.saivage/locks/not-created.lock')).toBe(true);
    expect(isRedacted('.saivage/saivage.yaml')).toBe(true);
    expect(isReadBlocked('.saivage/saivage.yaml')).toBe(false);
    expect(isReadBlocked('src/app.ts')).toBe(false);
    expect(isRedacted('src/app.ts')).toBe(false);
  });

  it('keeps lexical and existing real-target project identities separate', () => {
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'target.txt'), 'ordinary', 'utf8');
    symlinkSync('docs/target.txt', join(root, 'alias.txt'));

    expect(resolveContainedProjectPath(root, 'alias.txt')).toEqual(expect.objectContaining({
      safe: true,
      relativePath: 'alias.txt',
      realTargetProjectRelativePath: 'docs/target.txt',
    }));
    expect(resolveContainedProjectPath(root, 'missing.txt')).toEqual(expect.not.objectContaining({
      realTargetProjectRelativePath: expect.anything(),
    }));
  });
});

// ═══════════════════════════════════════════════════════════════
// Edge cases
// ═══════════════════════════════════════════════════════════════

describe('integration edge cases', () => {
  it('blocks current lock namespace paths from reads and writes', async () => {
    const mod = await import('../../src/workspace/index.js');
    expect(mod.isReadBlocked('.saivage/locks/runtime.lock')).toBe(true);
    expect(mod.isWriteBlocked('.saivage/locks/runtime.lock')).toBe(true);
  });

  it('redaction does not modify non-secret keys', () => {
    const json = JSON.stringify({
      name: 'my-project',
      description: 'a test project',
      card_count: 5,
    });

    const result = redactTextForOutbound(json);
    expect(result).toContain('my-project');
    expect(result).toContain('a test project');
    expect(result).not.toContain('[REDACTED]');
  });

  it('redaction preserves env var references', () => {
    const json = JSON.stringify({
      apiKey: '${GITHUB_TOKEN}',
      name: 'test',
    });

    const result = redactTextForOutbound(json);
    // Env var references should NOT be redacted
    expect(result).toContain('${GITHUB_TOKEN}');
    expect(result).not.toContain('[REDACTED]');
  });
});
