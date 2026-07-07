import { describe, expect, it } from 'vitest';
import { presentToolResult } from '../../utils/tool-presenters';
import { inlineText } from './_helpers';

describe('webfetch presenter', () => {
  it('renders stash_url and ignores removed stash_path', () => {
    const view = presentToolResult(JSON.stringify({ stash_url: 'work:///tmp/stash/webfetch.txt', stash_path: '.saivage-work/tmp/stash/webfetch.txt' }), { tool: 'webfetch' });

    expect(inlineText(view.headline)).toContain('work:///tmp/stash/webfetch.txt');
    expect(inlineText(view.headline)).not.toContain('stash_path');
    expect(inlineText(view.headline)).not.toContain('.saivage-work');
  });
});
