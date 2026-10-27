import { agentExecution } from '../helpers/workflow-execution.js';
import { createObservedCollections } from '../../src/retrieval/index.js';
import { expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { DEFAULT_SYSTEM_TEMPLATE } from '../../src/config/system-templates/registry.js';
import { OFF_SYSTEM_TEMPLATES as SYSTEM_TEMPLATES } from '../helpers/system-template-config.js';
import { effectiveSaivageConfigSchema } from '../../src/schemas/saivage-config.js';
import { compileProjectWorkflows, describeNodeResultContract, nodeResultToolDefinition } from '../../src/runtime/card-process/card-process-config.js';
import { renderCompiledPrompt } from '../../src/utils/prompt-api.js';
import { BoundAgentToolSet, effectiveCardNodeToolReferences, type CompiledToolReference } from '../../src/tools/runtime-tool-catalog.js';
import { surfaceToolDefinitions } from '../../src/tools/invocation.js';
import { unusedMcpToolInvocation } from '../helpers/llm-test-helpers.js';
// @ts-expect-error Packaging tooling is JavaScript without TypeScript declarations.
import { assertClassicFamilyPromptParity, assertPaadTypedPromptParity, collectTemplatePromptClosure } from '../../scripts/copy-system-template-prompts.js';

it.each(SYSTEM_TEMPLATES)('renders the complete standalone $name role/generated-tools/node closure with unchanged defaults and explicitly configured Reviewer restart', template => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-restart-prompt-'));
  const retrieval = createObservedCollections(root);
  try {
    expect(DEFAULT_SYSTEM_TEMPLATE).toBe('classic');
    const baseline = effectiveSaivageConfigSchema.parse(structuredClone(template.config));
    const evidence: unknown[] = [];
    for (const configuredReviewer of [false, true]) {
      const config = structuredClone(baseline);
      if (configuredReviewer) config.agents.reviewer!.tools.push('mcp_server_control', 'mcp_tools');
      const observed = new Set<string>();
      const compiled = compileProjectWorkflows(config, {
        projectRoot: root, defaultPromptRoot: template.promptRoot,
        artifactObserver: artifact => {
          const path = relative(template.promptRoot, artifact.path);
          expect(resolve(artifact.path).startsWith(`${resolve(template.promptRoot)}/`)).toBe(true);
          observed.add(path);
        },
      });
      expect([...observed].sort()).toEqual([...collectTemplatePromptClosure({ template })].sort());
      expect(config.card_types).toEqual(baseline.card_types);
      for (const [name, agent] of compiled.agents) {
        const selected = baseline.agents[name]!.tools;
        expect(agent.tools.map(tool => tool.name)).toEqual(configuredReviewer && name === 'reviewer' ? [...selected, 'mcp_server_control', 'mcp_tools'] : selected);
      }
      // Schema-only binder contexts. No executor or provider is called. Full
      // production-serialized requests are independently captured by the E2E.
      const definitions = (refs: readonly CompiledToolReference[], scope: 'global' | 'card', agentName: string, extra: object = {}) => {
        const vocabulary = [...compiled.cardTypes.keys()];
        const globalContext = { projectRoot: root, cardTypeVocabulary: vocabulary };
        return surfaceToolDefinitions(new BoundAgentToolSet(refs).bind({
          retrieval,
          scope, agentName, projectRoot: root, cardId: 'project', sessionId: `agent:${agentName}:${scope === 'card' ? 'project' : 'global'}`,
          mcpToolInvocation: unusedMcpToolInvocation, cardTypeVocabulary: vocabulary,
          processScope: {}, processOwnerId: 'offline-composition',
          observationToolContext: globalContext, analystToolContext: globalContext,
          ...extra,
        } as never));
      };
      const inspectControl = (tools: ReturnType<typeof surfaceToolDefinitions>, allowed: boolean) => {
        const control = tools.find(tool => tool.function.name === 'mcp_server_control');
        expect(control !== undefined).toBe(allowed);
        if (control) expect(control.function.parameters).toMatchObject({ properties: { action: { enum: ['start', 'stop', 'restart'] } }, additionalProperties: false });
      };
      for (const [cardType, process] of compiled.cardTypes) {
        for (const [stateId, state] of process.states) {
          if (state.kind !== 'node') continue;
          const contract = describeNodeResultContract(process, stateId);
          const roleText = renderCompiledPrompt({ kind: 'workflow-agent', cardType }, agentExecution(state).agent.name, agentExecution(state).selectedAgentPrompt.compiled, { contractDescription: contract });
          const nodeText = process.processPrompts.get(agentExecution(state).prompt.promptId)!.text;
          const refs = effectiveCardNodeToolReferences(agentExecution(state).agent.tools, state.childCreationTypes);
          const tools = [...definitions(refs, 'card', agentExecution(state).agent.name, { childCreationTypes: state.childCreationTypes, childActivationTypes: state.childActivationTypes }), nodeResultToolDefinition(process, stateId)];
          inspectControl(tools, agentExecution(state).agent.name === 'executor' || configuredReviewer && agentExecution(state).agent.name === 'reviewer');
          expect(roleText.split(contract)).toHaveLength(2);
          expect(nodeText.length).toBeGreaterThan(0);
          evidence.push({ configuredReviewer, cardType, stateId, role: agentExecution(state).agent.name, roleText, nodeText, contract, tools });
        }
        // Preserve the other entry/edge/correction prompt closure too, not just
        // the first node encountered for each role.
        evidence.push({ configuredReviewer, cardType, processPrompts: [...process.processPrompts] });
      }
      for (const [agent, prompt] of [[compiled.analyst, compiled.analystPrompt], [compiled.oversight, compiled.oversightPrompt]] as const) {
        const roleText = renderCompiledPrompt({ kind: 'global-agent' }, agent.name, prompt.compiled, { vocabularySnippet: 'Offline vocabulary orientation; no project data.' });
        const tools = definitions(agent.tools, 'global', agent.name);
        inspectControl(tools, agent.name === 'analyst');
        evidence.push({ configuredReviewer, role: agent.name, roleText, tools });
      }
    }
    // Reuse packaging's complete physical/selected closure and bounded-delta
    // checks rather than making a second prose policy in this test.
    expect(() => assertClassicFamilyPromptParity({ templates: SYSTEM_TEMPLATES })).not.toThrow();
    expect(() => assertPaadTypedPromptParity({ templates: SYSTEM_TEMPLATES })).not.toThrow();
    const destination = process.env.SAIVAGE_TEST_COMPOSITION_EVIDENCE;
    if (destination) { mkdirSync(destination, { recursive: true }); writeFileSync(join(destination, `restart-${template.name}-closure.json`), JSON.stringify(evidence, null, 2)); }
  } finally { rmSync(root, { recursive: true }); }
});
