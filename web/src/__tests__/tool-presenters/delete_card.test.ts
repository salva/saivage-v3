import { describe, expect, it } from 'vitest';
import { presentToolCall } from '../../utils/tool-presenters';
import { callEnvelope, inlineText } from './_helpers';

describe('delete_card presenter', () => {
  it('renders a structured call presentation for delete_card', () => {
    const view = presentToolCall(callEnvelope('delete_card', { path: '.saivage/plan.json', command: 'npm test', cardId: '11111111-1111-4111-8111-111111111111', id: '11111111-1111-4111-8111-111111111111', goalId: '11111111-1111-4111-8111-111111111111', sessionId: 'session-1', content: 'hello' }));
    expect(view.name).toBe('delete_card');
    expect(view.icon.length).toBeGreaterThan(0);
    expect(Array.isArray(view.headline)).toBe(true);
    expect(inlineText(view.headline)).toBeTypeOf('string');
    expect(view.bodyKind).toBe('json');
  });
});
