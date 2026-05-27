import { describe, expect, it } from 'vitest';
import { presentToolCall } from '../../utils/tool-presenters';
import { callEnvelope, inlineText } from './_helpers';

describe('start_and_wait presenter', () => {
  it('renders a structured call presentation for start_and_wait', () => {
    const view = presentToolCall(callEnvelope('start_and_wait', { path: '.saivage/plan.json', command: 'npm test', cardId: 'card-1', id: 'card-1', goalId: 'goal-1', sessionId: 'session-1', content: 'hello' }));
    expect(view.name).toBe('start_and_wait');
    expect(view.icon.length).toBeGreaterThan(0);
    expect(Array.isArray(view.headline)).toBe(true);
    expect(inlineText(view.headline)).toBeTypeOf('string');
    expect(view.bodyKind).toBe('json');
  });
});
