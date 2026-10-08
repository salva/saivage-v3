import { describe, expect, it } from 'vitest';
import { presentToolResult } from '../../utils/tool-presenters';
describe('opaque MCP result', () => {
  it.each([[42, true, 2], ['prefix', false, 4096], [{ content: 'safe returned content' }, true, 35]])('exposes opaque body separately from reported completeness', (result, result_complete, result_utf8_bytes) => {
    const view = presentToolResult(JSON.stringify({ success: true, data: { result, result_complete, result_utf8_bytes } }), { tool: 'mcp_tool_call' });
    expect(view.status).toBe('neutral');
    expect(view.sections.find((s) => s.title === 'MCP result (effects opaque)')?.content).toBe(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
    expect(JSON.stringify(view.sections[0])).toContain(String(result_utf8_bytes));
    expect(JSON.stringify(view.sections[0])).toContain(String(result_complete));
  });
  it('preserves failed-envelope coverage without inventing effects', () => {
    const view = presentToolResult('{"success":false,"error":"MCP failed","data":{"result_complete":false,"result_utf8_bytes":8192}}', { tool: 'mcp_tool_call' });
    expect(view.outcome).toBe('Failed · Observation recorded · Returned body truncated');
    expect(JSON.stringify(view.sections)).toContain('8192');
    expect(JSON.stringify(view.sections)).not.toContain('applied');
  });
  it('keeps baseline MCP coverage/body distinct from ordered text in a synthetic content fixture', () => {
    // Generic ordered-content inspection, not evidence of a native MCP producer.
    const result = { count: 42 };
    const data = { result, result_complete: true, result_utf8_bytes: 12 };
    const view = presentToolResult(JSON.stringify({ success: true, data, content: [{ type: 'text', text: '{"plain":"native text"}' }] }), { tool: 'mcp_tool_call' });
    expect(view.status).toBe('neutral');
    expect(view.outcome).toBe('Observation recorded · Effects opaque');
    expect(view.sections[0].title).toBe('MCP returned coverage');
    expect(JSON.stringify(view.sections[0])).toContain('result complete');
    expect(JSON.stringify(view.sections[0])).toContain('Total JSON source bytes');
    expect(view.sections[1]).toMatchObject({ title: 'MCP result (effects opaque)', content: JSON.stringify(result, null, 2), language: 'json' });
    expect(view.sections[2]).toMatchObject({ title: 'Returned text · content 1', content: '{"plain":"native text"}', language: 'text' });
  });
});
