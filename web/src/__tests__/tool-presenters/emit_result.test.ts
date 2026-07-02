import { describe, expect, it } from 'vitest';
import { presentToolCall } from '../../utils/tool-presenters';
import { callEnvelope, inlineText } from './_helpers';

describe('emit_result presenter', () => {
  it('renders a structured call presentation for emit_result', () => {
    const view = presentToolCall(callEnvelope('emit_result', { status: 'done', summary: 'work complete' }));
    expect(view.name).toBe('emit_result');
    expect(inlineText(view.headline)).toContain('work complete');
  });
});
