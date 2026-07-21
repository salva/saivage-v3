import { describe, expect, it } from '@jest/globals';
import { redactTextForOutbound } from '../../src/redaction/index.js';
import { redactOperatorErrorMessage } from '../../src/workspace/file-access-security.js';

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
