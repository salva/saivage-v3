import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { createObservedCollections } from '../../src/retrieval/observed-collections.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_SAIVAGE_CONFIG,
  SYSTEM_TEMPLATES,
} from '../../src/config/system-templates/registry.js';
import { effectiveSaivageConfigSchema } from '../../src/schemas/index.js';
import { compileProjectWorkflows } from '../../src/runtime/card-process/card-process-config.js';
import {
  BoundAgentToolSet,
  buildRuntimeToolCatalog,
  resolveRuntimeTool,
} from '../../src/tools/runtime-tool-catalog.js';
import {
  cleanupInvocationSurface,
  executeToolAction,
  invokeToolForLlm,
  surfaceToolDefinitions,
  syntheticToolSettlement,
} from '../../src/tools/invocation.js';
import {
  testLlmToolInvocationContext,
  unusedMcpToolInvocation,
} from '../helpers/llm-test-helpers.js';
import { cardInspectionToolBinders } from '../../src/tools/card-inspection-provider.js';
import { CardService, initProjectTree } from '../helpers/canonical-project.js';
import type { PlannerChildControlPort } from '../../src/runtime/actors/card-activation-owner.js';
import { submitNotificationTool } from '../../src/tools/notification-tool.js';
import { readRecordVersionInputSchema } from '../../src/contracts/builtin-tool-inputs.js';
import { buildCandidateRequest } from '../../src/agents/candidate-request.js';
import { selectLlmProtocolAdapter } from '../../src/agents/llm-protocol-adapter.js';
import {
  composeContextProjection,
  providerConversationFromComposedContext,
} from '../../src/runtime/actors/context/composition-projector.js';
import { createPromptTemplateRegistry } from '../../src/utils/prompt-api.js';
import { formatVocabularySnippet } from '../../src/tools/prompt-api.js';
import type { ToolContext } from '../../src/tools/analyst-tool-types.js';
import { appendConversationBatch } from '../../src/persistence/conversation-file.js';
import { TEXT_ROW_POLICY, toolRowPolicies } from '../helpers/row-policy-fixtures.js';

function expectRecordReaderPreparedDelivery(surface: Parameters<typeof surfaceToolDefinitions>[0]) {
  const tools = surfaceToolDefinitions(surface);
  const reader = tools.find((tool) => tool.function.name === 'read_record_version');
  const boundReader = surface.tools.get('read_record_version');
  if (!reader || !boundReader) throw new Error('Missing selected record reader.');
  expect(boundReader.description).toEqual(expect.any(String));
  expect(readRecordVersionInputSchema.shape.version.description).toEqual(expect.any(String));
  expect(reader.function.description).toBe(boundReader.description);
  expect(reader.function.parameters).toMatchObject({
    properties: {
      version: { description: readRecordVersionInputSchema.shape.version.description },
    },
  });
  const providerConversation = providerConversationFromComposedContext(
    composeContextProjection({
      sourceSessionId: 'agent:reviewer:project',
      effectiveHistory: null,
      dynamicBlocks: [],
      uncoveredRows: [],
    }),
  );
  for (const transportProtocol of [
    'openai-chat-completions',
    'openai-responses',
    'openai-codex-backend',
  ] as const) {
    const plan = buildCandidateRequest({
      candidate: { provider: 'openai', account: null, model: 'gpt-5.6' },
      adapter: selectLlmProtocolAdapter(transportProtocol),
      capabilities: {
        transportProtocol,
        imageInput: false,
        toolsMode: 'native',
        exclusiveToolChoiceSupport: 'native',
        quirks: [],
      },
      systemPrompt: 'offline selected-tool delivery check',
      providerConversation,
      options: {
        providerSessionId: 'offline-selected-tools',
        inputId: 'selected-tools',
        temperature: 0,
        max_tokens: 512,
        contract_id: 'selected-tools',
        contractName: 'selected-tools',
        terminalToolOffered: [],
        tools,
        tool_choice: 'auto',
      },
    });
    const prepared = JSON.parse(plan.request.serializedBody) as {
      tools: Array<
        { type: string; function?: typeof reader.function } & Partial<typeof reader.function>
      >;
    };
    const wireReader = prepared.tools.find(
      (tool) => (tool.function?.name ?? tool.name) === reader.function.name,
    );
    expect(wireReader).toEqual(
      transportProtocol === 'openai-chat-completions'
        ? reader
        : { type: 'function', ...reader.function },
    );
    for (const observed of tools.filter((tool) => ['list_observed_collections', 'query_observed_collections'].includes(tool.function.name))) {
      const wire = prepared.tools.find((tool) => (tool.function?.name ?? tool.name) === observed.function.name);
      expect(wire).toEqual(transportProtocol === 'openai-chat-completions'
        ? observed : { type: 'function', ...observed.function });
    }
  }
}

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});
const unusedParentControl: PlannerChildControlPort = {
  activateChild() {
    throw new Error('unused parent control');
  },
  cancelChild() {
    throw new Error('unused parent control');
  },
  reopenChild() {
    throw new Error('unused parent control');
  },
};

