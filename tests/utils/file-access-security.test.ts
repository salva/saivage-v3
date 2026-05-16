import { describe, expect, it } from '@jest/globals';
import { redactSecrets } from '../../src/utils/file-access-security.js';

describe('redactSecrets', () => {
  it('redacts token-shaped literals in arbitrary plain text', () => {
    const content = 'tokens: sk-live-secret tid=abc123 ghu_deadbeef rt_refresh tok_live_123456';
    const redacted = redactSecrets(content);
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
    const redacted = redactSecrets(content);
    expect(redacted).toContain('"apiKey":"[REDACTED]"');
    expect(redacted).toContain('"nestedToken":"[REDACTED]"');
    expect(redacted).toContain('"template":"${KEEP_ME}"');
  });
});
