import { agentExecution } from '../helpers/workflow-execution.js';
import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { env } from 'node:process';

import { AgentExecutor as AgentNodeExecution } from '../../src/runtime/actors/agent-executor.js';
import type { AcceptedNodeResult, NodeTransition } from '../../src/runtime/actors/node-execution.js';
import { resolveSystemTemplate, type SystemTemplateDefinition } from '../../src/config/system-templates/registry.js';
import {
  compileProjectWorkflows,
  describeNodeResultContract,
  nodeResultToolDefinition,
  processNodeOutcomes,
  type CompiledCardTypeWorkflow,
  type CompiledNodeContract,
} from '../../src/runtime/card-process/card-process-config.js';
import { canonicalJson } from '../../src/schemas/index.js';
import { effectiveSaivageConfigSchema } from '../../src/schemas/saivage-config.js';
import { createPromptTemplateRegistry } from '../../src/utils/prompt-api.js';
import { composeContextProjection, providerConversationFromComposedContext } from '../../src/runtime/actors/context/composition-projector.js';
import { buildUserContextMessage } from '../../src/runtime/actors/conversation-session.js';
import type { AgentMessage, ConversationSessionId } from '../../src/schemas/index.js';
import type { ContextBlock } from '../../src/contracts/index.js';
import type { CardActivationInput } from '../../src/runtime/actors/card-activation-owner.js';
import { templateConfig } from '../helpers/system-template-config.js';
import { BoundAgentToolSet, effectiveCardNodeToolReferences, surfaceToolContracts } from '../../src/tools/runtime-tool-catalog.js';
import { surfaceToolDefinitions, EMIT_RESULT_POLICY_TEMPLATE } from '../../src/tools/invocation.js';
import { compileInvocationToolContract } from '../../src/runtime/actors/context/context-blocks.js';
import { createObservedCollections } from '../../src/retrieval/index.js';
import { unusedMcpToolInvocation } from '../helpers/llm-test-helpers.js';
import { NodeExecution } from '../../src/runtime/actors/node-execution.js';
import { ConversationLLMActor } from '../../src/runtime/actors/llm-actor.js';
import { RuntimeGate } from '../../src/runtime/runtime-gate.js';
import { bindRuntimeWorkflows } from '../../src/runtime/card-process/card-process-config.js';
import { ProviderRegistry } from '../../src/agents/provider.js';
import { ModelRouter } from '../../src/agents/model-router.js';
import { CardService } from '../../src/cards/card-service.js';
import { publishTestProjectRuntime } from '../helpers/initial-project-fixture.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';
import { createTestProcessRunner } from '../helpers/test-process-runner.js';
import { scriptedAdmissionProvider, testAutonomousCompaction } from '../helpers/llm-test-helpers.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { randomUUID } from 'node:crypto';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

type PlanningType = 'project' | 'goal';
type VisibleContext = Readonly<{ role: 'user'; content: string }>;
type ScriptedVisit = readonly [nodeId: string, outcome: string, summary?: string, pendingNotifications?: true];

const transitionRenderer = new AgentNodeExecution({} as never, {} as never) as unknown as {
  transitionContext(process: CompiledCardTypeWorkflow, transition: NodeTransition): readonly VisibleContext[];
  nodeStableBlocks(input: CardActivationInput, node: CompiledNodeContract, text: string): Readonly<{ card: ContextBlock; node: ContextBlock; parent: ContextBlock | null }>;
};

function requireNode(process: CompiledCardTypeWorkflow, nodeId: string): CompiledNodeContract {
  const node = process.states.get(`node:${nodeId}`);
  if (!node || node.kind !== 'node') throw new Error(`Missing ${process.cardType}/${nodeId}.`);
  return node;
}

function requirePrompt(process: CompiledCardTypeWorkflow, promptId: string): string {
  const prompt = process.processPrompts.get(promptId as never);
  if (!prompt) throw new Error(`Missing ${process.cardType}/${promptId} prompt.`);
  return prompt.text;
}

function accepted(node: CompiledNodeContract, outcome: string, cardId: string): AcceptedNodeResult {
  return Object.freeze({
    nodeOrdinal: 0, source: null,
    nodeId: node.nodeId,
    executor: { kind: 'agent' as const, agent: agentExecution(node).agent.name },
    values: {},
    outcome,
    event: `result:${outcome}`,
    summary: `${node.nodeId} evidence retained`,
    acceptedRecords: Object.freeze(node.requirements.map(({ definition: { name } }) =>
      ({ name, url: `record:///${name}?card=${cardId}&v=2`, version: 2 }),
    )),
  });
}

function transition(process: CompiledCardTypeWorkflow, source: string, outcome: string, target: string): string {
  const node = requireNode(process, source);
  const result = accepted(node, outcome, process.cardType === 'project' ? 'project' : 'card-a');
  const rendered = transitionRenderer.transitionContext(process, {
    context: { source: `node:${source}`, event: `result:${outcome}`, target: `node:${target}` },
    acceptedResult: result,
  } as NodeTransition);
  if (!rendered.length) throw new Error(`Missing ${process.cardType} ${source}/${outcome} transition context.`);
  return rendered.map(({content})=>content).join('');
}

function pendingNotificationTransition(process: CompiledCardTypeWorkflow): string {
  const node = requireNode(process, 'review');
  const cardId = process.cardType === 'project' ? 'project' : 'card-a';
  const result = Object.freeze({
    ...accepted(node, 'approved', cardId),
    event: 'result:approved:pending-notifications',
  });
  const rendered = transitionRenderer.transitionContext(process, {
    context: { source: 'node:review', event: result.event, target: 'node:handle-notifications' },
    acceptedResult: result,
  } as NodeTransition);
  if (!rendered.length) throw new Error(`Missing ${process.cardType} accepted-review notification transition context.`);
  return rendered.map(({content})=>content).join('');
}

