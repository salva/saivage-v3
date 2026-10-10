import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import {
  appendConversationBatch,
  readConversation,
  readCurrentConversationSegment,
  readConversationCatalog,
} from '../../src/persistence/conversation-file.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { ACTIVITY_ROW_POLICY, toolRowPolicies } from '../helpers/row-policy-fixtures.js';
import { providerConversationProjection } from '../../src/runtime/actors/conversation-session.js';
import { projectToolInvocation } from '../../src/tools/tool-invocation-outbound.js';
import type { AgentMessage, ConversationSessionId } from '../../src/schemas/index.js';

describe('durable-preserving MCP topology history', () => {
  it('strict current readers/materialization and outbound projection retain old name-only and new bound/registration facts without execution', () => {
    const root = mkdtempSync('/home/salva/g/ml/tmp/mcp-historical-');
    const session = 'agent:planner:project' as ConversationSessionId;
    const input = '11111111-1111-4111-8111-111111111111';
    const timestamp = '2026-10-10T00:00:00.000Z';
    const facts = [
      {
        tool: 'mcp_tool_call',
        args: { serverName: 'one', toolName: 'ping', args: {} },
        data: { prior: true },
      },
      {
        tool: 'mcp_tool_call',
        args: {
          serverName: 'one',
          bindingId: '22222222-2222-4222-8222-222222222222',
          toolName: 'ping',
          args: {},
        },
        data: { bound: true },
      },
      {
        tool: 'mcp_server_register',
        args: {
          serverName: 'two',
          connection: { transport: 'stdio', command: 'node', env: { CUSTOM: 'private-env-value' } },
        },
        data: { serverName: 'two', registered: true },
      },
    ];
    const rows: AgentMessage[] = [
      {
        id: 'activation',
        session_id: session,
        role: 'system',
        kind: 'activity',
        context_policy: ACTIVITY_ROW_POLICY,
        content: JSON.stringify({
          event: 'activation_open',
          agent_name: 'planner',
          card_id: 'project',
          input_id: input,
          timestamp,
        }),
        round_id: `r-pre-${'0'.repeat(32)}`,
        message_index: 0,
        block_index: 0,
        timestamp,
      },
    ];
    facts.forEach(({ tool, args, data }, index) => {
      const id = `call-${index}`;
      const content = JSON.stringify({ success: true, data });
      const policies = toolRowPolicies({ content });
      const round = `r-assistant-${String(index).padStart(32, '0')}`;
      rows.push({
        id: `${input}:tool-call:${id}`,
        session_id: session,
        role: 'assistant',
        kind: 'tool_call',
        tool,
        tool_call_id: id,
        context_policy: policies.call,
        content: JSON.stringify({
          role: 'assistant',
          tool_calls: [
            { id, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } },
          ],
        }),
        round_id: round,
        message_index: index * 2 + 1,
        block_index: 0,
        timestamp,
      });
      rows.push({
        id: `${input}:tool-result:${id}`,
        session_id: session,
        role: 'tool',
        kind: 'tool_result',
        tool,
        tool_call_id: id,
        context_policy: policies.result,
        content,
        round_id: round,
        message_index: index * 2 + 2,
        block_index: 0,
        timestamp,
      });
    });
    try {
      initProjectTree(root);
      appendConversationBatch({ projectRoot: root }, rows);
      expect(readConversationCatalog(root, session).versions).toHaveLength(1);
      expect(readCurrentConversationSegment(root, session)!.rows).toEqual(rows);
      const materialized = readConversation(root, session);
      expect(materialized.physicalRows).toEqual(rows);
      const projected = providerConversationProjection(materialized, []).messages;
      expect(JSON.stringify(projected)).toContain('prior');
      expect(JSON.stringify(projected)).toContain('bound');
      facts.forEach(({ tool, args, data }, index) => {
        const result = projectToolInvocation({
          shape: 'complete',
          identity: {
            sessionId: session,
            sourceInputId: input,
            toolCallId: `call-${index}`,
            toolName: tool,
          },
          arguments: args,
          result: { success: true, data },
        });
        expect(result).toMatchObject({ result: { success: true, data } });
        if (index === 0) {
          expect(result).toMatchObject({ arguments: args });
          expect(JSON.stringify(result)).not.toContain('bindingId');
        }
        if (index === 1) expect(result).toMatchObject({ arguments: args });
        if (index === 2) expect(JSON.stringify(result)).not.toContain('private-env-value');
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
