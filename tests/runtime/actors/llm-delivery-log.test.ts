import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readConversation } from '../../../src/persistence/conversation-file.js';
import { appendToolResult } from '../../../src/runtime/actors/llm-delivery-log.js';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('LLM delivery log', () => {
  it('persists a failed tool result under the original identity with unchanged content', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-delivery-log-'));
    roots.push(projectRoot);
    const sessionId = 'planner:project';
    const sourceInputId = '11111111-1111-4111-8111-111111111111';
    const result = { success: false, error: 'tool execution failed', data: { exit_code: 2 } };

    const appended = appendToolResult({ projectRoot }, {
      session_id: sessionId,
      source_input_id: sourceInputId,
      tool_call_id: 'call-1',
      tool_name: 'run_command',
      result,
    });

    const messages = readConversation(projectRoot, sessionId);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(appended.message);
    expect(messages[0]).toMatchObject({
      id: `${sourceInputId}:tool-result:call-1`,
      session_id: sessionId,
      role: 'tool',
      kind: 'tool_result',
      tool: 'run_command',
      tool_call_id: 'call-1',
      content: JSON.stringify(result),
    });
  });
});
