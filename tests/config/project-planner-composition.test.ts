import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { AgentNodeExecution, type AcceptedNodeResult, type NodeTransition } from '../../src/runtime/actors/agent-node-execution.js';
import { resolveSystemTemplate, type SystemTemplateDefinition } from '../../src/config/system-templates/registry.js';
import {
  compileProjectWorkflows,
  describeNodeResultContract,
  processNodeOutcomes,
  type CompiledCardTypeWorkflow,
  type CompiledNodeContract,
} from '../../src/runtime/card-process/card-process-config.js';
import { canonicalJson } from '../../src/schemas/index.js';
import { effectiveSaivageConfigSchema } from '../../src/schemas/saivage-config.js';
import { createPromptTemplateRegistry } from '../../src/utils/prompt-api.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

type PlanningType = 'project' | 'goal';
type VisibleContext = Readonly<{ role: 'user'; content: string }>;

const transitionRenderer = new AgentNodeExecution({} as never, {} as never) as unknown as {
  transitionContext(process: CompiledCardTypeWorkflow, transition: NodeTransition): readonly VisibleContext[];
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
  const recordName = node.nodeId === 'review' ? 'review.md' : 'status.md';
  return Object.freeze({
    nodeId: node.nodeId,
    agentName: node.agent.name,
    outcome,
    event: `result:${outcome}`,
    summary: `${node.nodeId} evidence retained`,
    acceptedRecords: Object.freeze([{ name: recordName, url: `record:///${recordName}?card=${cardId}&v=2`, version: 2 }]),
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
  if (!route || (route.semantic.kind !== 'entry-route' && route.semantic.kind !== 'configured-outcome') || !route.semantic.prompt)
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
  const instruction = compiled.registry.render({ kind: 'workflow-agent', cardType }, node.agent.name, { contractDescription: contract });
  return { process, node, contract, instruction };
}

describe('shipped project Planner semantic composition', () => {
  it('selects each bundled shared role with one generated node contract and byte parity across template families', () => {
    const renderedSources = new Map<string, string>();
    for (const templateName of ['classic', 'classic-typed'] as const) {
      const template = resolveSystemTemplate(templateName);
      const compiled = compile(template);
      for (const role of ['planner', 'executor', 'reviewer'] as const) {
        const selected = [...compiled.workflows.cardTypes].flatMap(([cardType, process]) =>
          [...process.states.values()].flatMap((state) => state.kind === 'node' && state.selectedAgentPrompt.reference === role ? [{ cardType, process, state }] : []),
        ).at(0);
        if (!selected) throw new Error(`Missing ${templateName}/${role} node.`);
        const contract = describeNodeResultContract(selected.process, `node:${selected.state.nodeId}`);
        const instruction = compiled.registry.render({ kind: 'workflow-agent', cardType: selected.cardType }, selected.state.agent.name, { contractDescription: contract });
        const source = readFileSync(selected.state.selectedAgentPrompt.path, 'utf8');
        expect(selected.state.selectedAgentPrompt).toMatchObject({ source: 'bundled-shared', reference: role });
        expect(instruction.split(contract)).toHaveLength(2);
        renderedSources.set(`${templateName}:${role}`, source);
      }
    }
    for (const role of ['planner', 'executor', 'reviewer'] as const)
      expect(renderedSources.get(`classic:${role}`)).toBe(renderedSources.get(`classic-typed:${role}`));
  });

  it('keeps one shared strategic Planner instruction for project and goal', () => {
    const rendered = (['classic', 'classic-typed'] as const).flatMap((templateName) => {
      const template = resolveSystemTemplate(templateName);
      const compiled = compile(template);
      return (['project', 'goal'] as const).map((cardType) => renderedNode(template, compiled, cardType, 'plan'));
    });

    for (const value of rendered) {
      expect(value.node.selectedAgentPrompt).toMatchObject({ source: 'bundled-shared', reference: 'planner' });
      expect(value.instruction.split(value.contract)).toHaveLength(2);
    }
    expect(new Set(rendered.map(({ instruction }) => instruction)).size).toBe(1);
  });

  it.each(['classic', 'classic-typed'] as const)('compiles explicit project-planner plan/recover selection while preserving configured omission in %s', (templateName) => {
    const template = resolveSystemTemplate(templateName);
    const config = effectiveSaivageConfigSchema.parse(structuredClone(template.config));
    const projectPlanner = structuredClone(config.agents.planner!);
    config.agents['project-planner'] = projectPlanner;
    config.agents.planner!.tools = config.agents.planner!.tools.filter((name) => name !== 'reopen_card');
    config.card_types.project!.workflow.nodes.plan!.agent = 'project-planner';
    config.card_types.project!.workflow.nodes.recover!.agent = 'project-planner';
    config.card_types.project!.workflow.nodes['handle-notifications']!.agent = 'project-planner';
    config.card_types.project!.workflow.notification_recipient = 'project-planner';

    const projectRoot = mkdtempSync(join(tmpdir(), `saivage-${templateName}-named-project-planner-`));
    roots.push(projectRoot);
    const workflows = compileProjectWorkflows(config, { defaultPromptRoot: template.promptRoot, projectRoot });
    const registry = createPromptTemplateRegistry(workflows);
    const project = workflows.cardTypes.get('project')!;
    for (const nodeId of ['plan', 'recover', 'handle-notifications']) {
      const node = requireNode(project, nodeId);
      expect(node.agent.name).toBe('project-planner');
      expect(node.selectedAgentPrompt).toMatchObject({ source: 'bundled-shared', reference: 'planner' });
      expect(node.agent.tools.map(({ name }) => name)).toContain('reopen_card');
      const rendered = registry.render({ kind: 'workflow-agent', cardType: 'project' }, node.agent.name, { contractDescription: describeNodeResultContract(project, `node:${nodeId}`) });
      expect(rendered).toContain('Use `reopen_card` only for a done or failed direct child');
    }

    const goal = workflows.cardTypes.get('goal')!;
    for (const nodeId of ['plan', 'recover']) expect(requireNode(goal, nodeId).agent.tools.map(({ name }) => name)).not.toContain('reopen_card');
  });

  it.each(['classic', 'classic-typed'] as const)('preserves source-derived %s project/goal process composition and transition values', (templateName) => {
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
        brief: cardType === 'project' ? 'Deliver the complete objective against stable acceptance.' : 'Own this delegated outcome and its acceptance.',
      });

      expect(JSON.parse(cardContext)).toMatchObject({ cardId, cardType });
      expect([...process.permittedChildTypes]).toEqual(['goal', 'architecture', 'code', 'test', 'doc', 'data', 'research', 'ops']);
      expect([...plan.childCreationTypes]).toEqual([...process.permittedChildTypes]);
      expect([...plan.childActivationTypes]).toEqual([...process.permittedChildTypes]);
      expect(plan.agent.tools.map(({ name }) => name)).toEqual(template.config.agents.planner!.tools);
      expect(plan.agent.recordWrites.map(({ source }) => source)).toEqual(['brief.md', 'status.md']);
      expect(processNodeOutcomes(process, 'node:plan')).toEqual(['complete_direct', 'admit_review', 'blocked', 'failed']);
      expect(processNodeOutcomes(process, 'node:recover')).toEqual(['complete_direct', 'admit_review', 'blocked', 'failed']);
      expect(plan.requirements.map(({ definition, mode, gate }) => [definition.name, mode, gate])).toEqual([['status.md', 'continue', 'updated']]);

      for (const value of [composition, recover, review]) {
        const compiledPrompt = process.processPrompts.get(value.node.prompt.promptId)!;
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
      if (templateName === 'classic-typed') {
        expect(requirePrompt(process, plan.prompt.promptId)).toContain('call `reopen_card({card_id:"<id>"})`');
        expect(requirePrompt(process, recover.node.prompt.promptId)).toContain('call `reopen_card({card_id:"<id>"})`');
        expect(routePrompt(process, 'node:review', 'result:revision_required')).toContain('Preserve the immutable versioned `review.md` URL');
      }
      expect(requirePrompt(process, plan.correctionPrompt.promptId)).toBe(readFileSync(process.processPrompts.get(plan.correctionPrompt.promptId)!.path, 'utf8').replaceAll('{{cardType}}', cardType));
    }

    expect(compositions[0]!.instruction).toBe(compositions[1]!.instruction);
    expect(compositions[0]!.recover.instruction).toBe(compositions[1]!.recover.instruction);
  });
});