const expected = {
  analyst: [
    'create_card',
    'reorder_child',
    'reopen_card',
    'queue_notification',
    'get_status',
    'start_project',
    'pause_runtime',
    'resume_runtime',
    'stop_project',
    'restart_server',
    'navigate_workspace',
    'navigate_back',
    'show_config',
    'reconfigure',
    'read_runtime_events',
    'read_runtime_errors',
    'read_control_actions',
    'list_processes_tool',
    'list_agent_sessions',
    'read_agent_session',
    'cancel_card',
    'delete_card',
    'list_cards',
    'get_card',
    'get_tree',
    'list_card_versions',
    'get_card_version',
    'diff_card_versions',
    'read_record_version',
    'read',
    'view_image',
    'write',
    'edit',
    'glob',
    'grep',
    'apply_patch',
    'run_command',
    'wait_process',
    'kill_process',
    'websearch',
    'webfetch',
    'skill',
    'list_observed_collections',
    'query_observed_collections',
    'mcp_tool_call',
    'mcp_server_control',
    'mcp_tools',
  ],
  oversight: [
    'get_status',
    'list_cards',
    'get_card',
    'get_tree',
    'list_card_versions',
    'get_card_version',
    'diff_card_versions',
    'read_record_version',
    'read',
    'glob',
    'grep',
    'read_runtime_events',
    'read_runtime_errors',
    'list_processes_tool',
    'list_agent_sessions',
    'read_agent_session',
    'queue_notification',
  ],
  planner: [
    'create_card',
    'edit_card',
    'cancel_card',
    'activate_card',
    'reopen_card',
    'reorder_child',
    'list_cards',
    'get_card',
    'get_tree',
    'read',
    'write',
    'edit',
    'glob',
    'grep',
    'list_card_versions',
    'get_card_version',
    'diff_card_versions',
    'read_record_version',
    'websearch',
    'webfetch',
    'list_observed_collections',
    'query_observed_collections',
  ],
  reviewer: [
    'read',
    'view_image',
    'write',
    'edit',
    'glob',
    'grep',
    'list_card_versions',
    'get_card_version',
    'diff_card_versions',
    'read_record_version',
    'websearch',
    'webfetch',
    'skill',
    'list_observed_collections',
    'query_observed_collections',
  ],
  executor: [
    'read',
    'view_image',
    'write',
    'edit',
    'glob',
    'grep',
    'apply_patch',
    'run_command',
    'wait_process',
    'kill_process',
    'list_card_versions',
    'get_card_version',
    'diff_card_versions',
    'read_record_version',
    'websearch',
    'webfetch',
    'skill',
    'list_observed_collections',
    'query_observed_collections',
    'mcp_tool_call',
    'mcp_server_control',
    'mcp_tools',
  ],
} as const;

