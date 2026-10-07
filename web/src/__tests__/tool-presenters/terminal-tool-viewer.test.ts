import { describe, expect, it } from 'vitest';
import { presentToolCall, presentToolResult } from '../../utils/tool-presenters';
import { callEnvelope } from './_helpers';
describe('terminal tool node admission', () => {
  it('presents proposed completion as submission rather than completed work', () => {
    expect(presentToolCall(callEnvelope('emit_result', { outcome: 'done', summary: 'Proposed completion' })).sections[0].title).toBe('Requested node result');
    expect(presentToolResult('{"success":true}', { tool: 'emit_result' }).outcome).toBe('Node result accepted');
    const rejected = presentToolResult('{"success":false,"error":"stale review completion gate"}', { tool: 'emit_result' });
    expect(rejected.outcome).toBe('Failed');
    expect(JSON.stringify(rejected.headline)).toContain('stale review');
  });
});
