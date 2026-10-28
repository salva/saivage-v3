import { agentExecution } from '../../helpers/workflow-execution.js';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CardService } from '../../../src/cards/card-service.js';
import { publishTestProjectRuntime as publishInitialProjectRuntime } from '../../helpers/initial-project-fixture.js';
import { NodeExecution as AgentNodeExecution } from '../../../src/runtime/actors/node-execution.js';
import { resolveSystemTemplate } from '../../../src/config/system-templates/registry.js';
import { effectiveSaivageConfigSchema } from '../../../src/schemas/index.js';
import { compileProjectWorkflows, describeNodeResultContract } from '../../../src/runtime/card-process/card-process-config.js';
import { cardRecordHeadFile } from '../../../src/persistence/layout.js';
import { PublicationOutcomeUnknownError } from '../../../src/contracts/publication-outcome.js';
import { compilePromptTemplate, renderCompiledPrompt } from '../../../src/utils/prompt-api.js';
import { bootstrapContextSupplier } from '../../../src/runtime/records/bootstrap-context.js';
import { readConversation, appendConversationBatch } from '../../../src/persistence/conversation-file.js';
import { providerConversationProjection } from '../../../src/runtime/actors/conversation-session.js';
import { publishThreeGenerationCompactedConversation } from '../../helpers/compacted-conversation-fixture.js';

