import { describe, expect, it } from 'vitest';
import { presentToolCall } from '../../utils/tool-presenters';
import { callEnvelope, inlineText } from './_helpers';

describe('read_control_actions presenter', () => {
  it('renders a structured call presentation for read_control_actions', () => {
    const view = presentToolCall(callEnvelope('read_control_actions', { path: '.saivage/plan.json', command: 'npm test', cardId: '11111111-1111-4111-8111-111111111111', id: '11111111-1111-4111-8111-111111111111', goalId: '11111111-1111-4111-8111-111111111111', sessionId: 'session-1', content: 'hello' }));
    expect(view.name).toBe('read_control_actions');
    expect(view.icon.length).toBeGreaterThan(0);
    expect(Array.isArray(view.headline)).toBe(true);
    expect(inlineText(view.headline)).toBeTypeOf('string');
    expect(view.bodyKind).toBe('json');
  });
});