function stoppedTransition(process: CompiledCardTypeWorkflow): string {
  const rendered = transitionRenderer.transitionContext(process, {
    context: { source: 'entry:STOPPED', event: 'entry:route', target: 'node:recover' },
    acceptedResult: null,
  } as NodeTransition);
  if (!rendered.length) throw new Error(`Missing ${process.cardType} STOPPED transition context.`);
  return rendered.map(({content})=>content).join('');
}

function routePrompt(process: CompiledCardTypeWorkflow, source: string, event: string): string {
  const route = process.states.get(source)?.on.get(event);
  if (!route || (route.semantic.kind !== 'entry-route' && route.semantic.kind !== 'configured-outcome' && route.semantic.kind !== 'configured-pending-notifications') || !route.semantic.prompt)
    throw new Error(`Missing prompt-bearing route ${process.cardType}/${source}/${event}.`);
  return requirePrompt(process, route.semantic.prompt.promptId);
}

function compile(template: SystemTemplateDefinition) {
  const projectRoot = mkdtempSync(join(tmpdir(), `saivage-${template.name}-planner-composition-`));
  roots.push(projectRoot);
  const selectedPaths: string[] = [];
  const workflows = compileProjectWorkflows(effectiveSaivageConfigSchema.parse(structuredClone(template.config)), {
    defaultPromptRoot: template.promptRoot,
    projectRoot,
    artifactObserver: ({ path }) => selectedPaths.push(resolve(path)),
  });
  const bundledRoot = `${resolve(template.promptRoot)}/`;
  expect(selectedPaths.length).toBeGreaterThan(0);
  expect(selectedPaths.every((path) => path.startsWith(bundledRoot))).toBe(true);
  return { workflows, registry: createPromptTemplateRegistry(workflows) };
}

function renderedNode(template: SystemTemplateDefinition, compiled: ReturnType<typeof compile>, cardType: PlanningType, nodeId: string) {
  const process = compiled.workflows.cardTypes.get(cardType);
  if (!process) throw new Error(`Missing ${template.name}/${cardType}.`);
  const node = requireNode(process, nodeId);
  const contract = describeNodeResultContract(process, `node:${nodeId}`);
  const instruction = compiled.registry.render({ kind: 'workflow-agent', cardType }, agentExecution(node).agent.name, { contractDescription: contract });
  return { process, node, contract, instruction };
}

