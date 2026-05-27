import { describe, expect, it } from 'vitest';
import { presentToolCall } from '../../utils/tool-presenters';
import { callEnvelope, inlineText } from './_helpers';

describe('list_project_files presenter', () => {
  it('renders a structured call presentation for list_project_files', () => {
    const view = presentToolCall(callEnvelope('list_project_files', { path: '.saivage/plan.json', command: 'npm test', cardId: 'card-1', id: 'card-1', goalId: 'goal-1', sessionId: 'session-1', content: 'hello' }));
    expect(view.name).toBe('list_project_files');
    expect(view.icon.length).toBeGreaterThan(0);
    expect(Array.isArray(view.headline)).toBe(true);
    expect(inlineText(view.headline)).toBeTypeOf('string');
    expect(view.bodyKind).toBe('json');
  });
});
