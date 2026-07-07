import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestAnalystRuntime, loadTestConfig } from '../helpers/test-runtime-application.js';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { materializeProjectCard } from '../helpers/materialize-project-card.js';
import { appendConversationMessage, readConversationMessages } from '../../src/runtime/actors/conversation-store.js';
import { activeVersionPath, conversationDir, writeConversationIndex } from '../../src/runtime/actors/conversation-index.js';
import { resolveAnalystSessionId } from '../../src/agents/session-ids.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { actorSnapshotPath } from '../../src/runtime/actors/snapshots.js';

const { AnalystRuntime } = await import('../../src/agents/analyst-handler.js');

const TEST_MODEL = 'test-analyst-model';

function setupRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 's01-analyst-handler-'));
  const sd = join(root, '.saivage');
  initProjectTree(root);
  writeFileSync(join(sd, 'saivage.json'), JSON.stringify({
    models: { default: [TEST_MODEL], analyst: [TEST_MODEL] },
    providers: { test: { models: [TEST_MODEL], apiKey: 'test-key', baseUrl: 'http://test-provider.invalid/v1' } },
  }, null, 2));
  materializeProjectCard(root);
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
  return readConversationMessages(root, resolveAnalystSessionId(sessionId)).map((message) => ({ role: message.role, kind: message.kind, content: message.content, tool: message.tool, tool_call_id: message.tool_call_id }));
}