const roots: string[] = [];
afterEach(() => { jest.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
type Methods = {
  prepareRecordRequirements(node: unknown): void;
  captureRecordHead(name: string): { headId: string; revision: number } | null;
  validateRecords(node: unknown, baseline: Map<string, unknown>): { candidates?: Map<string, any>; violations?: string[] };
};
function fixture(profile: 'classic' | 'classic-typed' | 'paad-typed' = 'classic', clean = false, options: { packaged?: boolean; cardType?: 'project' | 'architecture'; nodeId?: 'plan' | 'assess-completion' } = {}) {
  const template = resolveSystemTemplate(profile); const config = effectiveSaivageConfigSchema.parse(structuredClone(template.config));
  if (!options.packaged) {
    config.card_types.project!.records['status.md']!.initialization = { format_version: 1, template: '{{cardType}}/{{cardId}}/{{cardTitle}}/{{nodeId}}/{{recordName}} ${LITERAL}' };
    config.card_types.project!.workflow.nodes.plan!.records['status.md'] = { mode: clean ? 'clean' : 'continue', gate: 'updated' };
  }
  const workflows = compileProjectWorkflows(effectiveSaivageConfigSchema.parse(config), { defaultPromptRoot: template.promptRoot });
  const root = mkdtempSync(join(tmpdir(), 'record-baseline-')); roots.push(root); publishInitialProjectRuntime(root, workflows);
  const store = new CardService(root, workflows);
  const cardId = options.cardType === 'architecture'
    ? store.create({ type: 'architecture', parent: 'project', title: 'Architecture {{nodeId}}', bootstrap_content: 'Accepted architecture scope', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] }).id
    : 'project';
  const runner = new AgentNodeExecution({ cardId, store } as never, {} as never) as unknown as Methods;
  const node = workflows.cardTypes.get(options.cardType ?? 'project')!.states.get(options.cardType === 'architecture' ? 'node:draft' : `node:${options.nodeId ?? 'plan'}`)!;
  if (node.kind !== 'node') throw new Error('Missing work node');
  const read = (name = 'status.md') => { const result = store.readRecordCurrent(cardId, name); if (result.kind !== 'found') throw new Error('missing card'); return result.value.projection; };
  return { root, store, runner, read, node, workflows, cardId };
}
describe('real node preparation and document lifecycle', () => {
  it.each((['classic', 'classic-typed', 'paad-typed'] as const).flatMap(profile => (['plan', 'assess-completion'] as const).map(node => [profile, node] as const)))('renders exact entry context once in %s %s and excludes v0 from both gates', (profile, nodeId) => {
    const f = fixture(profile, false, { nodeId }); f.runner.prepareRecordRequirements(f.node);
    expect(f.read()).toMatchObject({ state: 'baseline', revision: 1, baseline: { version: 0, content: expect.stringContaining('project/project/') }, accepted: null, draft: null });
    expect(f.read()!.baseline!.content).toContain(`/${nodeId}/status.md \${LITERAL}`);
    const baseline = new Map([['status.md', f.runner.captureRecordHead('status.md')]]);
    for (const gate of ['exists', 'updated']) expect(f.runner.validateRecords({ ...f.node, requirements: f.node.requirements.map(item => ({ ...item, gate })) }, baseline).violations).toBeDefined();
    const opened = f.store.openRecord('project', 'status.md');
    expect(opened.draft).toMatchObject({ version: 0, target_version: 1 });
    expect(() => f.store.closeRecord('project', 'status.md', 'planner')).toThrow(/document 0/);
    expect(() => f.store.acceptRecord('project', 'status.md', 'operator edit', { kind: 'agent', agent: 'analyst' })).toThrow(/open workflow draft/);
    f.store.editRecord('project', 'status.md', 'authored');
    // Returning to the same text is an ordinary authored mutation, not a fingerprint test.
    f.store.editRecord('project', 'status.md', opened.draft!.content);
    expect(f.runner.validateRecords(f.node, baseline).candidates?.size).toBe(1);
    expect(() => f.store.editRecord('project', 'status.md', ' \n')).toThrow(/must not be empty/);
    const accepted = f.store.closeRecord('project', 'status.md', 'planner');
    expect(accepted.accepted!.source_version).toBe(1); expect(accepted.revision).toBeGreaterThan(1);
  });

  it.each((['classic', 'classic-typed', 'paad-typed'] as const).flatMap(profile =>
    (['baseline', 'draft', 'accepted', 'empty'] as const).flatMap(state => (['plan', 'assess-completion'] as const).map(node => [profile, state, node] as const))))('does not render or publish in %s for existing %s at %s entry/re-entry', (profile, state, nodeId) => {
    const f = fixture(profile, false, { nodeId });
    if (state === 'accepted') f.store.acceptRecord('project', 'status.md', 'Analyst before workflow', { kind: 'agent', agent: 'analyst' });
    else f.runner.prepareRecordRequirements(f.node);
    if (state === 'draft' || state === 'empty') f.store.openRecord('project', 'status.md');
    if (state === 'draft') f.store.editRecord('project', 'status.md', 'ongoing');
    if (state === 'empty') f.store.discardRecord('project', 'status.md');
    const path = cardRecordHeadFile(f.root, 'project', { filename: 'status.md' }); const before = readFileSync(path);
    const render = jest.fn(() => { throw new Error('must not render'); });
    f.store.initializeRecord('project', 'status.md', render);
    expect(render).not.toHaveBeenCalled();
    const initialize = f.store.initializeRecord.bind(f.store);
    const renderCalls = jest.fn((render: () => string) => render());
    jest.spyOn(f.store, 'initializeRecord').mockImplementation((id, name, render) => initialize(id, name, () => renderCalls(render)));
    f.store.editCard('project', { title: 'Changed entry context {{cardId}}' }, 'analyst');
    const changed = { ...f.node, initializeRecords: f.node.initializeRecords.map(definition => ({ ...definition, initialization: {
      ...definition.initialization!, template: 'Changed {{cardTitle}}',
      compiled: compilePromptTemplate({ host: { kind: 'record-initializer', cardType: 'project' }, name: definition.name, path: 'changed-template', text: 'Changed {{cardTitle}}', resolveFragment: () => { throw new Error('No fragment'); } }),
    } })) };
    f.runner.prepareRecordRequirements(changed);
    f.runner.prepareRecordRequirements(changed);
    expect(renderCalls).not.toHaveBeenCalled(); expect(readFileSync(path)).toEqual(before);
  });

  it.each(['classic', 'classic-typed', 'paad-typed'] as const)('composes %s roles, nodes, tools, record entry/re-entry and compaction from the final compiled contracts', async profile => {
    const f = fixture(profile, false, { packaged: true }); const session = 'agent:planner:project' as const;
    const roles = [...f.workflows.cardTypes].flatMap(([cardType, workflow]) => [...workflow.states].flatMap(([stateId, node]) => {
      if (node.kind !== 'node') return [];
      const contract = describeNodeResultContract(workflow, stateId);
      const role = renderCompiledPrompt({ kind: 'workflow-agent', cardType }, agentExecution(node).agent.name, agentExecution(node).selectedAgentPrompt.compiled, { contractDescription: contract });
      expect(role.split(contract)).toHaveLength(2);
      return [{ cardType, stateId, agent: agentExecution(node).agent.name, role, contract, tools: agentExecution(node).agent.tools,
        node: workflow.processPrompts.get(agentExecution(node).prompt.promptId)!.text,
        correction: workflow.processPrompts.get(agentExecution(node).correctionPrompt.promptId)!.text,
        handoffs: [...node.on.values()].flatMap(route => 'prompt' in route.semantic && route.semantic.prompt ? [workflow.processPrompts.get(route.semantic.prompt.promptId)!.text] : []),
      }];
    }));
    expect(new Set(roles.map(item => item.agent))).toEqual(new Set(['planner', 'executor', 'reviewer']));
    expect(f.read()).toBeNull(); expect(f.read('review.md')).toBeNull();
    f.runner.prepareRecordRequirements(f.node);
    expect(f.read()).toMatchObject({ state: 'baseline', accepted: null, draft: null });
    expect(f.read('review.md')).toBeNull();
    const prepare = (node = f.node) => bootstrapContextSupplier(f.store, f.store.read('project')!, node)({ inputId: '11111111-1111-4111-8111-111111111111', conversation: readConversation(f.root, session) });
    const initial = prepare(); appendConversationBatch({ projectRoot: f.root }, initial.rows);
    expect(initial.rows.find(row => row.kind === 'record_prompt' && row.record_observations?.some(item => item.observed.selection.kind === 'baseline'))!.content)
      .toContain(JSON.stringify(f.read()!.baseline!.content));
    f.store.openRecord('project', 'status.md'); f.store.editRecord('project', 'status.md', 'Actual current assessment');
    const changed = prepare(); appendConversationBatch({ projectRoot: f.root }, changed.rows);
    const recovery = f.workflows.cardTypes.get('project')!.states.get('node:recover')!;
    if (recovery.kind !== 'node') throw new Error('Missing recovery node');
    f.runner.prepareRecordRequirements(recovery);
    const reentry = prepare(recovery);
    expect(reentry.rows.filter(row => row.kind === 'record_prompt')).toEqual([]);
    await publishThreeGenerationCompactedConversation(f.root);
    const compacted = readConversation(f.root, session);
    const latest = compacted.effectiveRequiredModelFacts.latestRecordObservations.find(item => item.observation.observed.record_name === 'status.md')!;
    expect(latest.observation.observed.selection).toMatchObject({ kind: 'draft', version: 1, target_version: 1 });
    const afterCompaction = prepare(recovery);
    expect(afterCompaction.rows.filter(row => row.kind === 'record_prompt')).toEqual([]);
    const composition = providerConversationProjection(compacted, afterCompaction.recordBlocks);
    expect(composition.messages.some(message => 'block_identity' in message && message.block_identity === 'latest-record-observations')).toBe(false);
    const evidence = process.env.SAIVAGE_TEST_COMPOSITION_EVIDENCE;
    if (evidence) { mkdirSync(evidence, { recursive: true }); writeFileSync(join(evidence, `record-v0-${profile}.json`), JSON.stringify({ kind: 'offline-final-source-compiled-composition-not-provider-wire', profile, roles, initial, changed, reentry, afterCompaction, latest, composition }, null, 2)); }
  });

  it.each([
    ['classic', 'project'], ['classic-typed', 'architecture'], ['paad-typed', 'architecture'],
  ] as const)('requires authored review and preserves accepted evidence on clean re-entry in %s %s', (profile, cardType) => {
    const f = fixture(profile, false, { packaged: true, cardType });
    const workflow = f.workflows.cardTypes.get(cardType)!;
    const first = workflow.states.get(cardType === 'project' ? 'node:review' : 'node:component-review')!;
    const next = workflow.states.get(cardType === 'project' ? 'node:review' : 'node:system-review')!;
    if (first.kind !== 'node' || next.kind !== 'node') throw new Error('Missing review node');
    expect(f.read('review.md')).toBeNull();
    f.runner.prepareRecordRequirements(f.node);
    expect(f.read('review.md')).toBeNull();
    f.runner.prepareRecordRequirements(first);
    const starter = `# Review: ${f.store.read(f.cardId)!.title}\n\nNot yet assessed against the accepted brief and this review node's criteria.\n`;
    expect(f.read('review.md')).toMatchObject({ baseline: null, accepted: null, draft: { version: 0, target_version: 1, content: starter } });
    const baseline = new Map([['review.md', f.runner.captureRecordHead('review.md')]]);
    for (const gate of ['exists', 'updated']) expect(f.runner.validateRecords({ ...first, requirements: first.requirements.map(item => ({ ...item, gate })) }, baseline).violations).toBeDefined();
    expect(() => f.store.closeRecord(f.cardId, 'review.md', 'reviewer')).toThrow(/document 0/);
    const session = `agent:reviewer:${f.cardId}` as const;
    const prepare = (node: typeof first) => bootstrapContextSupplier(f.store, f.store.read(f.cardId)!, node)({ inputId: '11111111-1111-4111-8111-111111111111', conversation: readConversation(f.root, session) });
    const initial = prepare(first); appendConversationBatch({ projectRoot: f.root }, initial.rows);
    const initialComposition = providerConversationProjection(readConversation(f.root, session), initial.recordBlocks);
    expect(initial.rows.find(row => row.kind === 'record_prompt' && row.record_observations?.some(item => item.observed.record_name === 'review.md'))!.content).toContain(JSON.stringify(starter));
    f.store.editRecord(f.cardId, 'review.md', 'Independent assessment against the accepted scope, with evidence.');
    expect(f.runner.validateRecords(first, baseline).candidates?.size).toBe(1);
    const accepted = f.store.closeRecord(f.cardId, 'review.md', 'reviewer').accepted!;
    expect(accepted).toMatchObject({ source_version: 1, author: { kind: 'agent', agent: 'reviewer' }, content: 'Independent assessment against the accepted scope, with evidence.' });
    const render = jest.fn((render: () => string) => render());
    const initialize = f.store.initializeRecord.bind(f.store);
    jest.spyOn(f.store, 'initializeRecord').mockImplementation((id, name, renderTemplate) => initialize(id, name, () => render(renderTemplate)));
    f.runner.prepareRecordRequirements(next);
    expect(render).not.toHaveBeenCalled();
    expect(f.read('review.md')).toMatchObject({ accepted, draft: { version: 2, target_version: 2, content: '' } });
    const nextBaseline = new Map([['review.md', f.runner.captureRecordHead('review.md')]]);
    expect(f.runner.validateRecords(next, nextBaseline).violations).toBeDefined();
    const reentry = prepare(next);
    f.store.editRecord(f.cardId, 'review.md', 'Unfinished next assessment');
    f.runner.prepareRecordRequirements(next);
    expect(render).not.toHaveBeenCalled();
    expect(f.read('review.md')).toMatchObject({ accepted, draft: { content: '' } });
    expect(f.runner.validateRecords(next, new Map([['review.md', f.runner.captureRecordHead('review.md')]])).violations).toBeDefined();
    const evidence = process.env.SAIVAGE_TEST_COMPOSITION_EVIDENCE;
    if (evidence) { mkdirSync(evidence, { recursive: true }); writeFileSync(join(evidence, `record-review-${profile}.json`), JSON.stringify({ kind: 'offline-final-source-compiled-composition-not-provider-wire', profile, cardType, initial, initialComposition, accepted, reentry,
      composition: providerConversationProjection(readConversation(f.root, session), reentry.recordBlocks),
      nodes: [first, next].map(node => ({ nodeId: node.nodeId,
        role: renderCompiledPrompt({ kind: 'workflow-agent', cardType }, agentExecution(node).agent.name, agentExecution(node).selectedAgentPrompt.compiled, { contractDescription: describeNodeResultContract(workflow, `node:${node.nodeId}`) }),
        node: workflow.processPrompts.get(agentExecution(node).prompt.promptId)!.text,
        handoffs: [...node.on.values()].flatMap(route => 'prompt' in route.semantic && route.semantic.prompt ? [workflow.processPrompts.get(route.semantic.prompt.promptId)!.text] : []),
      })),
    }, null, 2)); }
  });

  it('keeps explicit clean separate and captures updated stamps after preparation', () => {
    const f = fixture('classic', true); f.runner.prepareRecordRequirements(f.node);
    expect(f.read()!.draft).toMatchObject({ version: 0, target_version: 1 });
    f.store.editRecord('project', 'status.md', 'first'); f.store.closeRecord('project', 'status.md', 'planner');
    f.runner.prepareRecordRequirements(f.node);
    expect(f.read()).toMatchObject({ accepted: { source_version: 1, content: 'first' }, draft: { version: 2, target_version: 2, content: '' } });
    const baseline = new Map([['status.md', f.runner.captureRecordHead('status.md')]]);
    expect(f.runner.validateRecords(f.node, baseline).violations).toBeDefined();
    f.store.editRecord('project', 'status.md', 'second');
    expect(f.runner.validateRecords(f.node, baseline).candidates?.size).toBe(1);
    expect(f.store.closeRecord('project', 'status.md', 'planner').accepted!.source_version).toBe(2);
    expect(f.store.openRecord('project', 'notes.md').draft).toMatchObject({ version: 1, target_version: 1, content: '' });
  });

  it('stops on initializer publication uncertainty without follow-up reads/cleanup', () => {
    const f = fixture(); const unknown = new PublicationOutcomeUnknownError();
    const initializeRecord = jest.fn(() => { throw unknown; }); const read = jest.fn(); const discard = jest.fn();
    const runner = new AgentNodeExecution({ cardId: 'project', store: { initializeRecord, readRecordCurrent: read, discardRecord: discard } } as never, {} as never) as unknown as Methods;
    expect(() => runner.prepareRecordRequirements(f.node)).toThrow(unknown);
    expect(initializeRecord).toHaveBeenCalledTimes(1); expect(read).not.toHaveBeenCalled(); expect(discard).not.toHaveBeenCalled();
  });
});