describe('named-agent inventories and composition', () => {
  it.each(['analyst', 'oversight'] as const)('delivers the actual bound %s session navigation and result through offline provider requests with its selected role', async (agentName) => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-diagnostic-composition-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const workflows = compileProjectWorkflows(DEFAULT_SAIVAGE_CONFIG as never);
    const selected = workflows.agents.get(agentName)!;
    const store = new CardService(projectRoot);
    const processRunner = { closeAndTerminateDirectScope: async () => ({ failed: [] }) } as never;
    const observationToolContext = { agentName, projectRoot, store, processRunner, eventQueries: {} as never, runtime: { getStatus: () => ({ status: 'stopped' as const, currentCardId: null, pid: 1, startedAt: '2026-11-10T00:00:00.000Z' }) }, queueNotification: async () => { throw new Error('not invoked'); }, captureExecutingLlmSnapshots: () => new Map() };
    const vocabulary = [...workflows.cardTypes.keys()];
    const surface = new BoundAgentToolSet(selected.tools).bind({ scope: 'global', agentName, projectRoot, store, processRunner, processScope: {} as never, processOwnerId: 'offline-composition', mcpToolInvocation: {} as never, retrieval: createObservedCollections(projectRoot), analystToolContext: { ...observationToolContext, cardTypeVocabulary: vocabulary } as unknown as ToolContext, observationToolContext, cardTypeVocabulary: vocabulary });
    const sessionId = `agent:${agentName}:global` as const;
    const timestamp = '2026-11-10T00:00:00.000Z';
    appendConversationBatch({ projectRoot }, [{ id: 'narrative-only', session_id: 'agent:planner:project', timestamp, role: 'user', kind: 'text', context_policy: TEXT_ROW_POLICY, content: 'Old reported failure, not an observed diagnostic.', round_id: 'r-user-11111111111141118111111111111111', message_index: 0, block_index: 0 }]);
    const reader = surface.tools.get('read_agent_session')!;
    const args = reader.inputSchema.parse({ session_id: 'agent:planner:project', section: 'diagnostics' });
    const execution = await reader.executor(args, new AbortController().signal);
    if (execution.providerOutcome.kind !== 'succeeded') throw new Error(execution.providerOutcome.error);
    expect(execution.providerOutcome.data).toMatchObject({ total_diagnostic_entries: 0, scope: 'current_segment_rows' });
    const tools = surfaceToolDefinitions(surface);
    const definition = tools.find(tool => tool.function.name === 'read_agent_session')!;
    expect(definition.function.description).toBe(reader.description);
    const systemPrompt = createPromptTemplateRegistry(workflows).render({ kind: 'global-agent' }, agentName, { vocabularySnippet: formatVocabularySnippet(vocabulary) });
    const content = JSON.stringify({ success: true, data: execution.providerOutcome.data });
    const policies = toolRowPolicies({ content });
    const inputId = '11111111-1111-4111-8111-111111111111';
    const common = { session_id: sessionId, timestamp, round_id: 'r-assistant-11111111111141118111111111111111', message_index: 1, block_index: 0, tool: 'read_agent_session', tool_call_id: 'diagnostic-read' };
    const providerConversation = providerConversationFromComposedContext(composeContextProjection({ sourceSessionId: sessionId, effectiveHistory: null, dynamicBlocks: [], uncoveredRows: [
      { ...common, id: `${inputId}:tool-call:diagnostic-read`, role: 'assistant', kind: 'tool_call', context_policy: policies.call, content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'diagnostic-read', type: 'function', function: { name: 'read_agent_session', arguments: JSON.stringify(args) } }] }) },
      { ...common, id: `${inputId}:tool-result:diagnostic-read`, role: 'tool', kind: 'tool_result', context_policy: policies.result, content },
    ] }));
    for (const transportProtocol of ['openai-chat-completions', 'openai-responses', 'openai-codex-backend'] as const) {
      const plan = buildCandidateRequest({ candidate: { provider: 'openai', account: null, model: 'gpt-5.6' }, adapter: selectLlmProtocolAdapter(transportProtocol), capabilities: { transportProtocol, imageInput: false, toolsMode: 'native', exclusiveToolChoiceSupport: 'native', quirks: [] }, systemPrompt, providerConversation, options: { providerSessionId: 'offline-session-navigation', inputId, temperature: 0, max_tokens: 512, contract_id: 'session-navigation', contractName: 'session-navigation', terminalToolOffered: [], tools, tool_choice: 'auto' } });
      const prepared = JSON.parse(plan.request.serializedBody);
      expect(prepared.tools.find((tool: any) => (tool.function?.name ?? tool.name) === 'read_agent_session')).toEqual(transportProtocol === 'openai-chat-completions' ? definition : { type: 'function', ...definition.function });
      expect(JSON.stringify(prepared)).toContain(JSON.stringify(systemPrompt).slice(1, -1));
      expect(plan.request.serializedBody).toContain('current_segment_rows');
      expect(plan.request.serializedBody).toContain('diagnostic-read');
    }
    await cleanupInvocationSurface(surface, { kind: 'activation_settled', status: 'done' });
  });
  it.each(SYSTEM_TEMPLATES)(
    'compiles the exact $name named inventory in declared order without MCP reconcile',
    (template) => {
      const config = effectiveSaivageConfigSchema.parse(templateConfig(template));
      const workflows = compileProjectWorkflows(config as never, {
        defaultPromptRoot: template.promptRoot,
      });
      expect([...workflows.agents.keys()]).toEqual([
        'analyst',
        'oversight',
        'planner',
        'reviewer',
        'executor',
      ]);
      for (const [name, originalTools] of Object.entries(expected)) {
        const tools = template.name !== 'classic-git' ? originalTools : name === 'analyst'
          ? originalTools.filter(tool => !['run_command','wait_process','kill_process','mcp_tool_call','mcp_server_control','mcp_tools'].includes(tool))
          : name === 'executor' ? [...originalTools, 'checkpoint_source'] : originalTools;
        expect(config.agents[name]!.capabilities.grants.flatMap((grant) => grant.tools)).toEqual(tools);
        expect(workflows.agents.get(name as never)?.tools.map((tool) => tool.name)).toEqual(tools);
        expect(new Set(tools).size).toBe(tools.length);
      }
    },
  );

  it('compiles nine independent card-type workflow artifacts', () => {
    const workflows = compileProjectWorkflows(DEFAULT_SAIVAGE_CONFIG as never);
    expect([...workflows.cardTypes.keys()]).toEqual([
      'project',
      'goal',
      'architecture',
      'code',
      'test',
      'doc',
      'data',
      'research',
      'ops',
    ]);
    expect(workflows.cardTypes.get('project')).not.toBe(workflows.cardTypes.get('goal'));
    expect(workflows.cardTypes.get('code')).not.toBe(workflows.cardTypes.get('test'));
  });

  it('keeps global/card same-name authority distinct and rejects duplicate scope/name catalog entries', () => {
    expect(resolveRuntimeTool('global', 'reopen_card', [{kind:'card',scopes:['all']}]).name).toBe('reopen_card');
    const plannerReopen = resolveRuntimeTool('card', 'reopen_card', [{kind:'card',scopes:['children']}]);
    expect(plannerReopen.name).toBe('reopen_card');
    expect(plannerReopen.providerGroupId).not.toBe(
      resolveRuntimeTool('global', 'reopen_card', [{kind:'card',scopes:['all']}]).providerGroupId,
    );
    const globalCancel = resolveRuntimeTool('global', 'cancel_card', [{kind:'card',scopes:['all']}]);
    const cardCancel = resolveRuntimeTool('card', 'cancel_card', [{kind:'card',scopes:['children']}]);
    expect(globalCancel.providerGroupId).not.toBe(cardCancel.providerGroupId);
    expect(globalCancel.description).not.toBe(cardCancel.description);
    const inspectionStore = {
      listCardInspectionRows: () => [],
      readCardInspectionTree: () => {
        throw new Error('unused store stub');
      },
      getCardDetail: () => {
        throw new Error('unused store stub');
      },
      getCardChildren: () => {
        throw new Error('unused store stub');
      },
      listDeclaredRecordMetadata: () => {
        throw new Error('unused store stub');
      },
    };
    const group = (key: string) => ({
      key,
      providerName: key,
      scope: 'card' as const,
      binders: [cardInspectionToolBinders[0]!],
      context: () => ({ store: inspectionStore }),
    });
    expect(() => buildRuntimeToolCatalog([group('one'), group('two')] as never)).toThrow(
      "Duplicate runtime tool catalog entry 'card/list_cards'.",
    );
    expect(
      (buildRuntimeToolCatalog([group('one')] as never) as Map<string, unknown>).set,
    ).toBeUndefined();
  });

  it('binds Planner reopen only when explicitly selected, independently of the configured agent name', () => {
    const reopenChild = jest.fn(({ childCardId }: { childCardId: string }) => ({
      card_id: childCardId,
      status: 'changed' as const,
    }));
    const runtime = {
      scope: 'card' as const,
      agentName: 'project-planner' as never,
      projectRoot: '/',
      store: {} as never,
      cardId: 'project',
      sessionId: 'agent:project-planner:project',
      parentControl: { ...unusedParentControl, reopenChild },
      recordMutations: UNUSED_CARD_RECORD_MUTATIONS,
      childCreationTypes: new Set<string>(),
      childActivationTypes: new Set<string>(),
      cardTypeVocabulary: [
        'project',
        'goal',
        'architecture',
        'code',
        'test',
        'doc',
        'data',
        'research',
        'ops',
      ] as const,
      notifyCard: () => ({
        ok: false as const,
        reason: 'missing_card' as const,
        cardId: 'project',
      }),
      processRunner: {} as never,
      mcpToolInvocation: {} as never,
    };
    const selected = new BoundAgentToolSet([resolveRuntimeTool('card', 'reopen_card', [{kind:'card',scopes:['children']}])]).bind(
      runtime,
    );
    expect([...selected.tools.keys()]).toEqual(['reopen_card']);
    expect(selected.providers.map(({ providerName }) => providerName)).toEqual(['planner-control']);
    const omitted = new BoundAgentToolSet([]).bind(runtime);
    expect(omitted.tools.has('reopen_card')).toBe(false);
  });

  it('aggregates provider-owned binders without synthetic or broad provider construction', () => {
    const source = readFileSync(
      new URL('../../src/tools/runtime-tool-catalog.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/prototypeProvider|\binert\b|create[A-Za-z]+Provider/);
    expect(source).toContain('const definition = entry.binder.bind(context)');
  });

  it('composes Reviewer exactly and omits MCP when the named agent does not declare it', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-named-reviewer-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const selected = compileProjectWorkflows(DEFAULT_SAIVAGE_CONFIG as never).agents.get(
      'reviewer',
    );
    if (!selected) throw new Error('Missing configured Reviewer.');
    const toolSet = new BoundAgentToolSet(selected.tools);
    const surface = toolSet.bind({
      scope: 'card',
      agentName: 'reviewer',
      projectRoot,
      retrieval: createObservedCollections(projectRoot),
      store: new CardService(projectRoot),
      cardId: 'project',
      sessionId: 'agent:reviewer:project',
      parentControl: unusedParentControl,
      recordMutations: UNUSED_CARD_RECORD_MUTATIONS,
      childCreationTypes: new Set(),
      childActivationTypes: new Set(),
      cardTypeVocabulary: [
        'project',
        'goal',
        'architecture',
        'code',
        'test',
        'doc',
        'data',
        'research',
        'ops',
      ],
      notifyCard: () => ({ ok: false, reason: 'missing_card', cardId: 'project' }),
      processRunner: {} as never,
      mcpToolInvocation: {} as never,
    });
    expect([...surface.tools.keys()]).toEqual(expected.reviewer);
    expect(surfaceToolDefinitions(surface).map((tool) => tool.function.name)).toEqual(
      expected.reviewer,
    );
    expect(surface.providers.map((provider) => provider.providerName)).toEqual([
      'card-version',
      'workspace',
      'web',
      'retrieval',
      'skill',
    ]);
    expect(surface.tools.has('mcp_tool_call')).toBe(false);
    expectRecordReaderPreparedDelivery(surface);
  });

  it.each(['oversight', 'renamed-observer'])(
    'binds selected %s notification execution from its explicit narrow authority',
    async (agentName) => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-oversight-surface-'));
      roots.push(projectRoot);
      initProjectTree(projectRoot);
      const store = new CardService(projectRoot);
      const processRunner = { list: () => [] } as never;
      const config = effectiveSaivageConfigSchema.parse(structuredClone(DEFAULT_SAIVAGE_CONFIG));
      config.agents[agentName] = config.agents.oversight!;
      config.oversight.agent = agentName;
      if (agentName !== 'oversight') delete config.agents.oversight;
      const selected = compileProjectWorkflows(config).oversight;
      const submitNotification = jest.fn(async (_authority: unknown, _cardId: string, notification: { id: string }) => ({
        queued: true as const,
        cardId: 'project',
        notificationId: notification.id,
        interruption: { status: 'not_requested' as const },
      }));
      const observationToolContext = {
        agentName: selected.name,
        projectRoot,
        store,
        processRunner,
        eventQueries: {} as never,
        runtime: {
          getStatus: () => ({
            status: 'stopped' as const,
            currentCardId: null,
            pid: 1,
            startedAt: '2026-09-14T00:00:00.000Z',
          }),
        },
        queueNotification: (
          input: Parameters<typeof submitNotificationTool>[1],
          signal: AbortSignal,
          authority: Parameters<typeof submitNotificationTool>[0],
        ) =>
          executeToolAction('none', () =>
            submitNotificationTool(authority, input, submitNotification, signal),
          ),
        captureExecutingLlmSnapshots: () => new Map(),
        currentProcessPosition: () => null,
      };
      const surface = new BoundAgentToolSet(selected.tools).bind({
        scope: 'global',
        agentName: selected.name,
        projectRoot,
        store,
        processRunner,
        mcpToolInvocation: {} as never,
        observationToolContext,
        cardTypeVocabulary: [
          'project',
          'goal',
          'architecture',
          'code',
          'test',
          'doc',
          'data',
          'research',
          'ops',
        ],
      });
      expect([...surface.tools.keys()]).toEqual(expected.oversight);
      expectRecordReaderPreparedDelivery(surface);
      expect(surface.providers.map(({ providerName }) => providerName)).toEqual([
        'observation',
        'workspace',
        'card-inspection',
        'card-version',
      ]);
      for (const forbidden of [
        'write',
        'edit',
        'apply_patch',
        'run_command',
        'kill_process',
        'mcp_tool_call',
        'mcp_server_control',
        'mcp_tools',
        'skill',
        'webfetch',
      ])
        expect(surface.tools.has(forbidden)).toBe(false);
      const notification = surface.tools.get('queue_notification');
      if (!notification) throw new Error('missing queue_notification');
      const result = await notification.executor(
        { card_id: 'project', kind: 'finding', body: 'evidence', urgency: 'normal' },
        new AbortController().signal,
      );
      expect(result.providerOutcome).toEqual({
        kind: 'succeeded',
        data: {
          queued: true,
          card_id: 'project',
          notification_id: submitNotification.mock.calls[0]![2].id,
          body: 'evidence',
          interruption: { status: 'not_requested' },
        },
      });
      expect(submitNotification).toHaveBeenCalledTimes(1);
    },
  );

  it('grants functional configured MCP and treats the removed name as ordinary unsupported input', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-configured-mcp-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const surface = new BoundAgentToolSet([resolveRuntimeTool('card', 'mcp_tool_call')]).bind({
      scope: 'card',
      agentName: 'reviewer',
      projectRoot,
      store: new CardService(projectRoot),
      cardId: 'project',
      sessionId: 'agent:reviewer:project',
      parentControl: unusedParentControl,
      recordMutations: UNUSED_CARD_RECORD_MUTATIONS,
      childCreationTypes: new Set(),
      childActivationTypes: new Set(),
      cardTypeVocabulary: [
        'project',
        'goal',
        'architecture',
        'code',
        'test',
        'doc',
        'data',
        'research',
        'ops',
      ],
      notifyCard: () => ({ ok: false, reason: 'missing_card', cardId: 'project' }),
      processRunner: {} as never,
      mcpToolInvocation: {
        ...unusedMcpToolInvocation,
        invokeTool: async () => ({ content: [] }),
      },
    });
    expect([...surface.tools.keys()]).toEqual(['mcp_tool_call']);
    expect(surface.providers.map((provider) => provider.providerName)).toEqual(['mcp']);
    await expect(
      invokeToolForLlm(
        surface,
        'mcp_reconcile',
        {},
        testLlmToolInvocationContext({
          sessionId: 'agent:reviewer:project',
          toolName: 'mcp_reconcile',
        }),
      ),
    ).resolves.toEqual(
      syntheticToolSettlement(
        'unsupported_tool',
        "Unsupported tool 'mcp_reconcile' for agent 'reviewer'.",
      ),
    );
    const outcome = await invokeToolForLlm(
      surface,
      'mcp_tool_call',
      { serverName: 'server', bindingId: '11111111-1111-4111-8111-111111111111', catalogId: '22222222-2222-4222-8222-222222222222', toolName: 'tool' },
      testLlmToolInvocationContext({
        sessionId: 'agent:reviewer:project',
        toolName: 'mcp_tool_call',
      }),
    );
    expect(outcome.kind).toBe('executed');
  });

  it('binds selected process definitions without duplicating the common card-node scope cleanup', async () => {
    const closeAndTerminateDirectScope = jest.fn(async () => ({ failed: [] }));
    const toolSet = new BoundAgentToolSet(
      ['wait_process', 'kill_process'].map((name) => resolveRuntimeTool('card', name)),
    );
    const surface = toolSet.bind({
      scope: 'card',
      agentName: 'executor',
      projectRoot: '/',
      store: {} as never,
      cardId: 'project',
      sessionId: 'agent:executor:project',
      parentControl: unusedParentControl,
      recordMutations: UNUSED_CARD_RECORD_MUTATIONS,
      childCreationTypes: new Set(),
      childActivationTypes: new Set(),
      cardTypeVocabulary: [
        'project',
        'goal',
        'architecture',
        'code',
        'test',
        'doc',
        'data',
        'research',
        'ops',
      ],
      notifyCard: () => ({ ok: false, reason: 'missing_card', cardId: 'project' }),
      processRunner: { closeAndTerminateDirectScope } as never,
      processScope: {} as never,
      processOwnerId: 'activation',
      mcpToolInvocation: {} as never,
    });
    expect(surface.providers).toHaveLength(1);
    expect(surface.providers[0]!.tools.map((tool) => tool.name)).toEqual([
      'wait_process',
      'kill_process',
    ]);
    expect(surface.providers[0]!.cleanup).toBeUndefined();
    await cleanupInvocationSurface(surface, { kind: 'activation_settled', status: 'done' });
    expect(closeAndTerminateDirectScope).not.toHaveBeenCalled();
  });
});
import { templateConfig } from '../helpers/system-template-config.js';
import { UNUSED_CARD_RECORD_MUTATIONS } from '../helpers/capability-grants.js';
