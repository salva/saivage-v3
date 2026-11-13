import { describe, expect, it } from 'vitest';
import { presentToolCall, presentToolResult } from '../../utils/tool-presenters';
describe.each([
  { tool: 'mcp_server_register', flag: 'registered', effect: 'Definition recorded', complete: 'Definition recorded · not launched', extra: {} },
  { tool: 'mcp_server_unregister', flag: 'unregistered', effect: 'Removal recorded', complete: 'Removal recorded', extra: { status: 'stopped' } },
])('$tool definition evidence', ({ tool, flag, effect, complete, extra }) => {
  const facts = { serverName: 'returned-server', [flag]: true, ...extra };
  it('retains the complete owner success outcome and exact returned fields', () => {
    const view = presentToolResult(JSON.stringify({ success: true, data: facts }), { tool });
    expect(view.outcome).toBe(complete);
    const fields = view.sections.flatMap(section => section.fields ?? []);
    for (const [label, value] of Object.entries(facts)) {
      expect(fields).toContainEqual(expect.objectContaining({ label, parts: expect.arrayContaining([expect.objectContaining({ text: String(value) })]) }));
    }
  });
  it.each([
    "MCP operation is not granted.",
    'Invalid MCP policy.',
    "MCP server 'returned-server' already has a definition.",
    "MCP server 'returned-server' is not an exclusively agent-owned definition.",
    // An error-only result after potential partial work carries no effect facts either.
    'MCP containment failed after definition publication.',
  ])('does not infer effects from error-only results: %s', error => {
    const view = presentToolResult(JSON.stringify({ success: false, error }), { tool });
    expect(view.outcome).toBe('Failed');
    expect(view.status).toBe('error');
    expect(view.sections).toContainEqual({ title: 'Error', content: error });
  });
  it.each([
    { [flag]: true }, { serverName: '', [flag]: true }, { serverName: 42, [flag]: true },
    { serverName: null, [flag]: true }, { serverName: ['returned-server'], [flag]: true },
    { serverName: 'returned-server' }, { serverName: 'returned-server', [flag]: false },
    { serverName: 'returned-server', [flag]: 'true' }, { serverName: 'returned-server', [flag]: 1 },
  ])('keeps incomplete/inconsistent fields without promoting them: %j', data => {
    for (const success of [true, false]) {
      const view = presentToolResult(JSON.stringify({ success, data, ...(!success ? { error: 'Refused' } : {}) }), { tool });
      expect(view.outcome).toBe(success ? 'Tool returned success' : 'Failed');
      const fields = view.sections.flatMap(section => section.fields ?? []);
      for (const label of Object.keys(data)) expect(fields.some(field => field.label === label)).toBe(true);
    }
  });
  it.each([undefined, null, 'opaque', [], 42])('keeps missing/non-object data handling: %j', data => {
    expect(presentToolResult(JSON.stringify({ success: true, data }), { tool }).outcome).toBe('Presentation unavailable');
    expect(presentToolResult(JSON.stringify({ success: false, error: 'Refused', data }), { tool }).outcome).toBe('Failed');
  });
  it.each([
    {}, { success: 'true', data: facts }, { success: false, data: facts },
    { success: false, error: '', data: facts }, { success: true, data: facts, unexpected: true },
  ])('rejects malformed outer envelopes without normalization: %j', envelope => {
    expect(presentToolResult(JSON.stringify(envelope), { tool })).toMatchObject({ status: 'error', outcome: 'Presentation unavailable', sections: [] });
  });
  // Synthetic public-boundary fixtures, not responses emitted by current MCP binders.
  it.each([
    { success: false, uncertain: false }, { success: false, uncertain: true }, { success: true, uncertain: true },
  ])('retains explicitly reported synthetic partial facts with settlement: %j', ({ success, uncertain }) => {
    const error = `Containment or later work not established. ${'detail '.repeat(100)}FINAL-ERROR`;
    const data = { ...facts, ...(uncertain ? { outcome_unknown: true } : {}), code: 'synthetic_partial', reason: 'Reported facts only' };
    const view = presentToolResult(JSON.stringify({ success, data, ...(!success ? { error } : {}) }), { tool });
    expect(view.outcome).toBe(`${uncertain ? 'Effects uncertain' : 'Failed'} · ${effect}`);
    expect(view.status).toBe('error');
    expect(view.outcome).not.toMatch(/not launched|Server stopped|contained/);
    expect(JSON.stringify(view.sections)).toContain('returned-server');
    if (!success) {
      expect(view.sections).toContainEqual({ title: uncertain ? 'Uncertainty' : 'Error', content: error });
      expect(view.sections.some(section => section.title === 'Recorded refusal / error context')).toBe(true);
    }
  });
  it('keeps uncertainty without affirmative facts as uncertainty alone', () => {
    expect(presentToolResult(JSON.stringify({ success: false, error: 'Unknown effects', data: { outcome_unknown: true } }), { tool }).outcome).toBe('Effects uncertain');
  });
});
describe('native MCP result metadata', () => {
  it('reports scope publication only with complete successful facts; historical missing policy remains absent', () => {
    const policy = { controllerCardId: 'project', exposure: 'subtree' };
    const facts = { serverName: 'one', policy, updated: true };
    expect(presentToolResult(JSON.stringify({ success: true, data: facts }), { tool: 'mcp_server_set_scope' }).outcome).toBe('Scope updated · connection preserved');
    for (const envelope of [
      { success: false, error: 'Refused', data: facts },
      { success: true, data: { serverName: 'one', updated: true } },
      { success: true, data: { ...facts, outcome_unknown: true } },
    ]) expect(presentToolResult(JSON.stringify(envelope), { tool: 'mcp_server_set_scope' }).outcome).not.toContain('Scope updated');
    const absent = presentToolResult(JSON.stringify({ success: true, data: { serverName: 'one', updated: true } }), { tool: 'mcp_server_set_scope' });
    expect(JSON.stringify(absent.sections)).not.toContain('controllerCardId');
  });
  it.each([
    [{ success: true, data: { serverName: 'browser', status: 'running', toolCount: 1 } }, 'Server ready'],
    [{ success: false, error: 'MCP discovery failed after containment.' }, 'Failed · Outcome not reported'],
    [{ success: true, data: { serverName: 'browser' } }, 'Outcome not reported'],
  ])('presents recorded restart outcome without inventing continuity: %j', (result, outcome) => {
    const view = presentToolResult(JSON.stringify(result), { tool: 'mcp_server_control' });
    expect(view.outcome).toBe(outcome);
    const call = presentToolCall(JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'restart', type: 'function', function: { name: 'mcp_server_control', arguments: JSON.stringify({ serverName: 'browser', action: 'restart' }) } }] }));
    expect(JSON.stringify(call.sections)).toContain('restart');
  });
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
