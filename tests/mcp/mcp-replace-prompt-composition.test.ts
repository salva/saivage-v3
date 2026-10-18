import { expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SYSTEM_TEMPLATES } from '../../src/config/system-templates/registry.js';
import { effectiveSaivageConfigSchema } from '../../src/schemas/saivage-config.js';
import { compileProjectWorkflows, describeNodeResultContract, nodeResultToolDefinition } from '../../src/runtime/card-process/card-process-config.js';
import { renderCompiledPrompt } from '../../src/utils/prompt-api.js';
import { BoundAgentToolSet, effectiveCardNodeToolReferences, type CompiledToolReference } from '../../src/tools/runtime-tool-catalog.js';
import { surfaceToolDefinitions } from '../../src/tools/invocation.js';
import { unusedMcpToolInvocation } from '../helpers/llm-test-helpers.js';
import { openAIChatAdapter } from '../../src/agents/llm-openai-chat-adapter.js';

it('keeps every shipped profile unchanged and composes opted-in Analyst/card replacement with real generated schemas and provider serialization', () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-replace-composition-'));
  try {
    for (const template of SYSTEM_TEMPLATES) {
      const config = effectiveSaivageConfigSchema.parse(structuredClone(template.config));
      const compiled = compileProjectWorkflows(config, { projectRoot: root, defaultPromptRoot: template.promptRoot });
      for (const agent of compiled.agents.values()) expect(agent.tools.map(t => t.name)).not.toContain('mcp_server_replace');
    }
    const template = SYSTEM_TEMPLATES.find(t => t.name === 'classic')!;
    const config = effectiveSaivageConfigSchema.parse(structuredClone(template.config));
    config.agents.reviewer!.tools.push('mcp_server_replace');
    config.agents.analyst!.tools.push('mcp_server_replace');
    const compiled = compileProjectWorkflows(config, { projectRoot: root, defaultPromptRoot: template.promptRoot });
    const vocabulary = [...compiled.cardTypes.keys()];
    const globalContext = { projectRoot: root, cardTypeVocabulary: vocabulary };
    const definitions = (refs: readonly CompiledToolReference[], scope: 'card' | 'global', agentName: string, extra = {}) => surfaceToolDefinitions(new BoundAgentToolSet(refs).bind({
      scope, agentName, projectRoot: root, cardId: 'project', sessionId: `agent:${agentName}:${scope === 'card' ? 'project' : 'global'}`,
      mcpToolInvocation: unusedMcpToolInvocation, cardTypeVocabulary: vocabulary,
      processScope: {}, processOwnerId: 'offline-composition', observationToolContext: globalContext, analystToolContext: globalContext, ...extra,
    } as never));
    const selected = [...compiled.cardTypes].flatMap(([cardType, process]) => [...process.states].flatMap(([stateId, state]) => state.kind === 'node' && state.agent.name === 'reviewer' ? [{ cardType, process, stateId, state }] : []))[0]!;
    const { cardType, process: workflow, stateId, state } = selected;
    const contract = describeNodeResultContract(workflow, stateId);
    const roleText = renderCompiledPrompt({ kind: 'workflow-agent', cardType }, state.agent.name, state.selectedAgentPrompt.compiled, { contractDescription: contract });
    const nodeText = workflow.processPrompts.get(state.prompt.promptId)!.text;
    const tools = [...definitions(effectiveCardNodeToolReferences(state.agent.tools, state.childCreationTypes), 'card', state.agent.name, { childCreationTypes: state.childCreationTypes, childActivationTypes: state.childActivationTypes }), nodeResultToolDefinition(workflow, stateId)];
    const analystText = renderCompiledPrompt({ kind: 'global-agent' }, compiled.analyst.name, compiled.analystPrompt.compiled, { vocabularySnippet: 'Offline vocabulary orientation; no project data.' });
    const analystTools = definitions(compiled.analyst.tools, 'global', 'analyst');
    for (const selectedTools of [tools, analystTools]) {
      const replace = selectedTools.find(t => t.function.name === 'mcp_server_replace')!;
      expect(replace.function.parameters).toMatchObject({ required: ['serverName', 'connection'], additionalProperties: false });
      expect(selectedTools.map(t => t.function.name).filter(n => n === 'mcp_server_replace')).toHaveLength(1);
    }
    expect(tools.map(t => t.function.name)).not.toContain('mcp_server_control');
    expect(roleText.split(contract)).toHaveLength(2);
    const request = openAIChatAdapter.buildRequestBody({
      candidate: { provider: 'openai-chat', account: null, model: 'offline' }, systemPrompt: analystText,
      providerConversation: { sourceSessionId: 'agent:analyst:global', messages: [] },
      options: { providerSessionId: 'offline', inputId: '11111111-1111-4111-8111-111111111111', temperature: 0, max_tokens: 512, contract_id: 'offline', contractName: 'offline', terminalToolOffered: [], tools: analystTools, tool_choice: 'auto' },
      capabilities: { transportProtocol: 'openai-chat-completions', imageInput: false, toolsMode: 'native', exclusiveToolChoiceSupport: 'native', quirks: [] },
    });
    expect(request.tools).toEqual(analystTools);
    const evidence = { roleText, nodeText, contract, tools, analystText, analystTools, request };
    const destination = process.env.SAIVAGE_TEST_COMPOSITION_EVIDENCE;
    if (destination) { mkdirSync(destination, { recursive: true }); writeFileSync(join(destination, 'replacement-classic-composition.json'), JSON.stringify(evidence, null, 2)); }
  } finally { rmSync(root, { recursive: true }); }
});
