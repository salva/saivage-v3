import { describe, expect, it } from '@jest/globals';

import { redactForOutbound } from '../../src/redaction/index.js';
import type { WebfetchResult } from '../../src/contracts/webfetch.js';

type WebfetchSuccessData = Extract<WebfetchResult, { success: true }>['data'];

const RESULT_CASES: Array<[string, WebfetchSuccessData]> = [
  ['metadata', { redacted_url: 'https://example.test/path?[REDACTED]', status: 204, headers: { etag: 'tok_primary' }, metadata_only: true }],
  ['binary', { redacted_url: 'https://example.test/path?[REDACTED]', status: 200, headers: { 'content-type': 'application/octet-stream' }, bytes: 12, content: null, binary: true }],
  ['inline', { redacted_url: 'https://example.test/path?[REDACTED]', status: 200, headers: {}, text: 'token=raw-body-marker', bytes: 21, truncated: false }],
  ['stash', { redacted_url: 'https://example.test/path?[REDACTED]', status: 200, headers: {}, stash_url: 'work:///tmp/stash/webfetch-tok_primary.txt', bytes: 500, truncated: true }],
  ['save', { redacted_url: 'https://example.test/path?[REDACTED]', status: 200, headers: {}, saved_as: 'record:///brief.md?card=tok_primary&v=2', write: { card_id: 'tok_primary', path: 'record:///brief.md?card=tok_primary&v=2', record_url: 'record:///brief.md?card=tok_primary&v=2', bytes: 9, written: true, propagation: { ok: false, partial: true, error: 'token=raw-write-marker' } }, bytes: 9 }],
];

describe('webfetch outbound owners', () => {
  it('redacts only the invocation URL while preserving every option and save identity', () => {
    expect(redactForOutbound({
      source: 'webfetch-invocation',
      value: {
        url: 'https://tok_primary.example/path?raw-query-marker=yes#fragment',
        read_mode: 'text',
        metadata_only: false,
        max_bytes: 123,
        max_inline_bytes: 45,
        save_as: 'record:///brief.md?card=tok_primary&v=next',
      },
    })).toEqual({
      url: 'https://tok_primary.example/path?[REDACTED]',
      read_mode: 'text',
      metadata_only: false,
      max_bytes: 123,
      max_inline_bytes: 45,
      save_as: 'record:///brief.md?card=tok_primary&v=next',
    });
  });

  it.each(RESULT_CASES)('projects the %s result contract without changing structural metadata', (_name, data) => {
    const projected = redactForOutbound({ source: 'webfetch-result', value: { success: true, data } });
    expect(JSON.stringify(projected)).not.toContain('raw-body-marker');
    expect(JSON.stringify(projected)).not.toContain('raw-write-marker');
    expect(projected).toMatchObject({ success: true, data: { redacted_url: 'https://example.test/path?[REDACTED]', status: expect.any(Number), headers: data.headers } });
    if ('stash_url' in data) expect(projected).toMatchObject({ success: true, data: { stash_url: data.stash_url } });
    if ('saved_as' in data) expect(projected).toMatchObject({ success: true, data: { saved_as: data.saved_as, write: { card_id: 'tok_primary' } } });
  });

  it('redacts result error prose and rejects the removed raw URL contract', () => {
    expect(redactForOutbound({ source: 'webfetch-result', value: { success: false, error: 'token=raw-error-marker' } }))
      .toEqual({ success: false, error: 'token=[REDACTED]' });

    expect(() => redactForOutbound({ source: 'webfetch-result', value: {
      success: true,
      data: { url: 'https://example.test/?raw-query-marker=yes', redacted_url: 'https://example.test/?[REDACTED]', status: 200, headers: {}, metadata_only: true },
    } as never })).toThrow();
  });
});
