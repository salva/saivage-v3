import { describe, expect, it } from '@jest/globals';

import { filterAgentMessagesForModel, isAgentMessageVisibleToModel } from '../../src/agents/agent-message-visibility.js';
import type { AgentMessage, MessageKind } from '../../src/schemas/index.js';

function message(kind: MessageKind): AgentMessage {
  return {
    id: `m-${kind}`,
    session_id: 's',
    role: kind === 'tool_result' || kind === 'tool_error' ? 'tool' : 'system',
    kind,
    content: kind,
    round_id: 'r-pre-00000000000000000000000000000000',
    message_index: 0,
    block_index: 0,
    timestamp: new Date(0).toISOString(),
  } as AgentMessage;
}

describe('agent message model visibility', () => {
  it('keeps recovery, repair, compaction, and tool messages model-visible while excluding model_issue', () => {
    const messages = [
      message('model_issue'),
      message('model_recovered'),
      message('model_repair'),
      message('context_compaction'),
      message('tool_result'),
      message('tool_error'),
      message('text'),
    ];

    expect(isAgentMessageVisibleToModel(messages[0])).toBe(false);
    expect(filterAgentMessagesForModel(messages).map((item) => item.kind)).toEqual([
      'model_recovered',
      'model_repair',
      'context_compaction',
      'tool_result',
      'tool_error',
      'text',
    ]);
  });
});
