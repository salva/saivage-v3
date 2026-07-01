import { describe, expect, it } from 'vitest';
import { presentToolCall } from '../../utils/tool-presenters';
import { callEnvelope } from './_helpers';

describe('run_command presenter', () => {
  it('renders a structured call presentation for run_command', () => {
    const view = presentToolCall(callEnvelope('run_command', { command: 'npm test' }));
    expect(view.name).toBe('run_command');
  });
});
