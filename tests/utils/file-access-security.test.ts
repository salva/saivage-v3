import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redactTextForOutbound } from '../../src/redaction/index.js';
import {
  isWriteBlocked,
  redactOperatorErrorMessage,
  resolveContainedProjectPath,
} from '../../src/workspace/file-access-security.js';

describe('resolveContainedProjectPath', () => {
  it('admits adjacent dots while preserving traversal and containment boundaries', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-contained-path-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'saivage-contained-path-outside-'));
    try {
      const outsideFile = join(outside, 'outside.txt');
      writeFileSync(outsideFile, 'outside', 'utf8');
      symlinkSync(outsideFile, join(root, 'escaping-link'));

      expect(resolveContainedProjectPath(root, 'docs/v1..v2.md')).toMatchObject({
        safe: true,
        relativePath: 'docs/v1..v2.md',
      });
      for (const path of ['..', '../x', 'a/../b']) {
        expect(resolveContainedProjectPath(root, path)).toMatchObject({
          safe: false,
          reason: 'Path traversal detected. Use of ".." is not allowed.',
        });
      }
      expect(resolveContainedProjectPath(root, outsideFile)).toMatchObject({
        safe: false,
        reason: 'Path is outside the project root.',
      });
      expect(resolveContainedProjectPath(root, 'escaping-link')).toMatchObject({
        safe: false,
        reason: 'Symlink target is outside the project root.',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('isWriteBlocked', () => {
  it('preserves secret and lock descendant blocking boundaries', () => {
    expect(isWriteBlocked('.saivage/auth-profiles.json')).toBe(true);
    expect(isWriteBlocked('.saivage/locks/runtime.lock')).toBe(true);
    expect(isWriteBlocked('./.saivage/locks/runtime.lock')).toBe(true);
    expect(isWriteBlocked('.saivage/locks')).toBe(false);
    expect(isWriteBlocked('src/app.ts')).toBe(false);
  });
});

describe('redaction file-safety behavior', () => {
  it('redacts token-shaped literals in arbitrary plain text', () => {
    const content = 'tokens: sk-live-secret tid=abc123 ghu_deadbeef rt_refresh tok_live_123456';
    const redacted = redactTextForOutbound(content);
    expect(redacted).toContain('sk-[REDACTED]');
    expect(redacted).toContain('tid-[REDACTED]');
    expect(redacted).toContain('ghu-[REDACTED]');
    expect(redacted).toContain('rt-[REDACTED]');
    expect(redacted).toContain('tok-[REDACTED]');
    expect(redacted).not.toContain('sk-live-secret');
    expect(redacted).not.toContain('tid=abc123');
    expect(redacted).not.toContain('ghu_deadbeef');
    expect(redacted).not.toContain('rt_refresh');
    expect(redacted).not.toContain('tok_live_123456');
  });

  it('preserves existing json key redaction behavior', () => {
    const content = '{"apiKey":"secret","nestedToken":"another","template":"${KEEP_ME}"}';
    const redacted = redactTextForOutbound(content);
    expect(redacted).toContain('"apiKey":"[REDACTED]"');
    expect(redacted).toContain('"nestedToken":"[REDACTED]"');
    expect(redacted).toContain('"template":"${KEEP_ME}"');
  });
});

describe('redactOperatorErrorMessage strips projectRoot from error text', () => {
  it('replaces the resolved project root with [PROJECT_ROOT]', () => {
    const message = 'ENOENT: no such file or directory, open \'/work/saivage-v3/.saivage/state/runtime.json\'';
    const redacted = redactOperatorErrorMessage(message, '/work/saivage-v3');
    expect(redacted).toContain('[PROJECT_ROOT]');
    expect(redacted).not.toContain('/work/saivage-v3/');
  });

  it('redacts unrelated absolute paths to [PATH_REDACTED]', () => {
    const message = 'failed to read /etc/shadow while resolving config';
    const redacted = redactOperatorErrorMessage(message, '/work/saivage-v3');
    expect(redacted).toContain('[PATH_REDACTED]');
    expect(redacted).not.toContain('/etc/shadow');
  });

  it('keeps .saivage relative paths visible for operator diagnostics', () => {
    const message = 'Failed to read .saivage/state/runtime.json';
    const redacted = redactOperatorErrorMessage(message, '/work/saivage-v3');
    expect(redacted).toContain('.saivage/state/runtime.json');
  });
});
