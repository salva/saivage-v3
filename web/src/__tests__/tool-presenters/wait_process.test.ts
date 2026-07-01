import { describe, expect, it } from 'vitest';
import { presentToolCall } from '../../utils/tool-presenters';
import { callEnvelope } from './_helpers';

describe('wait_process presenter', () => {
  it('renders a structured call presentation for wait_process', () => {
    const view = presentToolCall(callEnvelope('wait_process', { process_id: 'proc-1' }));
    expect(view.name).toBe('wait_process');
  });
});