describe('AnalystHandler F05 contract', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  it('result kind: message returns final text, persists no tool_call row', async () => {
    const root = setupRoot();
    try {
      jest.spyOn(globalThis, 'fetch').mockImplementation(async () => messageResponse('Hello user.'));
      const runtime = new AnalystRuntime({ projectRoot: root, config: loadTestConfig(root), runtimeDeps: createTestAnalystRuntime({ projectRoot: root }) });
      const response = await runtime.submit('s-msg', { userContent: 'hi' });
      expect(response.message.content).toBe('Hello user.');
      expect(response.toolInvocations ?? []).toHaveLength(0);
      const rows = readPersistedRows(root, 's-msg');
      expect(rows.filter((r) => r.kind === 'tool_call')).toHaveLength(0);
      expect(rows.filter((r) => r.role === 'assistant' && r.kind === 'text').map((r) => r.content)).toContain('Hello user.');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('terminates running processes owned by an Analyst session', async () => {
    const root = setupRoot();
    try {
      const sessionId = resolveAnalystSessionId('s-cleanup');
      const processRunner = new ProcessRunner(root);
      const process = processRunner.spawn({
        command: 'sleep 5',
        cardId: sessionId,
        ownerId: sessionId,
        agentSessionId: sessionId,
        ownerKind: 'operator',
        launchReason: 'analyst workspace run_command',
      });
      const runtime = new AnalystRuntime({ projectRoot: root, config: loadTestConfig(root), runtimeDeps: createTestAnalystRuntime({ projectRoot: root, processRunner }) });

      await runtime.shutdownSessionProcesses(sessionId);

      expect(processRunner.get(process.id)).toEqual(expect.objectContaining({ status: 'killed' }));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('result kind: tool_call persists assistant tool_call and tool_result rows', async () => {
    const root = setupRoot();
    try {
      let call = 0;
      jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        call += 1;
        if (call === 1) return toolCallsResponse([
          { id: 'call-a', name: 'list_cards', args: { types: ['goal'] } },
        ]);
        return messageResponse('Done.');
      });
      const runtime = new AnalystRuntime({ projectRoot: root, config: loadTestConfig(root), runtimeDeps: createTestAnalystRuntime({ projectRoot: root }) });
      const response = await runtime.submit('s-multi', { userContent: 'list everything' });
      expect(response.message.content).toBe('Done.');
      const rows = readPersistedRows(root, 's-multi');
      const toolCallRows = rows.filter((r) => r.role === 'assistant' && r.kind === 'tool_call');
      expect(toolCallRows).toHaveLength(1);
      for (const tcr of toolCallRows) {
        const payload = JSON.parse(tcr.content) as { role: string; tool_calls: Array<{ id: string; type: string; function: { name: string; arguments: string } }> };
        expect(payload.role).toBe('assistant');
        expect(payload.tool_calls).toHaveLength(1);
        expect(payload.tool_calls[0].type).toBe('function');
      }
      const ids = toolCallRows.map((r) => (JSON.parse(r.content) as { tool_calls: Array<{ id: string }> }).tool_calls[0].id);
      expect(ids).toEqual(['call-a']);
      const resultRows = rows.filter((r) => r.role === 'tool' && r.kind === 'tool_result');
      expect(resultRows.map((r) => r.tool_call_id).sort()).toEqual(['call-a']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('turns malformed tool argument JSON into protocol tool errors without executing tools', async () => {
    const root = setupRoot();
    try {
      const diagnostics: Array<Record<string, unknown>> = [];
      const runtimeDeps = createTestAnalystRuntime({ projectRoot: root });
      runtimeDeps.eventLogger = { appendEvent: (event: unknown) => { diagnostics.push(event as Record<string, unknown>); return event as never; } } as never;
      let call = 0;
      jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        call += 1;
        if (call === 1) return rawToolCallsResponse([{ id: 'bad-args', name: 'list_cards', rawArgs: '{not-json' }]);
        return messageResponse('Done.');
      });

      const runtime = new AnalystRuntime({ projectRoot: root, config: loadTestConfig(root), runtimeDeps });
      const response = await runtime.submit('s-bad-json', { userContent: 'list cards' });

      expect(response.message.content).toBe('Done.');
      expect(diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'runtime_diagnostic', phase: 'analyst_tool_arguments_protocol_violation' }),
      ]));
      const rows = readPersistedRows(root, 's-bad-json');
      expect(rows.some((row) => row.role === 'tool' && row.kind === 'tool_result' && row.content.includes('agent_protocol_violation'))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('records diagnostics when activity callbacks throw', async () => {
    const root = setupRoot();
    try {
      const diagnostics: Array<Record<string, unknown>> = [];
      const runtimeDeps = createTestAnalystRuntime({ projectRoot: root });
      runtimeDeps.eventLogger = { appendEvent: (event: unknown) => { diagnostics.push(event as Record<string, unknown>); return event as never; } } as never;
      let call = 0;
      jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        call += 1;
        if (call === 1) return toolCallsResponse([{ id: 'call-a', name: 'list_cards', args: {} }]);
        return messageResponse('Done.');
      });

      const runtime = new AnalystRuntime({ projectRoot: root, config: loadTestConfig(root), runtimeDeps });
      const response = await runtime.submit('s-activity', { userContent: 'list cards' }, () => { throw new Error('activity boom'); });

      expect(response.message.content).toBe('Done.');
      expect(diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'runtime_diagnostic', phase: 'analyst_activity_callback_failed', error_message: 'activity boom' }),
      ]));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('AnalystRuntime reuses one session actor, rejects concurrent turns, and avoids autonomous snapshots', async () => {
    const root = setupRoot();
    try {
      let resolveFetch!: (response: Response) => void;
      jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
      const runtime = new AnalystRuntime({ projectRoot: root, config: loadTestConfig(root), runtimeDeps: createTestAnalystRuntime({ projectRoot: root }) });

      const first = runtime.submit('analyst:global', { userContent: 'hi' });
      await expect(runtime.submit('analyst:global', { userContent: 'again' })).rejects.toThrow('already has an active turn');
      expect(runtime.listSessions()).toEqual([expect.objectContaining({ sessionId: 'analyst:global', phase: 'conversing' })]);

      await new Promise((resolve) => setImmediate(resolve));
      resolveFetch(messageResponse('Hello once.'));
      await expect(first).resolves.toMatchObject({ sessionId: 'analyst:global', message: { content: 'Hello once.' } });
      expect(runtime.listSessions()).toEqual([expect.objectContaining({ sessionId: 'analyst:global', phase: 'idle' })]);
      expect(existsSync(actorSnapshotPath(root, 'analyst:global'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('excludes persisted model_issue diagnostics from analyst model input', async () => {
    const root = setupRoot();
    try {
      appendConversationMessage(root, {
        role: 'system',
        kind: 'model_issue',
        content: 'provider debug diagnostic must not be resent',
        round_id: 'r-diagnostic-00000000000000000000000000000000',
        message_index: 0,
        block_index: 0,
        timestamp: new Date().toISOString(),
        id: 'diagnostic-model-issue',
        session_id: resolveAnalystSessionId('s-filter'),
      });
      let modelInputContents: string[] = [];
      jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ content?: string }> };
        modelInputContents = (body.messages ?? []).map((message) => String(message.content ?? ''));
        return messageResponse('Done.');
      });

      const runtime = new AnalystRuntime({ projectRoot: root, config: loadTestConfig(root), runtimeDeps: createTestAnalystRuntime({ projectRoot: root }) });
      await runtime.submit('s-filter', { userContent: 'hi' });

      expect(modelInputContents.some((content) => content.includes('provider debug diagnostic'))).toBe(false);
      expect(readPersistedRows(root, 's-filter').some((row) => row.kind === 'model_issue')).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('loads only the active conversation version into the first analyst turn', async () => {
    const root = setupRoot();
    try {
      const sessionId = resolveAnalystSessionId('s-active-version');
      mkdirSync(conversationDir(root, sessionId), { recursive: true });
      writeFileSync(activeVersionPath(root, sessionId, 1), JSON.stringify({
        role: 'user',
        kind: 'text',
        content: 'frozen row must not reach provider',
        round_id: 'r-user-00000000000000000000000000000001',
        message_index: 1,
        block_index: 0,
        timestamp: '2026-01-01T00:00:00.000Z',
        id: 'frozen-row',
        session_id: sessionId,
      }) + '\n');
      writeFileSync(activeVersionPath(root, sessionId, 2), JSON.stringify({
        role: 'user',
        kind: 'text',
        content: 'active row must reach provider',
        round_id: 'r-user-00000000000000000000000000000002',
        message_index: 1,
        block_index: 0,
        timestamp: '2026-01-01T00:00:01.000Z',
        id: 'active-row',
        session_id: sessionId,
      }) + '\n');
      writeConversationIndex(root, sessionId, {
        schema_version: 2,
        session_id: sessionId,
        active_version: 2,
        versions: {
          '1': { status: 'frozen', opened_at: '2026-01-01T00:00:00.000Z', frozen_at: '2026-01-01T00:00:02.000Z' },
          '2': { status: 'active', opened_at: '2026-01-01T00:00:03.000Z' },
        },
      });
      let modelInputContents: string[] = [];
      jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ content?: string }> };
        modelInputContents = (body.messages ?? []).map((message) => String(message.content ?? ''));
        return messageResponse('Done.');
      });

      const runtime = new AnalystRuntime({ projectRoot: root, config: loadTestConfig(root), runtimeDeps: createTestAnalystRuntime({ projectRoot: root }) });
      await runtime.submit('s-active-version', { userContent: 'hi' });

      expect(modelInputContents.some((content) => content.includes('active row must reach provider'))).toBe(true);
      expect(modelInputContents.some((content) => content.includes('frozen row must not reach provider'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
