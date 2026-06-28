import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestAnalystRuntime } from '../helpers/test-runtime-application.js';
import { assertToolBoundaryIntegrity, pruneToolBoundaryAfterTruncation } from '../../src/agents/context-compactor.js';
import { appendMessage } from '../../src/agents/session-persistence.js';
import { serializeToolCallMessage, PersistedRowCorruptError } from '../../src/contracts/persisted-tool-call.js';
import type { AgentMessage } from '../../src/schemas/index.js';
import { SessionInvariantError } from '../../src/agents/session-invariant-error.js';

const { AnalystHandler } = await import('../../src/agents/analyst-handler.js');

const TEST_MODEL = 'test-analyst-model';

function setupRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 's01-analyst-handler-'));
  const sd = join(root, '.saivage');
  for (const d of ['cards/by-id', 'cards/tree', 'cards/dependencies', 'notes/by-card', 'runtime', 'agents/sessions', 'agents/messages']) mkdirSync(join(sd, d), { recursive: true });
  writeFileSync(join(sd, 'saivage.json'), JSON.stringify({
    models: { analyst: [TEST_MODEL] },
    providers: { test: { models: [TEST_MODEL], apiKey: 'test-key', baseUrl: 'http://test-provider.invalid/v1' } },
  }, null, 2));
  const now = new Date().toISOString();
  writeFileSync(join(sd, 'cards', 'by-id', 'project.json'), JSON.stringify({ id: 'project', type: 'project', parent: null, depth: 0, title: 'project', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', created_at: now, updated_at: now, version_seq: 1, depends_on: [], related: [], acceptance: '', retries: 0 }));
  writeFileSync(join(sd, 'cards', 'index.json'), JSON.stringify({ cards: { project: { id: 'project', type: 'project', parent: null, status: 'backlog', title: 'project' } } }));
  writeFileSync(join(sd, 'cards', 'tree', 'project.children.json'), JSON.stringify([]));
  writeFileSync(join(sd, 'cards', 'dependencies', 'depends-on.json'), JSON.stringify({}));
  writeFileSync(join(sd, 'cards', 'dependencies', 'blocks.json'), JSON.stringify({}));
  writeFileSync(join(sd, 'notes', 'queue.json'), JSON.stringify({ next_note_sequence: 1, entries: [] }));
  return root;
}

function messageResponse(content: string): Response {
  return new Response(JSON.stringify({
    id: 'chatcmpl-test', object: 'chat.completion', created: 1, model: TEST_MODEL,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function toolCallsResponse(calls: Array<{ id: string; name: string; args: Record<string, unknown> }>): Response {
  return new Response(JSON.stringify({
    id: 'chatcmpl-test', object: 'chat.completion', created: 1, model: TEST_MODEL,
    choices: [{
      index: 0, finish_reason: 'tool_calls',
      message: {
        role: 'assistant', content: null,
        tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })),
      },
    }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function rawToolCallsResponse(calls: Array<{ id: string; name: string; rawArgs: string }>): Response {
  return new Response(JSON.stringify({
    id: 'chatcmpl-test', object: 'chat.completion', created: 1, model: TEST_MODEL,
    choices: [{
      index: 0, finish_reason: 'tool_calls',
      message: {
        role: 'assistant', content: null,
        tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.rawArgs } })),
      },
    }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function readPersistedRows(root: string, sessionId: string): Array<{ role: string; kind: string; content: string; tool?: string; tool_call_id?: string }> {
  const path = join(root, '.saivage', 'agents', 'messages', `${sessionId}.jsonl`);
  return readFileSync(path, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
}

function syntheticMessage(over: Partial<AgentMessage>): AgentMessage {
  return {
    id: 'm', session_id: 's', role: 'user', kind: 'text', content: '',
    round_id: 'r-pre-00000000000000000000000000000000',
    message_index: 0, block_index: 0,
    timestamp: new Date().toISOString(),
    ...over,
  } as AgentMessage;
}

describe('AnalystHandler F05 contract', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  it('result kind: message returns final text, persists no tool_call row', async () => {
    const root = setupRoot();
    try {
      jest.spyOn(globalThis, 'fetch').mockImplementation(async () => messageResponse('Hello user.'));
      const handler = new AnalystHandler(root, createTestAnalystRuntime());
      const response = await handler.handleMessage('s-msg', 'hi');
      expect(response.message.content).toBe('Hello user.');
      expect(response.toolInvocations ?? []).toHaveLength(0);
      const rows = readPersistedRows(root, 's-msg');
      expect(rows.filter((r) => r.kind === 'tool_call')).toHaveLength(0);
      expect(rows.filter((r) => r.role === 'assistant' && r.kind === 'text').map((r) => r.content)).toContain('Hello user.');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('result kind: tool_calls persists ONE assistant tool_call row PER call', async () => {
    const root = setupRoot();
    try {
      let call = 0;
      jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        call += 1;
        if (call === 1) return toolCallsResponse([
          { id: 'call-a', name: 'list_cards', args: { types: ['goal'] } },
          { id: 'call-b', name: 'list_cards', args: { types: ['code'] } },
        ]);
        return messageResponse('Done.');
      });
      const handler = new AnalystHandler(root, createTestAnalystRuntime());
      const response = await handler.handleMessage('s-multi', 'list everything');
      expect(response.message.content).toBe('Done.');
      const rows = readPersistedRows(root, 's-multi');
      const toolCallRows = rows.filter((r) => r.role === 'assistant' && r.kind === 'tool_call');
      expect(toolCallRows).toHaveLength(2);
      for (const tcr of toolCallRows) {
        const payload = JSON.parse(tcr.content) as { role: string; tool_calls: Array<{ id: string; type: string; function: { name: string; arguments: string } }> };
        expect(payload.role).toBe('assistant');
        expect(payload.tool_calls).toHaveLength(1);
        expect(payload.tool_calls[0].type).toBe('function');
      }
      const ids = toolCallRows.map((r) => (JSON.parse(r.content) as { tool_calls: Array<{ id: string }> }).tool_calls[0].id);
      expect(ids).toEqual(['call-a', 'call-b']);
      const resultRows = rows.filter((r) => r.role === 'tool' && r.kind === 'tool_result');
      expect(resultRows.map((r) => r.tool_call_id).sort()).toEqual(['call-a', 'call-b']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('pruneToolBoundaryAfterTruncation pairs each persisted single-call row with its tool_result', () => {
    const baseRound = 'r-assistant-00000000000000000000000000000001';
    const rowX = serializeToolCallMessage({ id: 'call-x', name: 'list_cards', args: { types: ['goal'] } });
    const rowY = serializeToolCallMessage({ id: 'call-y', name: 'list_cards', args: { types: ['code'] } });
    const messages: AgentMessage[] = [
      syntheticMessage({ id: 'u1', role: 'user', kind: 'text', content: 'list', round_id: 'r-user-00000000000000000000000000000000' }),
      syntheticMessage({ id: 'a1', role: 'assistant', kind: 'tool_call', content: JSON.stringify(rowX), tool: 'list_cards', round_id: baseRound, message_index: 1 }),
      syntheticMessage({ id: 'a2', role: 'assistant', kind: 'tool_call', content: JSON.stringify(rowY), tool: 'list_cards', round_id: baseRound, message_index: 2 }),
      syntheticMessage({ id: 't1', role: 'tool', kind: 'tool_result', content: '{}', tool: 'list_cards', tool_call_id: 'call-x', round_id: baseRound, message_index: 3 }),
      syntheticMessage({ id: 't2', role: 'tool', kind: 'tool_result', content: '{}', tool: 'list_cards', tool_call_id: 'call-y', round_id: baseRound, message_index: 4 }),
    ];
    const trimmed = pruneToolBoundaryAfterTruncation(messages);
    expect(trimmed).toHaveLength(5);
    const assistantIds = trimmed.filter((m) => m.role === 'assistant' && m.kind === 'tool_call').map((m) => (JSON.parse(m.content) as { tool_calls: Array<{ id: string }> }).tool_calls[0].id);
    expect(assistantIds.sort()).toEqual(['call-x', 'call-y']);
    const toolIds = trimmed.filter((m) => m.role === 'tool' && m.kind === 'tool_result').map((m) => m.tool_call_id);
    expect(toolIds.sort()).toEqual(['call-x', 'call-y']);

    // Orphan tool_result (no matching assistant tool_call) is dropped.
    const orphan: AgentMessage[] = [
      ...messages,
      syntheticMessage({ id: 't3', role: 'tool', kind: 'tool_result', content: '{}', tool: 'list_cards', tool_call_id: 'call-z', round_id: baseRound, message_index: 5 }),
    ];
    const trimmedOrphan = pruneToolBoundaryAfterTruncation(orphan);
    expect(trimmedOrphan.filter((m) => m.role === 'tool').map((m) => m.tool_call_id).sort()).toEqual(['call-x', 'call-y']);
  });

  it('assertToolBoundaryIntegrity throws on full-history orphan tool rows', () => {
    const orphan: AgentMessage[] = [
      syntheticMessage({ id: 't3', role: 'tool', kind: 'tool_result', content: '{}', tool: 'list_cards', tool_call_id: 'call-z' }),
    ];

    expect(() => assertToolBoundaryIntegrity(orphan)).toThrow(SessionInvariantError);
    expect(() => assertToolBoundaryIntegrity(orphan)).toThrow(/orphan_tool_result/);
  });

  it('legacy {toolCalls:[...]} persisted row makes pruneToolBoundaryAfterTruncation throw PersistedRowCorruptError(legacy_tool_calls_wrapper)', () => {
    const baseRound = 'r-assistant-00000000000000000000000000000002';
    const legacyContent = JSON.stringify({ toolCalls: [{ id: 'old-1', name: 'list_cards', args: {} }] });
    const messages: AgentMessage[] = [
      syntheticMessage({ id: 'u1', role: 'user', kind: 'text', content: 'hi', round_id: 'r-user-00000000000000000000000000000000' }),
      syntheticMessage({ id: 'a1', role: 'assistant', kind: 'tool_call', content: legacyContent, tool: 'list_cards', round_id: baseRound, message_index: 1 }),
    ];
    let caught: unknown;
    try { pruneToolBoundaryAfterTruncation(messages); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(PersistedRowCorruptError);
    expect((caught as PersistedRowCorruptError).code).toBe('legacy_tool_calls_wrapper');
  });

  it('turns malformed tool argument JSON into protocol tool errors without executing tools', async () => {
    const root = setupRoot();
    try {
      const diagnostics: Array<Record<string, unknown>> = [];
      const runtimeDeps = createTestAnalystRuntime();
      runtimeDeps.eventLogger = { appendEvent: (event: unknown) => { diagnostics.push(event as Record<string, unknown>); return event as never; } } as never;
      let call = 0;
      jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        call += 1;
        if (call === 1) return rawToolCallsResponse([{ id: 'bad-args', name: 'list_cards', rawArgs: '{not-json' }]);
        return messageResponse('Done.');
      });

      const handler = new AnalystHandler(root, runtimeDeps);
      const response = await handler.handleMessage('s-bad-json', 'list cards');

      expect(response.message.content).toBe('Done.');
      expect(diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'runtime_diagnostic', phase: 'analyst_tool_arguments_protocol_violation' }),
      ]));
      const rows = readPersistedRows(root, 's-bad-json');
      expect(rows.some((row) => row.role === 'tool' && row.kind === 'tool_error' && row.content.includes('agent_protocol_violation'))).toBe(true);
      expect(rows.some((row) => row.role === 'tool' && row.kind === 'tool_result')).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('records diagnostics when activity callbacks throw', async () => {
    const root = setupRoot();
    try {
      const diagnostics: Array<Record<string, unknown>> = [];
      const runtimeDeps = createTestAnalystRuntime();
      runtimeDeps.eventLogger = { appendEvent: (event: unknown) => { diagnostics.push(event as Record<string, unknown>); return event as never; } } as never;
      let call = 0;
      jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        call += 1;
        if (call === 1) return toolCallsResponse([{ id: 'call-a', name: 'list_cards', args: {} }]);
        return messageResponse('Done.');
      });

      const handler = new AnalystHandler(root, runtimeDeps, () => { throw new Error('activity boom'); });
      const response = await handler.handleMessage('s-activity', 'list cards');

      expect(response.message.content).toBe('Done.');
      expect(diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'runtime_diagnostic', phase: 'analyst_activity_callback_failed', error_message: 'activity boom' }),
      ]));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('excludes persisted model_issue diagnostics from analyst model input', async () => {
    const root = setupRoot();
    try {
      appendMessage(join(root, '.saivage'), 's-filter', {
        role: 'system',
        kind: 'model_issue',
        content: 'provider debug diagnostic must not be resent',
      }, {
        round_id: 'r-diagnostic-00000000000000000000000000000000',
        message_index: 0,
        block_index: 0,
      });
      let modelInputContents: string[] = [];
      jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ content?: string }> };
        modelInputContents = (body.messages ?? []).map((message) => String(message.content ?? ''));
        return messageResponse('Done.');
      });

      const handler = new AnalystHandler(root, createTestAnalystRuntime());
      await handler.handleMessage('s-filter', 'hi');

      expect(modelInputContents.some((content) => content.includes('provider debug diagnostic'))).toBe(false);
      expect(readPersistedRows(root, 's-filter').some((row) => row.kind === 'model_issue')).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
