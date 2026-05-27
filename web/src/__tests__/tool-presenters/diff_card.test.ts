import { describe, expect, it } from 'vitest';
import { presentToolCall } from '../../utils/tool-presenters';
import { callEnvelope, inlineText } from './_helpers';

describe('diff_card presenter', () => {
  it('renders a structured call presentation for diff_card', () => {
    const view = presentToolCall(callEnvelope('diff_card', { path: '.saivage/plan.json', command: 'npm test', cardId: 'card-1', id: 'card-1', goalId: 'goal-1', sessionId: 'session-1', content: 'hello' }));
    expect(view.name).toBe('diff_card');
    expect(view.icon.length).toBeGreaterThan(0);
    expect(Array.isArray(view.headline)).toBe(true);
    expect(inlineText(view.headline)).toBeTypeOf('string');
    expect(view.bodyKind).toBe('json');
  });
});
