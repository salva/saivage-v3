import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocket } from 'ws';

import { ModelRouter } from '../../src/agents/model-router.js';
import { ProviderRegistry } from '../../src/agents/provider.js';
import { createRuntimeApplication } from '../../src/application/runtime-composition.js';
import { CardService } from '../../src/cards/card-service.js';
import type { LiveSyncInvalidateFrame } from '../../src/contracts/index.js';
import { createEventLog } from '../../src/observability/index.js';
import { readAppLogEntries } from '../../src/persistence/app-log.js';
import { readConversation } from '../../src/persistence/conversation-file.js';
import { bindRuntimeWorkflows, compileProjectWorkflows } from '../../src/runtime/card-process/card-process-config.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { effectiveSaivageConfigSchema } from '../../src/schemas/saivage-config.js';
import { LiveSyncSocket } from '../../src/server/live-sync-socket.js';
import { SyncHub } from '../../src/server/sync-hub.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { unusedMcpToolInvocation } from '../helpers/llm-test-helpers.js';
import { createTestConfigAuthority } from '../helpers/project-config.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';

const roots: string[] = [];

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function toolCalls(...calls: Array<{ id: string; name: string }>): Response {
  return new Response(JSON.stringify({
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: calls.map(({ id, name }) => ({
          id,
          type: 'function',
          function: { name, arguments: '{}' },
        })),
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function fakeSocket(): WebSocket {
  return {
    OPEN: 1,
    CONNECTING: 0,
    readyState: 1,
    send: jest.fn(),
    close: jest.fn(),
    removeAllListeners: jest.fn(),
  } as unknown as WebSocket;
}

describe('production-composed Analyst provider-exchange recording', () => {
  it('records a successful invalid-tool-count continuation against its assistant model issue', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-26T12:00:00.000Z'));
    const projectRoot = mkdtempSync(join(tmpdir(), 'analyst-provider-exchange-recording-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);

    const socket = fakeSocket();
    const live = new LiveSyncSocket();
    live.add(socket);
    const hub = new SyncHub(live, 10);

    try {
      createEventLog(projectRoot).appendEvent({
        id: 'seed-current-app-log-event',
        timestamp: '2026-07-26T11:59:59.000Z',
        kind: 'runtime_diagnostic',
        error_message: 'Current-format app-log seed.',
      });

      const config = effectiveSaivageConfigSchema.parse({
        ...structuredClone(TEST_SAIVAGE_CONFIG),
        providers: {
          test: {
            models: ['test-model'],
            baseUrl: 'https://provider.example.test/v1',
            apiKey: 'synthetic-test-key',
            capabilities: {
              transportProtocol: 'openai-chat-completions',
              toolsMode: 'native',
              exclusiveToolChoiceSupport: 'native',
              contextWindowTokens: 100_000,
              maxOutputTokens: 10_000,
            },
          },
        },
        compaction: {
          ...structuredClone(TEST_SAIVAGE_CONFIG.compaction),
          context_utilization_fraction: 0.8,
        },
      });
      const registry = new ProviderRegistry(config);
      const workflows = bindRuntimeWorkflows(
        compileProjectWorkflows(config),
        new ModelRouter(registry),
        registry,
        config.compaction.context_utilization_fraction,
      );
      const processRegistry = new ManagedProcessGroupRegistry();
      const runtimeProcessRootScope = processRegistry.createContainerScope(processRegistry.rootScope, 'runtime');
      const analystProcessRootScope = processRegistry.createContainerScope(processRegistry.rootScope, 'analyst');
      const processRunner = new ProcessRunner(projectRoot, processRegistry, testApplicationFatalPort);
      const cardStore = new CardService(projectRoot, workflows, hub);
      const app = createRuntimeApplication({
        projectRoot,
        processIdentity: { pid: 42, startedAt: '2026-07-26T11:00:00.000Z' },
        config,
        workflows,
        providerRegistry: registry,
        configAuthority: createTestConfigAuthority(projectRoot),
        cardStore,
        freshness: hub,
        processRunner,
        runtimeProcessRootScope,
        analystProcessRootScope,
        mcpToolInvocation: unusedMcpToolInvocation,
        restartCapability: { available: false },
        fatalPort: testApplicationFatalPort,
        analystSessionId: 'agent:analyst:global',
      });

      expect(live.handleClientFrame(socket, {
        t: 'subscribe',
        resource: 'llm-exchange',
        id: app.analystSessionId,
        lease: 'analyst-exchange-regression',
      })).toBe(true);
      expect(socket.send).toHaveBeenCalledWith(JSON.stringify({
        t: 'subscribed',
        resource: 'llm-exchange',
        id: app.analystSessionId,
        lease: 'analyst-exchange-regression',
      }));
      jest.mocked(socket.send).mockClear();

      const fetch = jest.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(toolCalls({ id: 'list-project', name: 'list_cards' }))
        .mockResolvedValueOnce(toolCalls(
          { id: 'unsupported-second-a', name: 'list_cards' },
          { id: 'unsupported-second-b', name: 'list_cards' },
        ));

      const response = await app.analystRuntime.submit({ userContent: 'List the project cards.' });

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(response.toolInvocations).toMatchObject([
        {
          tool: 'list_cards',
          params: {},
          toolCallId: 'list-project',
          result: {
            success: true,
            data: { cards: { items: [{ id: 'project' }] } },
          },
        },
      ]);

      const conversation = readConversation(projectRoot, app.analystSessionId);
      const rows = conversation.physicalRows;
      expect(rows.slice(0, 3)).toMatchObject([
        { role: 'system', kind: 'activity' },
        { role: 'system', kind: 'text', content: '[workspace-context] none — no entity is currently in focus' },
        { role: 'user', kind: 'text', content: 'List the project cards.' },
      ]);
      const ingressUser = rows.findIndex((row) => row.role === 'user' && row.content === 'List the project cards.');
      const firstToolCall = rows.findIndex((row) => row.kind === 'tool_call' && row.tool_call_id === 'list-project');
      const firstToolResult = rows.findIndex((row) => row.kind === 'tool_result' && row.tool_call_id === 'list-project');
      const continuationIssue = rows.findIndex((row) => row.kind === 'model_issue' && row.content === 'Provider returned 2 tool calls; exactly one supported tool call is required.');
      const analystNotice = rows.findIndex((row) => row.kind === 'text' && row.content === 'Analyst LLM unavailable: Provider returned 2 tool calls; exactly one supported tool call is required.');
      const expectedOrder = [ingressUser, firstToolCall, firstToolResult, continuationIssue, analystNotice];
      expect(expectedOrder.every((index) => index >= 0)).toBe(true);
      expect(expectedOrder).toEqual([...expectedOrder].sort((left, right) => left - right));

      const toolResult = JSON.parse(rows[firstToolResult]!.content) as { success: boolean; data: { cards: { items: Array<{ id: string }> } } };
      expect(toolResult).toMatchObject({ success: true, data: { cards: { items: [expect.objectContaining({ id: 'project' })] } } });

      const appLog = readAppLogEntries(projectRoot);
      expect(appLog).toContainEqual(expect.objectContaining({ type: 'event', data: expect.objectContaining({ id: 'seed-current-app-log-event' }) }));
      const exchanges = readAppLogEntries(projectRoot, 'provider_exchange');
      expect(exchanges).toHaveLength(2);
      const toolCallRow = rows[firstToolCall]!;
      const issueRow = rows[continuationIssue]!;
      expect(exchanges[0]!.data.payload).toMatchObject({
        status: 'ok',
        source_input_id: toolCallRow.id.slice(0, toolCallRow.id.indexOf(':tool-call:')),
        assistant_output_ids: [toolCallRow.id],
      });
      expect(exchanges[0]!.data.payload).not.toHaveProperty('terminal_conversation_output_id');
      expect(exchanges[1]!.data.payload).toMatchObject({
        status: 'ok',
        source_input_id: issueRow.id.slice(0, -':error'.length),
        assistant_output_ids: [issueRow.id],
      });
      expect(exchanges[1]!.data.payload).not.toHaveProperty('terminal_conversation_output_id');

      expect(socket.send).not.toHaveBeenCalled();
      jest.advanceTimersByTime(10);
      const frames = jest.mocked(socket.send).mock.calls.map(([payload]) => JSON.parse(payload as string) as LiveSyncInvalidateFrame);
      expect(frames).toContainEqual({ t: 'invalidate', resource: 'llm-exchange', id: app.analystSessionId });
    } finally {
      jest.advanceTimersByTime(10);
      hub.dispose();
      jest.useRealTimers();
      rmSync(projectRoot, { recursive: true, force: true });
      roots.splice(roots.indexOf(projectRoot), 1);
    }
  });
});
