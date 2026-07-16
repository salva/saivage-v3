import { describe, expect, it } from 'vitest';
import { presentToolCall, presentToolResult } from '../../utils/tool-presenters';
import { callEnvelope, inlineText } from './_helpers';

describe('kill_process presenter', () => {
  it('renders a structured call presentation for kill_process', () => {
    const view = presentToolCall(callEnvelope('kill_process', { path: '.saivage/plan.json', command: 'npm test', cardId: '11111111-1111-4111-8111-111111111111', id: '11111111-1111-4111-8111-111111111111', goalId: '11111111-1111-4111-8111-111111111111', sessionId: 'session-1', content: 'hello' }));
    expect(view.name).toBe('kill_process');
    expect(view.icon.length).toBeGreaterThan(0);
    expect(Array.isArray(view.headline)).toBe(true);
    expect(inlineText(view.headline)).toBeTypeOf('string');
    expect(view.bodyKind).toBe('json');
  });

  it('renders unified killed process results', () => {
    const view = presentToolResult(JSON.stringify({ process_id: 'proc-1', status: 'killed', exit_code: null }), { tool: 'kill_process' });

    expect(inlineText(view.headline)).toContain('killed');
    expect(inlineText(view.detail)).toContain('proc-1');
  });
});
