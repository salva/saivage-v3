import { describe, expect, it } from 'vitest';
import { presentToolResult } from '../../utils/tool-presenters';
import { inlineText } from './_helpers';

function present(envelope: unknown) {
  return presentToolResult(JSON.stringify(envelope), { tool: 'mcp_tool_call' });
}

describe('MCP result presenter', () => {
  it.each([
    [{ private: 'structured-payload' }, true, 31, 'result complete · 31 B total JSON source'],
    [42, true, 2, 'result complete · 2 B total JSON source'],
    ['nonempty-prefix', false, 4096, 'result truncated · 4.0 kB total JSON source'],
    ['', false, 32768, 'result truncated · 32.0 kB total JSON source'],
  ])('projects supplied completeness and source bytes without projecting nested result content', (result, result_complete, result_utf8_bytes, detail) => {
    const body = { success: true, data: { result, result_complete, result_utf8_bytes } };
    const view = present(body);

    expect(view).toMatchObject({ name: 'mcp_tool_call', status: 'ok', body });
    expect(view.body).toEqual(body);
    expect(inlineText(view.headline)).toBe('MCP call completed');
    expect(inlineText(view.detail ?? [])).toBe(detail);
    const summary = inlineText([...view.headline, ...(view.detail ?? [])]);
    if (result !== '') expect(summary).not.toContain(typeof result === 'string' ? result : JSON.stringify(result));
  });

  it('keeps failed envelopes on the generic error path', () => {
    const body = { success: false, error: 'MCP invocation failed', data: { result_complete: false, result_utf8_bytes: 8192 } };
    const view = present(body);

    expect(view).toMatchObject({
      icon: '⚠',
      name: 'mcp_tool_call',
      status: 'error',
      headline: [{ kind: 'text', text: 'MCP invocation failed' }],
      body,
    });
    expect(view.body).toEqual(body);
    expect(view.detail).toBeUndefined();
  });

  it('keeps opaque success data raw without fabricating completeness or size', () => {
    const body = { success: true, data: 42 };
    const view = present(body);

    expect(view).toMatchObject({ name: 'mcp_tool_call', status: 'ok', body });
    expect(view.body).toEqual(body);
    expect(inlineText(view.headline)).toBe('MCP call completed');
    expect(view.detail).toBeUndefined();
    expect(inlineText(view.headline)).not.toContain('42');
  });
});
