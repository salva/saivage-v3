import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { AgentExecutor as AgentNodeExecution } from '../../../src/runtime/actors/agent-executor.js';
import type { PreparedLlmInvocationInput } from '../../../src/runtime/actors/llm-invocation.js';
import { OPERATIONAL_RESULT_POLICY_TEMPLATE } from '../../../src/tools/invocation.js';
import type { ToolDefinition as LlmToolDefinition } from '../../../src/contracts/index.js';
import { appendConversationBatch, initializeConversation, readConversation } from '../../../src/persistence/conversation-file.js';

type LlmInputBuilder = {
  prepareNodeInvocation(node: unknown, input: unknown, sessionId: string, contractDescription: string, surface: unknown, terminalToolDefinition: LlmToolDefinition, binding: unknown, nodePromptText: string): Omit<PreparedLlmInvocationInput, 'providerConversation'> & { recordContextSupplier: import('../../../src/runtime/actors/llm-invocation.js').RecordContextSupplier };
};

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('AgentNodeExecution LLM options', () => {
  it('uses the compiled agent route maxTokens as the prepared completion request', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-agent-node-options-'));
    roots.push(projectRoot);
    mkdirSync(join(projectRoot, '.saivage', 'cards', 'project', 'conversations'), { recursive: true });
    const sessionId = 'agent:planner:project';
    initializeConversation(projectRoot, sessionId);
    appendConversationBatch({ projectRoot }, [{
      id: 'activation', session_id: sessionId, role: 'system', kind: 'activity',
      context_policy: { kind: 'structural', behavior: 'activation_boundary' },
      content: JSON.stringify({ event: 'activation_open', instructions: { kind: 'unavailable', reason: 'not_recorded' }, agent_name: 'planner', card_id: 'project', input_id: '00000000-0000-4000-8000-000000000001', timestamp: '2026-07-23T00:00:00.000Z' }),
      round_id: 'r-pre-00000000000000000000000000000000', message_index: 0, block_index: 0, timestamp: '2026-07-23T00:00:00.000Z',
    }]);

    const store = {
      workflows: { cardTypes: new Map([['project', { bootstrapRecord: { name: 'brief.md' } }]]) },
      readRecordCurrent: () => ({ kind: 'found', value: { projection: { accepted: { content: 'brief' } } } }),
      listChildren: () => [],
    };
    let renderedVariables: Record<string, unknown> | undefined;
    const runner = new AgentNodeExecution({
      projectRoot,
      cardId: 'project',
      store,
      conversations: { projectRoot },
      promptTemplates: { render: (_cardType: string, _agentName: string, variables: Record<string, unknown>) => { renderedVariables = variables; return 'system'; } },
      compactionConfig: {
        context_utilization_fraction: 0.8,
        trigger_fraction: 0.7,
        tail_fraction: 0.25,
        snap: 'keep_straddler_verbatim',
      },
    } as never, { freshInputId: () => 'input-1' } as never) as unknown as LlmInputBuilder;

    const operationalTool = { name: 'lookup', description: 'Lookup', resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE, inputSchema: z.object({ query: z.string() }).strict(), executor: async () => ({ success: true as const }) };
    const terminalToolDefinition: LlmToolDefinition = { type: 'function', function: { name: 'emit_result', description: 'Emit result', parameters: { type: 'object' } } };
    const retainedCapabilityRequest = { requiresTools: true, requiresExclusiveToolChoice: true } as const;
    const prepared = runner.prepareNodeInvocation(
      { nodeId: 'work', execution: { kind: 'agent', prompt: { promptId: 'work', compactable: true }, agent: { name: 'planner', model: { temperature: 0.2, maxTokens: 73 } } } },
      { card: { id: 'project', type: 'project', title: 'Project' }, activationId: '00000000-0000-4000-8000-000000000001', caller: { kind:'root' } },
      sessionId,
      'direct result contract',
      { agentName: 'planner', tools: new Map([['lookup', operationalTool]]), providers: [] },
      terminalToolDefinition,
      { contract: { model: { temperature: 0.2, maxTokens: 73 } }, candidateChain: [{ provider: 'test', account: null, model: 'planner-model' }], routeUsableInputTokens: 8_000, capabilityRequest: retainedCapabilityRequest },
      'selected node prompt body',
    );

    expect(prepared.preparedCompaction).toMatchObject({
      routeUsableInputTokens: 8_000,
      requestedCompletionTokens: 73,
    });
    expect(prepared.modelParams).toEqual({ temperature: 0.2 });
    expect(prepared.tools.map((tool) => tool.function.name)).toEqual(['lookup', 'emit_result']);
    expect(prepared.tools.filter((tool) => tool.function.name === 'emit_result')).toEqual([terminalToolDefinition]);
    expect(prepared.terminalToolNames).toEqual(['emit_result']);
    expect(prepared.capabilityRequest).toEqual({ requiresTools: true, requiresExclusiveToolChoice: true });
    expect(prepared.capabilityRequest).toBe(retainedCapabilityRequest);
    expect(prepared.inputId).toBe('input-1');
    expect(prepared.preparedContext.prefix.instructionText).toBe('system');
    expect(prepared.preparedContext.prefix.terminalToolNames).toEqual(['emit_result']);
    expect(prepared.preparedContext.compiledTools).toEqual(prepared.compiledToolContracts);
    expect(prepared.preparedContext.compiledTools.map((tool) => tool.providerDefinition)).toEqual(prepared.tools);
    expect(prepared.preparedContext.stableBlocks).toHaveLength(2);
    expect(prepared.preparedContext.stableBlocks[0]).toMatchObject({ id: 'card-activation:project', storage: 'activation_local', replacement: { kind: 'retain' } });
    expect(prepared.preparedContext.stableBlocks[1]).toMatchObject({ id: 'node-activation:project:work', content: "Current workflow node 'work':\n\nselected node prompt body", storage: 'activation_local', replacement: { kind: 'retain' }, audience: 'primary_and_summarizer' });
    expect(JSON.parse(prepared.preparedContext.stableBlocks[0]!.content)).toEqual({ cardId: 'project', cardType: 'project', title: 'Project' });
    expect(prepared.preparedContext.recordBlocks).toEqual([]);
    expect(prepared.recordContextSupplier).toBeDefined();
    expect(prepared.preparedContext.preparedCompaction).toBe(prepared.preparedCompaction);
  expect(Object.keys(prepared)).not.toContain('providerConversation');
  expect(renderedVariables).toMatchObject({ contractDescription: 'direct result contract' });
  expect(renderedVariables).not.toHaveProperty('toolList');
  expect(renderedVariables).not.toHaveProperty('cardId');
  expect(prepared.preparedContext.compiledTools.map((tool) => tool.providerDefinition.function.name)).toEqual(['lookup', 'emit_result']);
});

  it('appends only one activation marker on first and subsequent node entry', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-agent-node-entry-'));
    roots.push(projectRoot);
    mkdirSync(join(projectRoot, '.saivage', 'cards', 'project', 'conversations'), { recursive: true });
    const sessionId = 'agent:planner:project';
    initializeConversation(projectRoot, sessionId);
    const runner = new AgentNodeExecution({
      projectRoot,
      cardId: 'project',
      conversations: { projectRoot },
    } as never, {} as never) as unknown as {
      prepareNodeEntry(process: unknown, node: unknown, transition: unknown, input: unknown, sessionId: string, inputId: string, reviewerPair: null, instructions: import('../../../src/schemas/index.js').ActivationInstructions): void;
    };
    const node = { nodeId: 'work', execution: { kind: 'agent', agent: { name: 'planner' }, prompt: { promptId: 'work', compactable: true } } };
    const process = {
      cardType: 'project',
      states: new Map([['entry:READY', { kind: 'entry', entry: 'READY', on: new Map([['begin', { targetStateId: 'node:work', semantic: { kind: 'entry-route', promptId: null } }]]) }]]),
      processPrompts: new Map([['work', { text: 'selected node prompt body' }], ['other', { text: 'unselected prompt body' }]]),
    };
    const transition = { context: { source: 'entry:READY', event: 'begin', target: 'node:work' }, acceptedResult: null };
    const input = { card: { id: 'project', type: 'project' }, notificationDelivery: { hasPendingNotifications: () => false, selectNotifications: () => [], removeNotifications: () => undefined } };
    const firstInputId = '00000000-0000-4000-8000-000000000001';
    const secondInputId = '00000000-0000-4000-8000-000000000002';

    runner.prepareNodeEntry(process, node, transition, input, sessionId, firstInputId, null, {kind:'unavailable',reason:'not_recorded'});
    expect(readConversation(projectRoot, sessionId).sourceRows
      .filter((row) => row.kind === 'activity')
      .map((row) => (JSON.parse(row.content) as { input_id: string }).input_id)).toEqual([firstInputId]);
    expect(readConversation(projectRoot, sessionId).sourceRows.filter((row) => row.role === 'user')).toEqual([]);

    runner.prepareNodeEntry(process, node, transition, input, sessionId, secondInputId, null, {kind:'unavailable',reason:'not_recorded'});
    expect(readConversation(projectRoot, sessionId).sourceRows
      .filter((row) => row.kind === 'activity')
      .map((row) => (JSON.parse(row.content) as { input_id: string }).input_id)).toEqual([firstInputId, secondInputId]);
    expect(readConversation(projectRoot, sessionId).sourceRows.filter((row) => row.role === 'user')).toEqual([]);
  });
});
