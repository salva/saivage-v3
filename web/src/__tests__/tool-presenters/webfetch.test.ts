import { describe, expect, it } from 'vitest';
import { presentToolResult } from '../../utils/tool-presenters';
import { inlineText } from './_helpers';

const canonical = 'work:///tmp/stash/webfetch-1-0123456789abcdef.txt';
const textData = {
  kind: 'text',
  redacted_url: 'https://example.test/path?[REDACTED]',
  status: 200,
  headers: {},
  head: 'first\nsecond',
  head_utf8_bytes: 12,
  redacted_text_utf8_bytes: 40,
  fetched_text_utf8_bytes: 55,
  head_complete: false,
  fetch_truncated: true,
  content_url: canonical,
};

describe('webfetch presenter', () => {
  it('renders the exact current incomplete content_url as a Files link with a one-line independent status summary', () => {
    const view = presentToolResult(JSON.stringify({ success: true, data: textData }), { tool: 'webfetch' });

    expect(view.headline).toEqual([{ kind: 'file', root: 'output', path: '.saivage/work/tmp/stash/webfetch-1-0123456789abcdef.txt', label: canonical }]);
    expect(inlineText(view.detail ?? [])).toBe('head: first second · 12 B of 40 B · head incomplete · fetch truncated');
  });

  it('uses redacted_url for complete text and reports an empty complete head', () => {
    const view = presentToolResult(JSON.stringify({ success: true, data: { ...textData, head: '', head_utf8_bytes: 0, redacted_text_utf8_bytes: 0, fetched_text_utf8_bytes: 0, head_complete: true, fetch_truncated: false, content_url: undefined } }), { tool: 'webfetch' });
    expect(inlineText(view.headline)).toBe('https://example.test/path?[REDACTED]');
    expect(inlineText(view.detail ?? [])).toBe('empty head · 0 B of 0 B · head complete · fetch complete');
  });

  it('preserves saved, metadata, and binary result headlines', () => {
    for (const saved_as of ['project:///saved.txt', 'record:///brief.md?card=project']) {
      expect(inlineText(presentToolResult(JSON.stringify({ success: true, data: { saved_as, redacted_url: 'https://example.test/' } }), { tool: 'webfetch' }).headline)).toBe(saved_as);
    }
    for (const data of [{ metadata_only: true }, { binary: true }]) {
      expect(inlineText(presentToolResult(JSON.stringify({ success: true, data: { ...data, redacted_url: 'https://example.test/' } }), { tool: 'webfetch' }).headline)).toBe('https://example.test/');
    }
  });

  it.each([
    'work:///tmp/stash/%77ebfetch-1-0123456789abcdef.txt',
    'work:///tmp/stash/webfetch-1-0123456789abcdef.txt?x=1',
    'work:///tmp/stash/webfetch-1-0123456789abcdef.txt#x',
    'work:///tmp/stash/./webfetch-1-0123456789abcdef.txt',
    'work:///tmp/stash/../webfetch-1-0123456789abcdef.txt',
    'work:///tmp/stash//webfetch-1-0123456789abcdef.txt',
    'work:///tmp/stash/webfetch-1-0123456789abcdef.txt/',
    'work:///tmp/stash/extra/webfetch-1-0123456789abcdef.txt',
    'project:///tmp/stash/webfetch-1-0123456789abcdef.txt',
    'work:///stash/webfetch-1-0123456789abcdef.txt',
    'work:///tmp/stash/webfetch-01-0123456789abcdef.txt',
    'work:///tmp/stash/webfetch-1-0123456789ABCDEF.txt',
    'work:///tmp/stash/webfetch-1-0123456789abcde.txt',
    'work:///tmp/stash/not-webfetch-1-0123456789abcdef.txt',
    'work:///tmp/stash/webfetch-1-0123456789abcdef.txt\n',
  ])('does not link a noncanonical opaque content URL: %s', (content_url) => {
    const body = { success: true, data: { ...textData, content_url } };
    const view = presentToolResult(JSON.stringify(body), { tool: 'webfetch' });
    expect(view.headline).toEqual([{ kind: 'text', text: 'https://example.test/path?[REDACTED]' }]);
    expect(view.headline).not.toContainEqual(expect.objectContaining({ kind: 'file' }));
    expect(view.body).toEqual(body);
  });
});
