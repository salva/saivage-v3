import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CardService } from '../../../src/cards/card-service.js';
import { publishInitialProjectRuntime } from '../../../src/boot/index.js';
import { AgentNodeExecution } from '../../../src/runtime/actors/agent-node-execution.js';
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
function fixture(profile: 'classic' | 'classic-typed' | 'paad-typed' = 'classic', clean = false) {
  const template = resolveSystemTemplate(profile); const config = effectiveSaivageConfigSchema.parse(structuredClone(template.config));
  config.card_types.project!.records['status.md']!.initialization = { format_version: 1, template: '{{cardType}}/{{cardId}}/{{cardTitle}}/{{nodeId}}/{{recordName}} ${LITERAL}' };
  config.card_types.project!.workflow.nodes.plan!.records['status.md'] = { mode: clean ? 'clean' : 'continue', gate: 'updated' };
  const workflows = compileProjectWorkflows(effectiveSaivageConfigSchema.parse(config), { defaultPromptRoot: template.promptRoot });
  const root = mkdtempSync(join(tmpdir(), 'record-baseline-')); roots.push(root); publishInitialProjectRuntime(root, workflows);
  const store = new CardService(root, workflows);
  const runner = new AgentNodeExecution({ cardId: 'project', store } as never, {} as never) as unknown as Methods;
  const node = workflows.cardTypes.get('project')!.states.get('node:plan')!;
  if (node.kind !== 'node') throw new Error('Missing plan node');
  const read = () => { const result = store.readRecordCurrent('project', 'status.md'); if (result.kind !== 'found') throw new Error('missing card'); return result.value.projection; };
  return { root, store, runner, read, node, workflows };
}
describe('real node preparation and document lifecycle', () => {
  it.each(['classic', 'classic-typed', 'paad-typed'] as const)('renders exact entry context once in %s and excludes v0 from both gates', profile => {
    const f = fixture(profile); f.runner.prepareRecordRequirements(f.node);
    expect(f.read()).toMatchObject({ state: 'baseline', revision: 1, baseline: { version: 0, content: expect.stringContaining('project/project/') }, accepted: null, draft: null });
    expect(f.read()!.baseline!.content).toContain('/plan/status.md ${LITERAL}');
    const baseline = new Map([['status.md', f.runner.captureRecordHead('status.md')]]);
    for (const gate of ['exists', 'updated']) expect(f.runner.validateRecords({ ...f.node, requirements: f.node.requirements.map(item => ({ ...item, gate })) }, baseline).violations).toBeDefined();
    const opened = f.store.openRecord('project', 'status.md');
    expect(opened.draft).toMatchObject({ version: 0, target_version: 1 });
    expect(() => f.store.closeRecord('project', 'status.md', 'planner')).toThrow(/document 0/);
    expect(() => f.store.acceptRecord('project', 'status.md', 'operator edit', 'analyst')).toThrow(/open workflow draft/);
    f.store.editRecord('project', 'status.md', 'authored');
    // Returning to the same text is an ordinary authored mutation, not a fingerprint test.
    f.store.editRecord('project', 'status.md', opened.draft!.content);
    expect(f.runner.validateRecords(f.node, baseline).candidates?.size).toBe(1);
    expect(() => f.store.editRecord('project', 'status.md', ' \n')).toThrow(/must not be empty/);
    const accepted = f.store.closeRecord('project', 'status.md', 'planner');
    expect(accepted.accepted!.source_version).toBe(1); expect(accepted.revision).toBeGreaterThan(1);
  });

  it.each((['classic', 'classic-typed', 'paad-typed'] as const).flatMap(profile =>
    (['baseline', 'draft', 'accepted', 'empty'] as const).map(state => [profile, state] as const)))('does not render or publish in %s for existing %s on entry/re-entry', (profile, state) => {
    const f = fixture(profile);
    if (state === 'accepted') f.store.acceptRecord('project', 'status.md', 'Analyst before workflow', 'analyst');
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
    const f = fixture(profile); const session = 'agent:planner:project' as const;
    const roles = [...f.workflows.cardTypes].flatMap(([cardType, workflow]) => [...workflow.states].flatMap(([stateId, node]) => {
      if (node.kind !== 'node') return [];
      const contract = describeNodeResultContract(workflow, stateId);
      const role = renderCompiledPrompt({ kind: 'workflow-agent', cardType }, node.agent.name, node.selectedAgentPrompt.compiled, { contractDescription: contract });
      expect(role.split(contract)).toHaveLength(2);
      return [{ cardType, stateId, agent: node.agent.name, role, contract, tools: node.agent.tools,
        node: workflow.processPrompts.get(node.prompt.promptId)!.text,
        correction: workflow.processPrompts.get(node.correctionPrompt.promptId)!.text,
        handoffs: [...node.on.values()].flatMap(route => 'prompt' in route.semantic && route.semantic.prompt ? [workflow.processPrompts.get(route.semantic.prompt.promptId)!.text] : []),
      }];
    }));
    expect(new Set(roles.map(item => item.agent))).toEqual(new Set(['planner', 'executor', 'reviewer']));
    f.runner.prepareRecordRequirements(f.node);
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
    const facts = composition.messages.find(message => 'block_identity' in message && message.block_identity === 'latest-record-observations')!;
    expect(facts.content).toContain('"target_version":1');
    expect(facts.content).not.toContain('Actual current assessment');
    const evidence = process.env.SAIVAGE_TEST_COMPOSITION_EVIDENCE;
    if (evidence) { mkdirSync(evidence, { recursive: true }); writeFileSync(join(evidence, `record-v0-${profile}.json`), JSON.stringify({ kind: 'offline-final-source-compiled-composition-not-provider-wire', profile, roles, initial, changed, reentry, afterCompaction, latest, composition }, null, 2)); }
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
