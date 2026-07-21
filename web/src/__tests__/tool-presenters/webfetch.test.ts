import { describe, expect, it } from 'vitest';
import { presentToolResult } from '../../utils/tool-presenters';
import { inlineText } from './_helpers';

describe('webfetch presenter', () => {
  it('renders wrapped stash_url as a Files link without stash_path', () => {
    const view = presentToolResult(JSON.stringify({ success: true, data: { stash_url: 'work:///tmp/stash/webfetch.txt' } }), { tool: 'webfetch' });

    expect(inlineText(view.headline)).toContain('work:///tmp/stash/webfetch.txt');
    expect(view.headline).toEqual([{ kind: 'file', root: 'output', path: '.saivage/work/tmp/stash/webfetch.txt', label: 'work:///tmp/stash/webfetch.txt' }]);
  });
});
