import { describe, expect, it } from 'vitest';
import { presentToolResult } from '../../utils/tool-presenters';
describe('native MCP result metadata', () => {
  it('shows concise lifecycle known outcomes and complete discovery schemas as JSON', () => {
    const stopped = presentToolResult('{"success":true,"data":{"serverName":"browser","status":"stopped","toolCount":0}}', { tool: 'mcp_server_control' });
    expect(stopped.outcome).toBe('Server stopped · Context may be lost');
    const schema = { type: 'object', properties: { scale: { enum: ['css', 'device'] } }, required: ['scale'] };
    const discovered = presentToolResult(JSON.stringify({ success: true, data: { serverName: 'browser', tools: [{ name: 'screenshot', description: 'Native screenshot', inputSchema: schema }] } }), { tool: 'mcp_tools' });
    expect(discovered.outcome).toBe('1 tools recorded');
    expect(JSON.stringify(discovered.sections)).toContain('required');
    expect(discovered.sections[1].items![0].fields!.at(-1)!.parts[0]).toMatchObject({ language: 'json', text: JSON.stringify(schema, null, 2) });
  });
  it('shows envelope and capture metadata once, leaving ordered text/descriptors to the generic owner', () => {
    const raw = JSON.stringify({ success: true, data: { result: { structuredContent: { count: 42 } }, native_content: [{ content_index: 0, type: 'text' }], images: [{ content_index: 1, source_dimensions: { width: 10, height: 10 }, max_dimension: 1600 }] }, content: [{ type: 'text', text: '{"plain":"native text"}' }] });
    const view = presentToolResult(raw, { tool: 'mcp_tool_call' });
    expect(view.status).toBe('neutral');
    expect(view.outcome).toBe('Observation recorded · Effects opaque');
    expect(view.sections[0].title).toBe('MCP envelope metadata (effects opaque)');
    expect(JSON.stringify(view.sections)).toContain('count');
    expect(view.sections.filter((s) => s.content === '{"plain":"native text"}')).toEqual([expect.objectContaining({ language: 'text' })]);
    expect(JSON.stringify(view.sections)).toContain('source dimensions');
  });
  it('keeps retained ordinary JSON opaque without a legacy completeness interpretation', () => {
    const view = presentToolResult('{"success":true,"data":{"result":{"old":"prefix"},"result_complete":false}}', { tool: 'mcp_tool_call' });
    expect(view.outcome).toBe('Observation recorded · Effects opaque');
    expect(JSON.stringify(view.sections)).toContain('prefix');
    expect(JSON.stringify(view.sections)).not.toContain('Returned body truncated');
  });
});
