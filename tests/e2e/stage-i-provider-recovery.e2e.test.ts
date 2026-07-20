import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { appendConversationBatch, readConversation } from '../../src/persistence/conversation-file.js';
import { stabilizeRoleSession } from '../../src/runtime/actors/conversation-recovery.js';
import type { AgentMessage, ConversationSessionId } from '../../src/schemas/index.js';
import { providerConversationProjection } from '../../src/runtime/actors/conversation-session.js';
import { responsesInputFromProviderConversation } from '../../src/agents/llm-openai-responses-mapper.js';
import { codexMessages } from '../../src/agents/llm-openai-codex-adapter.js';
import { buildOpenAIChatRequest } from '../../src/agents/llm-openai-chat-adapter.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { conversationFile } from '../../src/runtime/actors/conversation-inventory.js';

const roots: string[] = [];
const source = '11111111-1111-4111-8111-111111111111';

afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('stable same-session recovery', () => {
  it('settles an ordinary unmatched activate_card call without a reconstructed child candidate as outcome unknown', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-recovery-'));
    initProjectTree(projectRoot);
    roots.push(projectRoot);
    const sessionId: ConversationSessionId = 'planner:project';
    mkdirSync(dirname(conversationFile(projectRoot, sessionId)), { recursive: true });
    const base = { session_id: sessionId, round_id: 'r-pre-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', message_index: 0, block_index: 0, timestamp: '2026-07-15T00:00:00.000Z' };
    const rows: AgentMessage[] = [
      { ...base, id: `${sessionId}:activation:one`, role: 'system', kind: 'activity', content: JSON.stringify({ event: 'activation_open', role: 'planner', card_id: 'project', input_id: source, timestamp: base.timestamp }) },
      { ...base, id: `${source}:tool-call:call-1`, role: 'assistant', kind: 'tool_call', content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'activate_card', arguments: JSON.stringify({ card_id: 'card-bbbbbbbbbbbbbbbbbbbbbbbbbbbb' }) } }] }), tool: 'activate_card', tool_call_id: 'call-1', message_index: 1 },
    ];
    appendConversationBatch({ projectRoot }, rows);
    const result = stabilizeRoleSession({ projectRoot, sessionId, conversations: { projectRoot }, terminalToolNames: new Set(['emit_result']) });
    expect(result.disposition).toBe('ordinary_interruption');
    const recovered = readConversation(projectRoot, sessionId).physicalRows;
    expect(recovered).toHaveLength(rows.length + 2);
    const settlement = recovered.at(-2)!;
    expect(settlement.id).toBe(`${source}:tool-result:call-1`);
    expect(settlement).toMatchObject({ role: 'tool', kind: 'tool_result', tool: 'activate_card', tool_call_id: 'call-1' });
    expect(JSON.parse(settlement.content)).toEqual({ success: false, error: 'Runtime activation was interrupted before completion. External or domain effects may or may not have happened.', data: { outcome_unknown: true } });
  });

  it.each<ConversationSessionId>([
    'planner:project',
    'executor:card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'reviewer:project',
  ])('treats pending-notification settlement as an interrupted continuation for %s', (sessionId) => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-recovery-prefix-'));
    initProjectTree(projectRoot);
    mkdirSync(dirname(conversationFile(projectRoot, sessionId)), { recursive: true });
    roots.push(projectRoot);
    const base = { session_id: sessionId, round_id: 'r-pre-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', message_index: 0, block_index: 0, timestamp: '2026-07-15T00:00:00.000Z' };
    appendConversationBatch({ projectRoot }, [
      { ...base, id: `${sessionId}:activation:one`, role: 'system', kind: 'activity', content: JSON.stringify({ event: 'activation_open', role: sessionId.split(':')[0], card_id: sessionId.slice(sessionId.indexOf(':') + 1), input_id: source, timestamp: base.timestamp }) },
      { ...base, id: `${source}:tool-call:emit-1`, role: 'assistant', kind: 'tool_call', content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'emit-1', type: 'function', function: { name: 'emit_result', arguments: '{}' } }] }), tool: 'emit_result', tool_call_id: 'emit-1', message_index: 1 },
      { ...base, id: `${source}:tool-result:emit-1`, role: 'tool', kind: 'tool_result', content: JSON.stringify({ success: false, error: 'deferred', data: { reason: 'pending_notifications' } }), tool: 'emit_result', tool_call_id: 'emit-1', message_index: 2 },
    ] satisfies AgentMessage[]);

    expect(stabilizeRoleSession({ projectRoot, sessionId, conversations: { projectRoot }, terminalToolNames: new Set(['emit_result']) }).disposition).toBe('ordinary_interruption');
  });

  it('projects the synthetic failed settlement and recovery notice through Generic, Chat, Codex, and Responses', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-recovery-transports-'));
    initProjectTree(projectRoot);
    roots.push(projectRoot);
    const sessionId: ConversationSessionId = 'planner:project';
    const base = { session_id: sessionId, round_id: 'r-pre-cccccccccccccccccccccccccccccccc', message_index: 0, block_index: 0, timestamp: '2026-07-15T00:00:00.000Z' };
    appendConversationBatch({ projectRoot }, [
      { ...base, id: `${sessionId}:activation:one`, role: 'system', kind: 'activity', content: JSON.stringify({ event: 'activation_open', role: 'planner', card_id: 'project', input_id: source, timestamp: base.timestamp }) },
      { ...base, id: `${source}:tool-call:call-1`, role: 'assistant', kind: 'tool_call', content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read', arguments: '{}' } }] }), tool: 'read', tool_call_id: 'call-1', message_index: 1 },
    ] satisfies AgentMessage[]);
    stabilizeRoleSession({ projectRoot, sessionId, conversations: { projectRoot }, terminalToolNames: new Set(['emit_result']) });
    const providerConversation = providerConversationProjection(readConversation(projectRoot, sessionId));
    const generic = providerConversation.messages;
    const notice = generic.find((row) => row.kind === 'model_recovered')!;
    const failed = generic.find((row) => row.kind === 'tool_result')!;
    expect(failed.id).toBe(`${source}:tool-result:call-1`);
    expect(JSON.parse(failed.content)).toMatchObject({ success: false, data: { outcome_unknown: true } });
    expect(generic).toContainEqual(expect.objectContaining({ kind: 'model_recovered', role: 'system' }));

    expect(codexMessages(generic)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'function_call', call_id: 'call-1' }),
      expect.objectContaining({ type: 'function_call_output', call_id: 'call-1', output: failed.content }),
    ]));
    expect(responsesInputFromProviderConversation(providerConversation)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'function_call', call_id: 'call-1' }),
      expect.objectContaining({ type: 'function_call_output', call_id: 'call-1', output: failed.content }),
    ]));
    const chat = buildOpenAIChatRequest(
      { provider: 'openai', model: 'gpt-test', account: 'default' },
      'system', providerConversation,
      { inputId: 'wire-check', contract_id: 'test.v1', contractName: 'test', tools: [], tool_choice: 'auto', terminalToolOffered: [], temperature: 0, max_tokens: 10, stream: false },
    );
    expect(chat.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', tool_calls: [expect.objectContaining({ id: 'call-1' })] }),
      { role: 'tool', content: failed.content, tool_call_id: 'call-1' },
      { role: 'system', content: notice.content },
    ]));
  });

});