describe('shipped project Planner semantic composition', () => {
  it.each(['classic', 'classic-typed', 'paad-typed', 'classic-git', 'newloop'].flatMap(
    profile => (['project', 'goal'] as const).map(cardType => ({ profile, cardType })),
  ))('prepares actual $profile/$cardType Planner entry and corrective continuation at a synthetic activation boundary', async ({ profile, cardType }) => {
    const template = resolveSystemTemplate(profile);
    const projectRoot = mkdtempSync(join(tmpdir(), `saivage-${profile}-${cardType}-actor-entry-`));
    roots.push(projectRoot);
    const config = effectiveSaivageConfigSchema.parse({
      ...templateConfig(template),
      models: structuredClone(TEST_SAIVAGE_CONFIG.models),
      providers: structuredClone(TEST_SAIVAGE_CONFIG.providers),
      compaction: structuredClone(TEST_SAIVAGE_CONFIG.compaction),
    });
    config.providers.test!.capabilities = {
      ...config.providers.test!.capabilities, transportProtocol: 'openai-responses', imageInput: true,
    };
    const compiled = compileProjectWorkflows(config, { projectRoot, defaultPromptRoot: template.promptRoot });
    publishTestProjectRuntime(projectRoot, compiled);
    const store = new CardService(projectRoot, compiled);
    const card = cardType === 'project' ? store.read('project')! : store.create({
      type: 'goal', parent: 'project', title: 'Delivery goal',
      bootstrap_content: 'FULL ACCEPTED BRIEF\nwith all configured content',
      created_by: 'planner', bootstrap_author: { kind: 'agent', agent: 'planner' }, depends_on: [],
    });
    const registry = new ProviderRegistry(config);
    const workflows = bindRuntimeWorkflows(compiled, new ModelRouter(registry), registry,
      config.compaction.context_utilization_fraction, { internalAnalystEnabled: true });
    const process = compiled.cardTypes.get(cardType)!;
    const prompts = createPromptTemplateRegistry(compiled);
    const processes = createTestProcessRunner(projectRoot);
    let calls = 0;
    let phaseCalls = 0;
    let phase = 'initial';
    let selectedNodeId = 'plan';
    const direction = 'Plan the bounded goal.';
    const end = new Error('bounded actor preparation fixture complete');
    const provider = scriptedAdmissionProvider(async input => {
      calls++;
      phaseCalls++;
      const selectedNode = requireNode(process, selectedNodeId);
      const contract = describeNodeResultContract(process, `node:${selectedNodeId}`);
      expect(input.systemPrompt).toBe(prompts.render({ kind: 'workflow-agent', cardType }, 'planner', { contractDescription: contract }));
      expect(input.preparedContext!.stableBlocks.map(block => block.id)).toEqual([
        `card-activation:${card.id}`, `node-activation:${card.id}:${selectedNodeId}`,
        ...(cardType === 'goal' ? [`parent-direction:${activationId}`] : []),
      ]);
      if (profile === 'classic-typed') {
        expect(selectedNodeId).toBe(phase === 'initial' ? 'plan' : 'recover');
        const refs = effectiveCardNodeToolReferences(agentExecution(selectedNode).agent.tools, selectedNode.childCreationTypes);
        expect(input.tools.map(tool => tool.function.name).sort()).toEqual([...refs.map(ref => ref.name), 'emit_result'].sort());
        expect(input.tools.find(tool => tool.function.name === 'emit_result'))
          .toEqual(nodeResultToolDefinition(process, `node:${selectedNodeId}`));
        const messages = input.providerConversation.messages;
        if (phase === 'stopped-reentry')
          expect(messages.some(message => message.content === routePrompt(process, 'entry:STOPPED', 'entry:route'))).toBe(true);
        if (cardType === 'goal') {
          const parent = input.preparedContext!.stableBlocks[2]!;
          expect(JSON.parse(parent.content.slice(parent.content.indexOf('\n') + 1))).toEqual({ instructions: direction });
          expect(messages.find(message => message.kind === 'synthetic_context' && message.block_identity === parent.id)?.content)
            .toBe(parent.content);
        }
      }
      const brief = store.readRecordCurrent(card.id, 'brief.md');
      if (brief.kind !== 'found' || !brief.value.projection?.accepted) throw new Error('Missing synthetic accepted brief');
      const bootstrap = input.providerConversation.messages.find(message =>
        message.kind === 'synthetic_context' && message.block_identity === `current-bootstrap:${card.id}`,
      );
      expect(bootstrap).toBeDefined();
      expect(JSON.parse(bootstrap!.content.slice(bootstrap!.content.indexOf('\n') + 1)).content).toBe(brief.value.projection.accepted.content);
      if (phaseCalls === 2) expect(input.providerConversation.messages.some(
        message => message.content.includes(requirePrompt(process, agentExecution(selectedNode).correctionPrompt.promptId)),
      )).toBe(true);
      const directory = env.SAIVAGE_TEST_COMPOSITION_EVIDENCE;
      if (directory) {
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, `planner-actual-${profile}-${cardType}-${phase}-turn-${phaseCalls}.json`), JSON.stringify({
          kind: 'actual NodeExecution/AgentExecutor/ConversationLLMActor provider input; synthetic activation host, no Supervisor/native commissioning',
          profile, cardType, lifetime: `${phase}/${phaseCalls === 1 ? 'entry' : 'actual plain-text corrective continuation'}`,
           input,
        }, null, 2));
      }
      if (phaseCalls === 1) return { result: { kind: 'message', content: 'plain text' }, provider_exchanges: [] };
      throw end;
    });
    const actor = new ConversationLLMActor({
      agentId: `agent:planner:${card.id}`, purpose: { kind: 'autonomous-card', cardId: card.id },
      gate: new RuntimeGate(), provider, conversations: { projectRoot },
      compactor: testAutonomousCompaction.compactor,
      summarizerProvider: testAutonomousCompaction.summarizerProvider,
      fatalPort: testApplicationFatalPort,
    });
    let activationId = randomUUID();
    const execution = new NodeExecution({
      projectRoot, cardId: card.id, store, workflows, promptTemplates: prompts,
      conversations: { projectRoot }, compactionConfig: testAutonomousCompaction.compactionConfig,
      processRunner: processes.processRunner, runtimeProcessRootScope: processes.runtimeProcessRootScope,
      mcpToolInvocation: unusedMcpToolInvocation, retrieval: createObservedCollections(projectRoot),
      parentControl: {} as never, notifyCard: () => { throw new Error('not invoked'); },
    }, {
      createLlm: () => actor, selectLlm() {}, freshInputId: randomUUID,
      assertCurrentActivation() {}, assertCurrentNode() {}, assertPromotionAvailable() {},
      promotedResult: () => null, claimResultHandoff() {}, claimedNodeInterruption: () => false,
      retainSettlementFailure(error) { throw error; },
    });
    try {
      for (const entry of ['BACKLOG', 'STOPPED'] as const) {
        phase = entry === 'BACKLOG' ? 'initial' : 'stopped-reentry';
        phaseCalls = 0;
        activationId = randomUUID();
        const target = process.states.get(`entry:${entry}`)!.on.get('entry:route')!.targetStateId;
        if (!target.startsWith('node:')) throw new Error('Expected node entry');
        selectedNodeId = target.slice('node:'.length);
        if (entry === 'STOPPED') store.acceptRecord(card.id, 'brief.md',
          `${cardType}/FULL ACCEPTED BRIEF\nwith all configured content`, { kind: 'agent', agent: 'analyst' });
        await expect(execution.execute({
        process, stateId: target, node: requireNode(process, selectedNodeId), nodeOrdinal: 0, signal: new AbortController().signal,
        transition: { context: { source: `entry:${entry}`, event: 'entry:route', target, reentered: false }, acceptedResult: null },
        input: {
          card, activationId, entry,
          caller: cardType === 'project' ? { kind: 'root' } : {
            kind: 'parent', cardId: 'project', sessionId: 'agent:planner:project',
            sourceInputId: randomUUID(), toolCallId: 'fixture-goal', toolName: 'activate_card',
             instructions: direction,
          },
          notificationDelivery: { hasPendingNotifications: () => false, selectNotifications: () => [], removeNotifications() {} },
          recordMutations: { admit() { throw new Error('not invoked'); }, mutate() { throw new Error('not invoked'); } },
          claimResult() {},
        },
      })).rejects.toThrow(end.message);
      expect(phaseCalls).toBe(2);
      }
      expect(calls).toBe(4);
    } finally {
      await processes.processRunner.terminateScopeTree({
        rootScope: processes.runtimeProcessRootScope, categories: ['runtime_card'],
        reason: 'test cleanup', graceMs: 50,
      });
    }
  });

  it.each(['classic', 'classic-typed', 'paad-typed', 'classic-git', 'newloop', 'newloop2'])(
    'captures complete static rendered %s project/goal bindings through the selected compiler and binder',
    (profile) => {
      const template = resolveSystemTemplate(profile);
      const projectRoot = mkdtempSync(join(tmpdir(), `saivage-${profile}-static-bindings-`));
      roots.push(projectRoot);
      const selectedPaths = new Set<string>();
      const config = effectiveSaivageConfigSchema.parse(templateConfig(template));
      const workflows = compileProjectWorkflows(config, {
        projectRoot, defaultPromptRoot: template.promptRoot,
        artifactObserver: ({ path }) => selectedPaths.add(resolve(path)),
      });
      const registry = createPromptTemplateRegistry(workflows);
      const bindings = (['project', 'goal'] as const).map(cardType => {
        const process = workflows.cardTypes.get(cardType)!;
        const cardId = cardType === 'project' ? 'project' : 'card-a';
        const nodes = [...process.states].flatMap(([stateId, node]) => {
          if (node.kind !== 'node' || node.execution.kind !== 'agent') return [];
          const execution = agentExecution(node);
          const refs = effectiveCardNodeToolReferences(execution.agent.tools, node.childCreationTypes);
          const surface = new BoundAgentToolSet(refs).bind({
            scope: 'card', agentName: execution.agent.name, projectRoot, cardId,
            sessionId: `agent:${execution.agent.name}:${cardId}`,
            retrieval: createObservedCollections(projectRoot),
            mcpToolInvocation: unusedMcpToolInvocation,
            processScope: {}, processOwnerId: 'offline-static-bindings',
            childCreationTypes: node.childCreationTypes,
            childActivationTypes: node.childActivationTypes,
            cardTypeVocabulary: [...workflows.cardTypes.keys()],
            nativeGit: workflows.gitPolicy !== null,
            checkpointSource: async () => { throw new Error('static binder does not execute native tools'); },
          } as never);
          const contract = describeNodeResultContract(process, stateId);
          const role = registry.render({ kind: 'workflow-agent', cardType }, execution.agent.name, { contractDescription: contract });
          const terminalTool = nodeResultToolDefinition(process, stateId);
          const tools = [...surfaceToolDefinitions(surface), terminalTool];
          expect(role.split(contract)).toHaveLength(2);
          expect(tools.at(-1)!.function.name).toBe('emit_result');
          return [{
            stateId, agent: execution.agent.name, role, contract,
            node: requirePrompt(process, execution.prompt.promptId),
            correction: requirePrompt(process, execution.correctionPrompt.promptId),
            tools, compiledToolContracts: [
              ...surfaceToolContracts(surface),
              compileInvocationToolContract(terminalTool, EMIT_RESULT_POLICY_TEMPLATE),
            ],
            outcomes: processNodeOutcomes(process, stateId),
            recordRequirements: node.requirements,
            childCreationTypes: [...node.childCreationTypes], childActivationTypes: [...node.childActivationTypes],
          }];
        });
        expect(nodes.filter(node => node.agent === 'planner').length).toBeGreaterThan(0);
        if (profile === 'classic-typed') {
          const third = cardType === 'project' ? 'assess-completion' : 'handle-notifications';
          const plannerNodes = nodes.filter(node => node.agent === 'planner');
          expect(plannerNodes.map(node => node.stateId).sort()).toEqual([`node:${third}`, 'node:plan', 'node:recover'].sort());
          for (const binding of plannerNodes) {
            const execution = agentExecution(requireNode(process, binding.stateId.slice('node:'.length)));
            expect(execution.selectedAgentPrompt).toMatchObject({
              source: 'bundled-shared', reference: 'planner',
              path: join(template.promptRoot, 'agents', '_shared', 'planner.md'),
            });
            expect(binding.recordRequirements.map(({ definition, mode, gate }) => [definition.name, mode, gate]))
              .toEqual([['status.md', 'continue', 'updated']]);
            expect(binding.tools.map(tool => tool.function.name)).toEqual(expect.arrayContaining(
              ['activate_card', 'reopen_card', 'write', 'edit', 'emit_result'],
            ));
            expect(execution.agent.tools.find(({ name }) => name === 'write')!.resources).toMatchObject([
              { kind: 'workspace' }, { kind: 'record', scopes: ['self'], patterns: [{ source: 'status.md' }] },
              { kind: 'record', scopes: ['children'], patterns: [{ source: 'brief.md' }] },
            ]);
          }
          if (cardType === 'project') {
            expect(process.states.has('node:handle-notifications')).toBe(false);
            expect(requireNode(process, 'review').on.get('result:approved')?.targetStateId).toBe('node:assess-completion');
            expect(requireNode(process, third).on.get('result:replan')?.targetStateId).toBe('node:plan');
          } else {
            expect(requireNode(process, 'review').on.get('result:approved:pending-notifications')?.targetStateId).toBe('node:handle-notifications');
            expect(requireNode(process, third).on.get('result:admit_review')?.targetStateId).toBe('node:review');
            expect(processNodeOutcomes(process, `node:${third}`)).toEqual(['admit_review', 'blocked', 'failed']);
          }
        }
        return { cardType, nodes, processPrompts: [...process.processPrompts], routes: [...process.states].map(([id, state]) => ({ id, routes: [...state.on] })) };
      });
      const evidence = env.SAIVAGE_TEST_COMPOSITION_EVIDENCE;
      if (evidence) {
        mkdirSync(evidence, { recursive: true });
        writeFileSync(join(evidence, `static-${profile}-project-goal.json`), JSON.stringify({
           kind: 'static rendered bindings', profile, selectedPaths: [...selectedPaths].sort(), bindings,
        }, null, 2));
      }
    },
  );

  // These are scripted choices, not prompt-compliance or runtime promotion tests.
  const childVerdict = 'record:///review.md?card=card-a-a&v=3';
  it.each<{
    profile: 'classic-typed' | 'newloop' | 'newloop2';
    cardType: PlanningType;
    scenario: string;
    visits: readonly ScriptedVisit[];
  }>([
    { profile: 'newloop', cardType: 'goal', scenario: 'revision loop', visits: [['plan', 'admit_review'], ['review', 'revision_required'], ['plan', 'admit_review'], ['review', 'approved']] },
    { profile: 'newloop2', cardType: 'project', scenario: 'explicit review loop', visits: [['frame-plan', 'ready'], ['alignment', 'aligned'], ['deliver', 'candidate_ready'], ['objective-assessment', 'candidate_ready'], ['integrated-acceptance', 'accepted'], ['debt-assessment', 'clear']] },
    {
      profile: 'classic-typed', cardType: 'goal', scenario: 'sufficient direct evidence despite children',
      visits: [['plan', 'complete_direct', 'The delivered child inventory and checked totals satisfy the brief. No independent verdict was required.']],
    },
    {
      profile: 'classic-typed', cardType: 'goal', scenario: 'Executor-only status leaves first independent acceptance open',
      visits: [
        ['plan', 'admit_review', 'The DONE child’s Executor verified build A (record:///status.md?card=card-a-a&v=2). The brief still requires the first independent acceptance of build A.'],
        ['review', 'approved', 'Independent acceptance of build A against the goal brief.'],
      ],
    },
    {
      profile: 'classic-typed', cardType: 'goal', scenario: 'bounded child verdict, changed combined delivery and notification re-admission',
      visits: [
        ['plan', 'admit_review', `${childVerdict} covers the unchanged parser on build A only. Build B changes the adapter; sibling interaction and the owner’s exhaustive error-path criterion remain unjudged.`],
        ['review', 'approved', 'Independent review accepted combined build B against the current brief.', true],
        ['handle-notifications', 'admit_review', `The owner reported a changed adapter input in build C. ${childVerdict} still covers only the unchanged parser; reassess the affected interaction and all required error paths.`],
        ['review', 'approved', 'Combined build C independently accepted with the reported input.'],
      ],
    },
    {
      profile: 'classic-typed', cardType: 'project', scenario: 'constituent credit before independent project review and reassessment',
      visits: [
        ['plan', 'assess_completion', `${childVerdict} covers the unchanged parser, not the assembled project.`],
        ['assess-completion', 'admit_review', `Credit ${childVerdict} for the unchanged parser only. The complete build B still needs independent judgment against the owner’s end-to-end criteria.`],
        ['review', 'approved', 'Current project review independently accepts the complete build B against the owner objective.'],
        ['assess-completion', 'complete_reviewed', 'Current project review record:///review.md?card=project&v=1 applies to complete build B; no continuing work remains.'],
      ],
    },
  ])('refreshes selected role, contract and projected node across $profile/$cardType handoffs: $scenario', ({ profile, cardType, visits }) => {
    const template = resolveSystemTemplate(profile);
    const workflows = compileProjectWorkflows(effectiveSaivageConfigSchema.parse(structuredClone(template.config)), {
      defaultPromptRoot: template.promptRoot,
    });
    const registry = createPromptTemplateRegistry(workflows);
    const process = workflows.cardTypes.get(cardType)!;
    const cardId = cardType === 'project' ? 'project' : 'card-a';
    const input = {
      activationId: '11111111-1111-4111-8111-111111111111',
      card: { id: cardId, type: cardType, title: cardType },
      caller: cardType === 'project' ? { kind: 'root' } : {
        kind: 'parent', cardId: 'project', sessionId: 'agent:planner:project',
        sourceInputId: '11111111-1111-4111-8111-111111111111',
        toolCallId: 'activate-goal', toolName: 'activate_card', instructions: '',
      },
    } as CardActivationInput;
    const histories = new Map<string, AgentMessage[]>();
    const contracts = new Map<string, string>();
    const classicTyped = profile === 'classic-typed';
    const recordVersions = new Map<string, number>();
    let previous: NodeTransition | undefined;
    if (classicTyped)
      expect(process.states.get('entry:BACKLOG')?.on.get('entry:route')?.targetStateId).toBe(`node:${visits[0]![0]}`);
    for (const [index, [nodeId, outcome, summary, pendingNotifications]] of visits.entries()) {
      const node = requireNode(process, nodeId);
      const agent = agentExecution(node).agent.name;
      const sessionId = `agent:${agent}:${cardId}` as ConversationSessionId;
      const contract = describeNodeResultContract(process, `node:${nodeId}`);
      const instruction = registry.render({ kind: 'workflow-agent', cardType }, agent, { contractDescription: contract });
      expect(agentExecution(node).selectedAgentPrompt).toMatchObject({ source: 'bundled-shared', reference: agent });
      expect(instruction.split(contract)).toHaveLength(2);
      for (const priorContract of contracts.values())
        if (priorContract !== contract) expect(instruction).not.toContain(priorContract);
      contracts.set(nodeId, contract);

      const history = histories.get(agent) ?? [];
      if (previous)
        history.push(...transitionRenderer.transitionContext(process, previous).map((message, ordinal) =>
          buildUserContextMessage(sessionId, input.activationId, 'process_transition', index * 10 + ordinal, message),
        ));
      // A role's first visit has only its received handoff, not the other role's session.
      const nodePromptId = agentExecution(node).prompt.promptId;
      const blocks = transitionRenderer.nodeStableBlocks(input, node, requirePrompt(process, nodePromptId));
      const projected = providerConversationFromComposedContext(composeContextProjection({
        sourceSessionId: sessionId, effectiveHistory: null,
        dynamicBlocks: [blocks.card, blocks.node, ...(blocks.parent ? [blocks.parent] : [])], uncoveredRows: history,
      }));
      expect(projected.messages.filter(message => message.kind === 'synthetic_context' && message.origin === 'dynamic'))
        .toEqual([
          expect.objectContaining({ block_identity: `card-activation:${cardId}`, content: blocks.card.content }),
          expect.objectContaining({ block_identity: `node-activation:${cardId}:${nodeId}`, content: blocks.node.content }),
          ...(blocks.parent ? [expect.objectContaining({ block_identity: blocks.parent.id, content: blocks.parent.content })] : []),
        ]);
      expect(projected.messages.filter(message => message.kind !== 'synthetic_context').map(message => message.content))
        .toEqual(history.map(message => message.content));
      if (previous) {
        expect(projected.messages.map(message => message.content).join('\n')).toContain(previous.acceptedResult!.acceptedRecords[0]!.url);
        expect(projected.messages.map(message => message.content).join('\n')).toContain(`Accepted outcome: ${previous.acceptedResult!.outcome}`);
      }
      if (classicTyped) {
        const nodePromptPaths: Record<string, string> = {
          plan: `${cardType === 'project' ? 'project' : '_shared'}/specialized-plan`,
          review: '_shared/specialized-review',
          'assess-completion': 'project/assess-completion',
          'handle-notifications': '_shared/handle-notifications',
        };
        const role = nodeId === 'review' ? 'reviewer' : 'planner';
        expect(agent).toBe(role);
        expect(agentExecution(node).selectedAgentPrompt.path).toBe(join(template.promptRoot, 'agents', '_shared', `${role}.md`));
        expect(process.processPrompts.get(nodePromptId)?.path).toBe(join(template.promptRoot, 'process', `${nodePromptPaths[nodeId]}.md`));
        const outcomes = processNodeOutcomes(process, `node:${nodeId}`);
        expect(nodeResultToolDefinition(process, `node:${nodeId}`).function.parameters).toMatchObject({
          properties: { outcome: { enum: outcomes } },
        });
        expect(outcomes).toContain(outcome);
        if (nodeId === 'handle-notifications') expect(outcomes).toEqual(['admit_review', 'blocked', 'failed']);
        if (cardType === 'project' && nodeId === 'plan') expect(outcomes).not.toContain('complete_direct');
        if (previous) {
          const { context } = previous;
          const { summary: incomingSummary, nodeId: source, acceptedRecords } = previous.acceptedResult!;
          const contents = projected.messages.map(message => message.content);
          expect(contents.find(content => content.startsWith(`Previous process node: ${source}\n`) &&
            content.includes(`Summary: ${incomingSummary}\n`))).toContain(`Records:\n- ${acceptedRecords[0]!.url}`);
          if (nodeId === 'review' || nodeId === 'handle-notifications') {
            const edgePrompt = nodeId === 'review' ? 'specialized-plan-to-review' : 'review-to-notifications';
            const route = process.states.get(context.source)!.on.get(context.event)!;
            if (route.semantic.kind !== 'configured-outcome' && route.semantic.kind !== 'configured-pending-notifications')
              throw new Error(`Expected configured handoff for ${context.event}`);
            const declaration = route.semantic.prompt!;
            expect(process.processPrompts.get(declaration.promptId)?.path)
              .toBe(join(template.promptRoot, 'process', '_shared', `${edgePrompt}.md`));
            expect(contents).toContain(requirePrompt(process, declaration.promptId));
          }
        }
      }
      histories.set(agent, history);
      const event = `result:${outcome}${pendingNotifications ? ':pending-notifications' : ''}`;
      const route = node.on.get(event)!;
      expect(route).toBeDefined();
      const next = visits[index + 1];
      if (next) {
        expect(route.targetStateId).toBe(`node:${next[0]}`);
        let result = accepted(node, outcome, cardId);
        if (classicTyped) {
          result = {
            ...result, nodeOrdinal: index, event, summary: summary!,
            acceptedRecords: result.acceptedRecords.map(({ name }) => {
              const version = (recordVersions.get(name) ?? 0) + 1;
              recordVersions.set(name, version);
              return { name, version, url: `record:///${name}?card=${cardId}&v=${version}` };
            }),
          };
        }
        previous = {
          context: { source: `node:${nodeId}`, event, target: route.targetStateId },
          acceptedResult: result,
        } as NodeTransition;
      } else {
        expect(route.targetStateId).toBe('terminal:DONE');
        if (classicTyped) expect(route.semantic).toMatchObject({
          kind: 'configured-outcome',
          terminalBehavior: {
            promotion: outcome === 'complete_reviewed' ? { kind: 'latest-node', nodeId: 'review' } : { kind: 'current' },
            exportRecords: [{ name: nodeId === 'review' ? 'review.md' : 'status.md' }],
          },
        });
      }
    }
    expect([...histories.keys()].sort()).toEqual(visits.length === 1 ? ['planner'] : ['planner', 'reviewer']);
  });

  it('selects each bundled shared role with one generated node contract independently', () => {
    for (const templateName of ['classic', 'classic-typed'] as const) {
      const template = resolveSystemTemplate(templateName);
      const compiled = compile(template);
      for (const role of ['planner', 'executor', 'reviewer'] as const) {
        const selected = [...compiled.workflows.cardTypes].flatMap(([cardType, process]) =>
          [...process.states.values()].flatMap((state) => state.kind === 'node' && agentExecution(state).selectedAgentPrompt.reference === role ? [{ cardType, process, state }] : []),
        ).at(0);
        if (!selected) throw new Error(`Missing ${templateName}/${role} node.`);
        const contract = describeNodeResultContract(selected.process, `node:${selected.state.nodeId}`);
        const instruction = compiled.registry.render({ kind: 'workflow-agent', cardType: selected.cardType }, agentExecution(selected.state).agent.name, { contractDescription: contract });
        expect(agentExecution(selected.state).selectedAgentPrompt).toMatchObject({ source: 'bundled-shared', reference: role });
        expect(instruction.split(contract)).toHaveLength(2);
      }
    }
  });

  it.each(['classic', 'classic-typed'] as const)('keeps one shared strategic Planner instruction for project and goal in %s', (templateName) => {
      const template = resolveSystemTemplate(templateName);
      const compiled = compile(template);
    const rendered = (['project', 'goal'] as const).map((cardType) => renderedNode(template, compiled, cardType, 'plan'));

    for (const value of rendered) {
      expect(agentExecution(value.node).selectedAgentPrompt).toMatchObject({ source: 'bundled-shared', reference: 'planner' });
      expect(value.instruction.split(value.contract)).toHaveLength(2);
    }
    expect(new Set(rendered.map(({ instruction, contract }) => instruction.replace(contract, 'GENERATED CONTRACT'))).size).toBe(1);
  });

  it.each(['classic', 'classic-typed', 'paad-typed', 'newloop'] as const)('compiles explicit project-planner plan/recover selection while preserving configured omission in %s', (templateName) => {
    const template = resolveSystemTemplate(templateName);
    const config = effectiveSaivageConfigSchema.parse(structuredClone(template.config));
    const projectPlanner = structuredClone(config.agents.planner!);
    config.agents['project-planner'] = projectPlanner;
    config.agents.planner!.capabilities.grants = config.agents.planner!.capabilities.grants.map((grant) => ({ ...grant, tools: grant.tools.filter((name) => name !== 'reopen_card') })).filter((grant) => grant.tools.length > 0);
    agentExecution(config.card_types.project!.workflow.nodes.plan!).agent = 'project-planner';
    agentExecution(config.card_types.project!.workflow.nodes.recover!).agent = 'project-planner';
    agentExecution(config.card_types.project!.workflow.nodes['assess-completion']!).agent = 'project-planner';
    config.card_types.project!.workflow.notification_recipient = 'project-planner';

    const projectRoot = mkdtempSync(join(tmpdir(), `saivage-${templateName}-named-project-planner-`));
    roots.push(projectRoot);
    const workflows = compileProjectWorkflows(config, { defaultPromptRoot: template.promptRoot, projectRoot });
    const registry = createPromptTemplateRegistry(workflows);
    const project = workflows.cardTypes.get('project')!;
    for (const nodeId of ['plan', 'recover', 'assess-completion']) {
      const node = requireNode(project, nodeId);
      expect(agentExecution(node).agent.name).toBe('project-planner');
      expect(agentExecution(node).selectedAgentPrompt).toMatchObject({ source: 'bundled-shared', reference: 'planner' });
      expect(agentExecution(node).agent.tools.map(({ name }) => name)).toContain('reopen_card');
      const contract = describeNodeResultContract(project, `node:${nodeId}`);
      const rendered = registry.render({ kind: 'workflow-agent', cardType: 'project' }, agentExecution(node).agent.name, { contractDescription: contract });
      expect(rendered.split(contract)).toHaveLength(2);
    }

    const goal = workflows.cardTypes.get('goal')!;
    for (const nodeId of ['plan', 'recover']) expect(agentExecution(requireNode(goal, nodeId)).agent.tools.map(({ name }) => name)).not.toContain('reopen_card');
  });

  it.each(['classic', 'classic-typed', 'paad-typed', 'newloop'] as const)('preserves source-derived %s project/goal process composition and transition values', (templateName) => {
    const template = resolveSystemTemplate(templateName);
    const compiled = compile(template);
    const compositions = (['project', 'goal'] as const).map((cardType) => {
      const plan = renderedNode(template, compiled, cardType, 'plan');
      const recover = renderedNode(template, compiled, cardType, 'recover');
      const review = renderedNode(template, compiled, cardType, 'review');
      return { cardType, ...plan, recover, review };
    });

    for (const composition of compositions) {
      const { cardType, process, node: plan, recover, review } = composition;
      const cardId = cardType === 'project' ? 'project' : 'card-a';
      const cardContext = canonicalJson({
        cardId,
        cardType,
        title: cardType === 'project' ? 'Complete owner objective' : 'Coordinated delivery',
      });

      expect(JSON.parse(cardContext)).toMatchObject({ cardId, cardType });
      expect([...process.permittedChildTypes]).toEqual(['goal', 'architecture', 'code', 'test', 'doc', 'data', 'research', 'ops']);
      expect([...plan.childCreationTypes]).toEqual([...process.permittedChildTypes]);
      expect([...plan.childActivationTypes]).toEqual([...process.permittedChildTypes]);
      expect(agentExecution(plan).agent.tools.map(({ name }) => name)).toEqual(template.config.agents.planner!.capabilities.grants.flatMap((grant) => grant.tools));
      expect(agentExecution(plan).agent.tools.find(({name}) => name === 'write')!.resources).toMatchObject([
        {kind:'workspace'}, {kind:'record',scopes:['self'],patterns:[{source:'status.md'}]},
        {kind:'record',scopes:['children'],patterns:[{source:'brief.md'}]},
      ]);
      const planningOutcomes = cardType === 'project' ? ['admit_review', 'blocked', 'failed', 'assess_completion'] : ['complete_direct', 'admit_review', 'blocked', 'failed'];
      expect(processNodeOutcomes(process, 'node:plan')).toEqual(planningOutcomes);
      expect(processNodeOutcomes(process, 'node:recover')).toEqual(planningOutcomes);
      expect(plan.requirements.map(({ definition, mode, gate }) => [definition.name, mode, gate])).toEqual([['status.md', 'continue', 'updated']]);

      for (const value of [composition, recover, review]) {
        const compiledPrompt = process.processPrompts.get(agentExecution(value.node).prompt.promptId)!;
        expect(compiledPrompt.text).toBe(readFileSync(compiledPrompt.path, 'utf8').replaceAll('{{cardType}}', cardType));
      }

      const stopped = stoppedTransition(process);
      expect(stopped.endsWith(routePrompt(process, 'entry:STOPPED', 'entry:route'))).toBe(true);
      const reviewAdmission = transition(process, 'plan', 'admit_review', 'review');
      expect(reviewAdmission).toContain('Previous process node: plan\nAccepted outcome: admit_review');
      expect(reviewAdmission).toContain(`record:///status.md?card=${cardId}&v=2`);
      expect(reviewAdmission.endsWith(routePrompt(process, 'node:plan', 'result:admit_review'))).toBe(true);
      const reviewRevision = transition(process, 'review', 'revision_required', 'plan');
      expect(reviewRevision).toContain('Previous process node: review\nAccepted outcome: revision_required');
      expect(reviewRevision).toContain(`record:///review.md?card=${cardId}&v=2`);
      expect(reviewRevision.endsWith(routePrompt(process, 'node:review', 'result:revision_required'))).toBe(true);
      if (cardType === 'goal') {
      const notificationHandoff = pendingNotificationTransition(process);
      expect(notificationHandoff).toContain('Previous process node: review\nAccepted outcome: approved');
      expect(notificationHandoff).toContain('Summary: review evidence retained');
      expect(notificationHandoff).toContain(`record:///review.md?card=${cardId}&v=2`);
      expect(notificationHandoff.endsWith(routePrompt(process, 'node:review', 'result:approved:pending-notifications'))).toBe(true);
      const handler = requireNode(process, 'handle-notifications');
      const handlerPrompt = process.processPrompts.get(agentExecution(handler).prompt.promptId)!;
      expect(handlerPrompt.text).toBe(readFileSync(handlerPrompt.path, 'utf8').replaceAll('{{cardType}}', cardType));
      expect(processNodeOutcomes(process, 'node:handle-notifications')).toEqual(['admit_review', 'blocked', 'failed']);
      expect(processNodeOutcomes(process, 'node:handle-notifications')).not.toContain('complete_direct');
      } else {
        const assessmentHandoff = transition(process, 'review', 'approved', 'assess-completion');
        expect(assessmentHandoff).toContain('Previous process node: review\nAccepted outcome: approved');
        expect(assessmentHandoff).toContain(`record:///review.md?card=${cardId}&v=2`);
        expect(process.states.has('node:handle-notifications')).toBe(false);
      }
      if (templateName !== 'classic')
        expect(routePrompt(process, 'node:review', 'result:revision_required')).toContain('Preserve the immutable versioned `review.md` URL');
      expect(requirePrompt(process, agentExecution(plan).correctionPrompt.promptId)).toBe(readFileSync(process.processPrompts.get(agentExecution(plan).correctionPrompt.promptId)!.path, 'utf8').replaceAll('{{cardType}}', cardType));
      const evidence = env.SAIVAGE_TEST_COMPOSITION_EVIDENCE;
      if (evidence) {
        mkdirSync(evidence, {recursive:true});
        const nodeIds = cardType === 'goal' ? ['plan','recover','review','handle-notifications'] : ['plan','recover','review','assess-completion'];
        writeFileSync(join(evidence, `planning-transitions-${templateName}-${cardType}.json`), JSON.stringify({
          kind:'offline-source-rendered-transition-context-not-provider-wire', templateName, cardType,
          nodes:nodeIds.map(nodeId => {
            const rendered = renderedNode(template,compiled,cardType,nodeId);
            return {nodeId,role:rendered.instruction,contract:rendered.contract,node:requirePrompt(process,agentExecution(rendered.node).prompt.promptId),correction:requirePrompt(process,agentExecution(rendered.node).correctionPrompt.promptId)};
          }),
          stopped, reviewAdmission, reviewRevision,
          approval:cardType === 'goal' ? pendingNotificationTransition(process) : transition(process,'review','approved','assess-completion'),
        },null,2));
      }
    }

    expect(compositions[0]!.instruction.replace(compositions[0]!.contract, 'GENERATED CONTRACT')).toBe(compositions[1]!.instruction.replace(compositions[1]!.contract, 'GENERATED CONTRACT'));
    expect(compositions[0]!.recover.instruction.replace(compositions[0]!.recover.contract, 'GENERATED CONTRACT')).toBe(compositions[1]!.recover.instruction.replace(compositions[1]!.recover.contract, 'GENERATED CONTRACT'));
  });
});
