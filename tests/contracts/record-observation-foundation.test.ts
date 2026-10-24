import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { appendConversationBatch, readConversation, readHistoricalConversationSegment,
  publishCompactedConversationSegment } from '../../src/persistence/conversation-file.js';
import { versionFilename } from '../../src/persistence/canonical-conversation-artifacts.js';
import { CardService, initProjectTree } from '../helpers/canonical-project.js';
import { readProject, writeProject } from '../../src/tools/project-file-tools.js';
import { workspaceToolBinders } from '../../src/tools/workspace-provider.js';
import { toolSucceeded } from '../../src/contracts/tool-result.js';
import { buildSettledToolResult } from '../../src/runtime/actors/llm-delivery-log.js';
import { executedToolOutcome, OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE } from '../../src/tools/invocation.js';
import { agentMessageSchema, canonicalJson, sha256Hex, cardAgentSessionId,
  STRUCTURAL_ROW_POLICY, DURABLE_PRIMARY_CONTENT_POLICY, compactedHistorySchema,
  type AgentMessage } from '../../src/schemas/index.js';
import { recordObservationSchema, sameRecordSelection, type RecordSelectionObservation } from '../../src/schemas/record-observation.js';
import { deriveRequiredModelFacts, selectConversationProtection, validateConversation,
  validateCompactedHistorySuccessor } from '../../src/contracts/conversation-validation.js';
import { conversationSegmentEnvelopeSchema, conversationVersionIndexSchema } from '../../src/persistence/canonical-conversation-artifacts.js';
import { segmentContext, foldHistoricalConversationRows } from '../../src/application/read-models/agent-conversation-read-model.js';
import { prepareRecordPromptContent } from '../../src/runtime/records/record-prompt-content.js';
import { providerConversationProjection } from '../../src/runtime/actors/conversation-session.js';
import { openAIChatAdapter } from '../../src/agents/llm-openai-chat-adapter.js';
import { projectCanonicalConversationRow } from '../../src/application/read-models/canonical-conversation-outbound.js';
import { projectToolInvocation } from '../../src/tools/tool-invocation-outbound.js';

const INPUT = '11111111-1111-4111-8111-111111111111';
const SESSION = cardAgentSessionId('planner', 'project');
const TS = '2026-10-13T00:00:00.000Z';
const roots: string[] = [];
afterEach(() => { jest.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function project() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'record-observation-foundation-'));
  roots.push(projectRoot); initProjectTree(projectRoot);
  const store = new CardService(projectRoot);
  return { projectRoot, store, agentName: 'planner' as const, cardId: 'project' };
}
function policy() {
  const resultPolicyTemplate = OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE;
  const resultPolicyTemplateBytes = canonicalJson(resultPolicyTemplate);
  return { resultPolicyTemplate, resultPolicyTemplateBytes, resultPolicyTemplateSha256: sha256Hex(resultPolicyTemplateBytes) };
}
function selection(version: number, exposure: RecordSelectionObservation['exposure'] = { kind: 'metadata' }): RecordSelectionObservation {
  return { card_id: 'project', record_name: 'brief.md', view: 'accepted', selection_kind: 'current',
    head: { head_id: INPUT, revision: version }, selection: { kind: 'accepted', entry_id: version === 1 ? INPUT : '22222222-2222-4222-8222-222222222222',
      version, locator: `record:///brief.md?card=project&v=${version}`, content_sha256: 'a'.repeat(64) }, exposure };
}
function prompt(id: string, observed: RecordSelectionObservation, key?: string): AgentMessage {
  return agentMessageSchema.parse({ id, session_id: SESSION, role: 'user', kind: 'record_prompt', content: `Actual ${id} rendered bytes`,
    instruction_origin: 'workflow_prompt', record_prompt: { reference: 'changed-record', node_id: 'plan', reason: 'changed' },
    record_observations: [{ observed, source: { kind: 'prompt', input_id: INPUT, node_id: 'plan', reference: 'changed-record' } }],
    context_policy: { ...DURABLE_PRIMARY_CONTENT_POLICY, compactable: false, ...(key ? { compaction_key: key } : {}) },
    round_id: `r-user-${'1'.repeat(32)}`, message_index: 1, block_index: 0, timestamp: TS });
}

describe('owning record observations', () => {
  it('retains actual stdout-author reads and old opaque writer facts through conversation12 history, public/provider projection and compaction', async () => {
    const ctx = project();
    const content = 'Factual captured output\napi_key: nested-private-canary';
    const author = { kind: 'action-output' as const, operation: 'shell.run', contract_version: 1 as const,
      provider: { kind: 'builtin' as const, name: 'shell' },
      activation_id: INPUT, invocation_id: randomUUID(), node_id: 'check', ordinal: 0,
      process_id: 'proc-123456789abc', outcome: 'failed',
      output: { source: 'command-stdout' as const, size_bytes: Buffer.byteLength(content), sha256: sha256Hex(content) },
      leader_exit: { exit_code: 9, signal: null } };
    ctx.store.acceptRecord('project', 'status.md', content, author);
    // Publication is a record operation, not a synthetic conversation mutation.
    expect(readConversation(ctx.projectRoot, SESSION).physicalRows).toEqual([]);
    const binder = workspaceToolBinders.find(t => t.name === 'read')!.bind(ctx);
    const rows: AgentMessage[] = [];
    const add = (id: string, args: object, execution: Parameters<typeof buildSettledToolResult>[0]['settlement'] & { kind: 'executed' }) => {
      const p = policy();
      const call = agentMessageSchema.parse({ id: `${INPUT}:tool-call:${id}`, session_id: SESSION, role: 'assistant', kind: 'tool_call', tool: 'read', tool_call_id: id,
        content: JSON.stringify({ role: 'assistant', tool_calls: [{ id, type: 'function', function: { name: 'read', arguments: JSON.stringify(args) } }] }),
        context_policy: { kind: 'tool_call', template: p.resultPolicyTemplate, template_bytes: p.resultPolicyTemplateBytes, template_sha256: p.resultPolicyTemplateSha256 },
        round_id: `r-assistant-${INPUT.replaceAll('-', '')}`, message_index: rows.length, block_index: 0, timestamp: TS });
      const result = buildSettledToolResult({ session_id: SESSION, source_input_id: INPUT, tool_call_id: id, tool_name: 'read', resultPolicy: p, settlement: execution }).message;
      rows.push(call, result);
      return result;
    };
    const oldData = { writer_agent: 'executor', content: 'Retained former opaque read observation' };
    const old = add('old-opaque', {}, { kind: 'executed', execution: executedToolOutcome('observational_query', toolSucceeded(oldData)) });
    for (const [id, path, metadata_only] of [
      ['current-text', 'record:///status.md?card=project', false],
      ['current-metadata', 'record:///status.md?card=project', true],
      ['historical-text', 'record:///status.md?card=project&v=1', false],
      ['historical-metadata', 'record:///status.md?card=project&v=1', true],
    ] as const) {
      const args = { path, metadata_only };
      const row = add(id, args, { kind: 'executed', execution: await binder.executor(args, new AbortController().signal) });
      expect(JSON.parse(row.content).data.content_author).toEqual(author);
      expect(row.content).not.toContain('nested-private-canary');
      expect(row.record_observations![0]!.observed).toMatchObject({ selection_kind: id.startsWith('historical') ? 'historical' : 'current', selection: { kind: 'accepted', version: 1 } });
      expect(row.record_observations![0]!.observed).not.toHaveProperty('author');
    }
    appendConversationBatch({ projectRoot: ctx.projectRoot }, rows);
    const source = readConversation(ctx.projectRoot, SESSION);
    expect(source.physicalRows).toEqual(rows);
    expect(readHistoricalConversationSegment(ctx.projectRoot, SESSION, 1).genesis.format_version).toBe(12);
    const request = openAIChatAdapter.buildRequestBody({ candidate: { provider: 'openai', account: null, model: 'gpt-5.6' }, systemPrompt: 'Record facts.',
      providerConversation: providerConversationProjection(source, []),
      options: { providerSessionId: 'record-proof', inputId: INPUT, temperature: 0, max_tokens: 512, contract_id: 'record-proof', contractName: 'record-proof', terminalToolOffered: [], tools: [], tool_choice: 'auto' },
      capabilities: { transportProtocol: 'openai-chat-completions', imageInput: false, toolsMode: 'native', exclusiveToolChoiceSupport: 'native', quirks: [] } });
    for (const row of rows.filter(row => row.kind === 'tool_result')) {
      expect(request.messages).toContainEqual(expect.objectContaining({ role: 'tool', tool_call_id: row.tool_call_id, content: row.content }));
      const publicRow = projectCanonicalConversationRow(row, projectToolInvocation);
      expect(JSON.parse(publicRow.content).data).toEqual(JSON.parse(row.content).data);
    }
    expect(JSON.parse(old.content).data).toEqual(oldData);
    const facts = deriveRequiredModelFacts({ inherited: { latestRecovery: null, latestContentPolicyRefusal: null, latestRecordObservations: [] }, coveredRows: rows, source });
    const history = compactedHistorySchema.parse({ summaryText: 'Captured output is not an agent verdict.', protectedPrompts: [], requiredModelFacts: facts });
    const entryId = randomUUID();
    publishCompactedConversationSegment({ projectRoot: ctx.projectRoot }, SESSION, { identity: { genesisId: randomUUID(), entryId, segmentVersion: 2, timestamp: TS, filename: versionFilename(2, entryId) }, history, cutoffSourceIndex: rows.length - 1, cutoffMessageId: rows.at(-1)!.id, continuation: { kind: 'between_rounds' } });
    const compacted = readConversation(ctx.projectRoot, SESSION);
    expect(compacted.effectiveRequiredModelFacts.latestRecordObservations).toEqual(facts.latestRecordObservations);
    const retained = readHistoricalConversationSegment(ctx.projectRoot, SESSION, 1);
    expect(retained.rows).toEqual(rows);
    expect(JSON.parse(foldHistoricalConversationRows(retained.rows)[1]!.content).data).toEqual(oldData);
    const genesis = readHistoricalConversationSegment(ctx.projectRoot, SESSION, 2).genesis;
    expect(genesis.format_version).toBe(12);
    expect(segmentContext(genesis)!.required_model_facts.latestRecordObservations).toHaveLength(facts.latestRecordObservations.length);
    expect(() => providerConversationProjection(compacted, [])).not.toThrow();
  });
  it('keeps real current stamps but null historical tool stamps after many mutations before accepted1 and accepted2', async () => {
    const ctx = project();
    ctx.store.initializeRecord('project', 'status.md', () => 'template');
    ctx.store.openRecord('project', 'status.md');
    for (const body of ['first edit', 'second edit', 'accepted first']) ctx.store.editRecord('project', 'status.md', body);
    const first = ctx.store.closeRecord('project', 'status.md', 'planner');
    expect(first.accepted!.source_version).toBe(1); expect(first.revision).toBeGreaterThan(1);
    ctx.store.openRecord('project', 'status.md'); ctx.store.editRecord('project', 'status.md', 'accepted second');
    const second = ctx.store.closeRecord('project', 'status.md', 'planner');
    expect(second.accepted!.source_version).toBe(2);
    const current = await readProject(ctx, { path: 'record:///status.md?card=project', metadata_only: true });
    expect(current.data).toMatchObject({ revision: second.revision, head_id: second.headId });
    for (const options of [{}, { metadata_only: true }, { response_bytes: 900 }]) {
      const historical = await readProject(ctx, { path: 'record:///status.md?card=project&v=1', ...options });
      expect(historical.data).toMatchObject({ version: 1, revision: null, head_id: null });
      expect(historical.record_observations).toEqual([expect.objectContaining({ selection_kind: 'historical', head: null, selection: expect.objectContaining({ kind: 'accepted', version: 1, entry_id: first.accepted!.source_entry_id }) })]);
    }
    expect(ctx.store.diffRecordVersions('project', 'status.md', { from: 1, to: 2 })).toMatchObject({ kind: 'found', value: { from: { revision: null, headId: null }, to: { revision: null, headId: null }, target: { kind: 'version', version: 2 } } });
    expect(ctx.store.diffRecordVersions('project', 'status.md', { from: 1, to: 'current' })).toMatchObject({ kind: 'found', value: { target: { kind: 'current', revision: second.revision, head_id: second.headId } } });
  });
  it('carries baseline0 and draft0/target1 through real reads, nested results and compacted latest facts at conversation12', async () => {
    const ctx = project(); ctx.store.initializeRecord('project', 'status.md', () => 'Non-authored starter');
    const binder = workspaceToolBinders.find(t => t.name === 'read')!.bind(ctx);
    const execution = await binder.executor({ path: 'record:///status.md?card=project' }, new AbortController().signal);
    const nested = buildSettledToolResult({ session_id: SESSION, source_input_id: INPUT, tool_call_id: 'baseline-read', tool_name: 'read', resultPolicy: policy(), settlement: { kind: 'executed', execution } });
    expect(nested.message.record_observations![0]!.observed.selection).toMatchObject({ kind: 'baseline', version: 0 });
    expect(() => conversationSegmentEnvelopeSchema.parse({ version: 11, type: 'conversation-segment', rows: [nested.message] })).toThrow();
    expect(conversationSegmentEnvelopeSchema.parse({ version: 12, type: 'conversation-segment', rows: [nested.message] }).version).toBe(12);
    ctx.store.openRecord('project', 'status.md');
    const read = await readProject(ctx, { path: 'record:///status.md?card=project', metadata_only: true });
    const observed = read.record_observations[0]!;
    expect(observed.selection).toMatchObject({ kind: 'draft', version: 0, target_version: 1, accepted_backing: null });
    const row = prompt('draft-zero', observed); row.context_policy = { ...DURABLE_PRIMARY_CONTENT_POLICY, compactable: true };
    appendConversationBatch({ projectRoot: ctx.projectRoot }, [row]);
    const source = readConversation(ctx.projectRoot, SESSION);
    const facts = deriveRequiredModelFacts({ inherited: { latestRecovery: null, latestContentPolicyRefusal: null, latestRecordObservations: [] }, coveredRows: [row], source });
    const history = compactedHistorySchema.parse({ summaryText: 'Template is not authored work', protectedPrompts: [], requiredModelFacts: facts });
    const entryId = randomUUID();
    publishCompactedConversationSegment({ projectRoot: ctx.projectRoot }, SESSION, { identity: { genesisId: randomUUID(), entryId, segmentVersion: 2, timestamp: TS, filename: versionFilename(2, entryId) }, history, cutoffSourceIndex: 0, cutoffMessageId: row.id, continuation: { kind: 'between_rounds' } });
    expect(readConversation(ctx.projectRoot, SESSION).effectiveRequiredModelFacts.latestRecordObservations[0]!.observation.observed.selection).toEqual(observed.selection);
    const genesis = readHistoricalConversationSegment(ctx.projectRoot, SESSION, 2).genesis;
    expect(conversationSegmentEnvelopeSchema.parse({ version: 12, type: 'conversation-segment', rows: [genesis] }).version).toBe(12);
    expect(() => conversationSegmentEnvelopeSchema.parse({ version: 12, type: 'conversation-segment', rows: [{ ...genesis, format_version: 11 }] })).toThrow();
    if (genesis.kind !== 'compacted_segment_genesis') throw new Error('Missing compacted genesis');
    const oldGenesis = { ...genesis, compaction: { ...genesis.compaction, requiredModelFacts: { ...genesis.compaction.requiredModelFacts,
      latestRecordObservations: genesis.compaction.requiredModelFacts.latestRecordObservations.map(item => ({ ...item, observation: { ...item.observation, observed: { ...item.observation.observed, selection: { ...item.observation.observed.selection, unfilled: true } } } })),
    } } };
    expect(() => conversationSegmentEnvelopeSchema.parse({ version: 12, type: 'conversation-segment', rows: [oldGenesis] })).toThrow();
    const old = { ...row, record_observations: row.record_observations!.map(item => ({ ...item, observed: { ...item.observed, selection: { ...item.observed.selection, unfilled: true } } })) };
    expect(() => conversationSegmentEnvelopeSchema.parse({ version: 12, type: 'conversation-segment', rows: [old] })).toThrow();
  });
  it('admits excerpt only for a selected body, independently of source identity', () => {
    const source = { kind: 'prompt', input_id: INPUT, node_id: 'plan', reference: 'changed-record' };
    const observed = selection(1, { kind: 'excerpt' });
    expect(recordObservationSchema.parse({ observed, source }).observed).toEqual(observed);
    expect(sameRecordSelection(observed, selection(1, { kind: 'full_body' }))).toBe(true);
    for (const kind of ['absent', 'empty'] as const) {
      expect(() => recordObservationSchema.parse({ observed: {
        ...observed, head: kind === 'absent' ? null : observed.head, selection: { kind },
      }, source })).toThrow(/No selected body/);
    }
  });

  it('uses one current owning read for metadata/slice/full and separately exposes accepted backing of a draft', async () => {
    const ctx = project();
    ctx.store.acceptRecord('project', 'brief.md', 'A accepted body', { kind: 'agent', agent: 'analyst' });
    const read = jest.spyOn(ctx.store, 'readRecordCurrent');
    const metadata = await readProject(ctx, { path: 'record:///brief.md?card=project', metadata_only: true });
    expect(read).toHaveBeenCalledTimes(1);
    expect(metadata.record_observations.map(o => o.exposure.kind)).toEqual(['metadata', 'metadata']);
    const accepted = metadata.record_observations[1]!.selection;
    ctx.store.openRecord('project', 'brief.md');
    ctx.store.editRecord('project', 'brief.md', 'D'.repeat(4000));
    read.mockClear();
    const sliced = await readProject(ctx, { path: 'record:///brief.md?card=project', response_bytes: 700 });
    expect(read).toHaveBeenCalledTimes(1);
    expect(sliced.record_observations[0]).toMatchObject({ selection: { kind: 'draft', accepted_backing: accepted }, exposure: { kind: 'slice', offset_bytes: 0 } });
    expect(sliced.record_observations[1]).toMatchObject({ view: 'accepted', selection: accepted, exposure: { kind: 'metadata' } });
    const full = await readProject(ctx, { path: 'record:///brief.md?card=project' });
    expect(full.record_observations[0]!.exposure.kind).toBe('full_body');
    const historical = await readProject(ctx, { path: 'record:///brief.md?card=project&v=1' });
    expect(historical.data).toMatchObject({ version: 1, revision: null, head_id: null });
    expect(historical.record_observations).toHaveLength(1);
    expect(historical.record_observations[0]).toMatchObject({ selection_kind: 'historical', head: null, selection: { kind: 'accepted', version: 1 } });
    for (const options of [{ metadata_only: true }, { response_bytes: 700 }]) {
      const read = await readProject(ctx, { path: 'record:///brief.md?card=project&v=1', ...options });
      expect(read.data).toMatchObject({ version: 1, revision: null, head_id: null });
    }
  });

  it('carries read metadata atomically on its exact settled result; fake returned JSON cannot produce it', async () => {
    const ctx = project();
    const binder = workspaceToolBinders.find(t => t.name === 'read')!.bind(ctx);
    const execution = await binder.executor({ path: 'record:///brief.md?card=project', metadata_only: true }, new AbortController().signal);
    const result = buildSettledToolResult({ session_id: SESSION, source_input_id: INPUT, tool_call_id: 'call-read', tool_name: 'read',
      resultPolicy: policy(), settlement: { kind: 'executed', execution } });
    expect(result.message.record_observations).toHaveLength(2);
    expect(result.message.record_observations![0]!.source).toEqual({ kind: 'read', input_id: INPUT, tool_call_id: 'call-read', tool_name: 'read' });
    expect(JSON.parse(result.message.content).data).not.toHaveProperty('record_observations');
    const fake = buildSettledToolResult({ session_id: SESSION, source_input_id: INPUT, tool_call_id: 'fake', tool_name: 'read',
      resultPolicy: policy(), settlement: { kind: 'executed', execution: executedToolOutcome('observational_query', toolSucceeded({ record_observations: result.message.record_observations })) } });
    expect(fake.message.record_observations).toBeUndefined();
    expect(() => agentMessageSchema.parse({ ...result.message, record_observations: result.message.record_observations!.map(o => ({ ...o, source: { ...o.source, tool_call_id: 'other' } })) })).toThrow();
  });

  it('projects known mutation output without any follow-up read and keeps failed tools unobserved', async () => {
    const ctx = project();
    const read = jest.spyOn(ctx.store, 'readRecordCurrent');
    const result = await writeProject(ctx, { path: 'record:///status.md?card=project', content: 'Draft status' });
    expect(result.kind).toBe('applied');
    expect(read).not.toHaveBeenCalled();
    if (result.kind !== 'applied' || !('record_observations' in result)) throw new Error('Expected known record mutation.');
    expect(result.record_observations).toEqual(expect.arrayContaining([expect.objectContaining({ view: 'effective', selection: expect.objectContaining({ kind: 'draft' }), exposure: { kind: 'metadata' } })]));
    const readTool = workspaceToolBinders.find(t => t.name === 'read')!.bind(ctx);
    const failure = await readTool.executor({ path: 'record:///brief.md?card=card-z' }, new AbortController().signal);
    expect(failure.providerOutcome.kind).toBe('failed');
    expect(failure.providerOutcome).not.toHaveProperty('record_observations');
  });
});

describe('source-derived facts and independent protection', () => {
  it('retains newer current metadata after protected prompt A, ignores historical A, and merges inherited facts with suffix', () => {
    const a = prompt('prompt-A', selection(1, { kind: 'excerpt' }), 'record.brief');
    a.content = prepareRecordPromptContent(`START${'x'.repeat(40000)}OMITTED REQUIREMENT${'y'.repeat(40000)}END`, 'record:///brief.md?card=project');
    const b = prompt('prompt-B', selection(2, { kind: 'excerpt' }));
    // Historical reads are exact tool results; use a pair rather than a prompt claiming historical currentness.
    const callPolicy = policy();
    const call: AgentMessage = agentMessageSchema.parse({ id: `${INPUT}:tool-call:history`, session_id: SESSION, role: 'assistant', kind: 'tool_call',
      content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'history', type: 'function', function: { name: 'read', arguments: '{}' } }] }),
      tool: 'read', tool_call_id: 'history', context_policy: { kind: 'tool_call', template: callPolicy.resultPolicyTemplate,
        template_bytes: callPolicy.resultPolicyTemplateBytes, template_sha256: callPolicy.resultPolicyTemplateSha256 },
      round_id: `r-assistant-${'1'.repeat(32)}`, message_index: 1, block_index: 0, timestamp: TS });
    const result = buildSettledToolResult({ session_id: SESSION, source_input_id: INPUT, tool_call_id: 'history', tool_name: 'read', resultPolicy: callPolicy,
      settlement: { kind: 'executed', execution: executedToolOutcome('observational_query', toolSucceeded({ historical: true })) } }).message;
    result.record_observations = [{ observed: { ...selection(1), selection_kind: 'historical', head: null }, source: { kind: 'read', input_id: INPUT, tool_call_id: 'history', tool_name: 'read' } }];
    const currentCall = agentMessageSchema.parse({ ...call, id: `${INPUT}:tool-call:current`, tool_call_id: 'current',
      content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'current', type: 'function', function: { name: 'read', arguments: '{}' } }] }) });
    const currentResult = agentMessageSchema.parse({ ...result, id: `${INPUT}:tool-result:current`, tool_call_id: 'current',
      record_observations: [{ observed: selection(2), source: { kind: 'read', input_id: INPUT, tool_call_id: 'current', tool_name: 'read' } }] });
    const rows = [a, b, currentCall, currentResult, call, agentMessageSchema.parse(result)];
    const ctx = project();
    appendConversationBatch({ projectRoot: ctx.projectRoot }, rows);
    const source = readConversation(ctx.projectRoot, SESSION);
    const empty = { latestRecovery: null, latestContentPolicyRefusal: null, latestRecordObservations: [] };
    const facts = deriveRequiredModelFacts({ inherited: empty, coveredRows: rows, source });
    expect(facts.latestRecordObservations).toHaveLength(1);
    expect(facts.latestRecordObservations[0]).toMatchObject({ source: { messageId: currentResult.id, rowIndex: 3, segmentVersion: 1 }, observation: { observed: selection(2) } });
    const protection = selectConversationProtection({ inherited: [], rows, sourceVersion: 1, cutoffCount: rows.length });
    const history = compactedHistorySchema.parse({ summaryText: 'Omitted narrative, not body recall', protectedPrompts: protection.protectedPrompts, requiredModelFacts: facts });
    expect(() => validateCompactedHistorySuccessor({ source, sourceVersion: 1, successor: history, coveredRows: rows })).not.toThrow();
    const entryId = randomUUID();
    publishCompactedConversationSegment({ projectRoot: ctx.projectRoot }, SESSION, {
      identity: { genesisId: randomUUID(), entryId, segmentVersion: 2, timestamp: TS, filename: versionFilename(2, entryId) },
      history, cutoffSourceIndex: rows.length - 1, cutoffMessageId: rows.at(-1)!.id,
      continuation: { kind: 'between_rounds' },
    });
    expect(readConversation(ctx.projectRoot, SESSION).effectiveRequiredModelFacts.latestRecordObservations).toEqual(facts.latestRecordObservations);
    expect(readHistoricalConversationSegment(ctx.projectRoot, SESSION, 1).rows).toEqual(rows);
    const publicHistory = foldHistoricalConversationRows(rows);
    expect(publicHistory[3]!.record_observations![0]!.observed).toMatchObject({ exposure: { kind: 'metadata' }, selection: { kind: 'accepted', version: 2 } });
    const compacted = readHistoricalConversationSegment(ctx.projectRoot, SESSION, 2);
    expect(compacted.rows).toEqual([]); // Excerpts survive without a retained transcript.
    const publicContext = segmentContext(compacted.genesis)!;
    expect(publicContext.required_model_facts.latestRecordObservations[0]!.source).toEqual(facts.latestRecordObservations[0]!.source);
    expect(publicContext.protected_prompts.map(p => p.message.content)).toEqual([a.content, b.content]);
    expect(publicContext.protected_prompts[0]!.message.content).toContain('Oversized record preview:');
    expect(publicContext.protected_prompts[0]!.message.content).not.toContain('OMITTED REQUIREMENT');
    expect(publicContext.protected_prompts.map(p => p.message.record_observations![0]!.observed.exposure)).toEqual([{ kind: 'excerpt' }, { kind: 'excerpt' }]);
    for (const publicValue of [publicHistory, publicContext]) {
      expect(JSON.stringify(publicValue)).not.toContain('content_sha256');
      expect(JSON.stringify(publicValue)).not.toContain('template_sha256');
      expect(JSON.stringify(publicValue)).not.toContain('a'.repeat(64));
    }
    const suffix = prompt('newer-low-revision', selection(1), 'record.brief');
    const next = validateConversation(SESSION, [suffix], undefined, { id: INPUT, timestamp: TS, sourceVersion: 1, coveredThroughMessageId: rows.at(-1)!.id, history });
    expect(next.effectiveRequiredModelFacts.latestRecordObservations[0]).toMatchObject({ source: { messageId: suffix.id, segmentVersion: 2 }, observation: { observed: selection(1) } });
    const selected = selectConversationProtection({ inherited: history.protectedPrompts, rows: [suffix], sourceVersion: 2, cutoffCount: 0 });
    expect(selected.activePrompts.map(p => p.message.id)).toEqual([b.id, suffix.id]);
    expect(JSON.stringify(facts.latestRecordObservations)).not.toContain(a.content);
  });

  it('retains explicit document versions and independent accepted backing across compaction', () => {
    const ctx = project();
    const observed: RecordSelectionObservation = { ...selection(3), view: 'effective', selection: {
      kind: 'draft', version: 2, target_version: 2, content_sha256: sha256Hex('starter'),
      accepted_backing: selection(1).selection as Extract<RecordSelectionObservation['selection'], {kind:'accepted'}>,
    } };
    const row = prompt('seed-observation', observed);
    row.context_policy = { ...DURABLE_PRIMARY_CONTENT_POLICY, compactable: true };
    appendConversationBatch({ projectRoot: ctx.projectRoot }, [row]);
    const source = readConversation(ctx.projectRoot, SESSION);
    const facts = deriveRequiredModelFacts({ inherited: { latestRecovery: null, latestContentPolicyRefusal: null, latestRecordObservations: [] }, coveredRows: [row], source });
    const history = compactedHistorySchema.parse({ summaryText: 'No accepted new work', protectedPrompts: [], requiredModelFacts: facts });
    const entryId = randomUUID();
    publishCompactedConversationSegment({ projectRoot: ctx.projectRoot }, SESSION, {
      identity: { genesisId: randomUUID(), entryId, segmentVersion: 2, timestamp: TS, filename: versionFilename(2, entryId) },
      history, cutoffSourceIndex: 0, cutoffMessageId: row.id, continuation: { kind: 'between_rounds' },
    });
    const retained = readConversation(ctx.projectRoot, SESSION);
    expect(retained.effectiveRequiredModelFacts.latestRecordObservations[0]!.observation.observed.selection).toEqual(observed.selection);
    const historical = foldHistoricalConversationRows(readHistoricalConversationSegment(ctx.projectRoot, SESSION, 1).rows);
    const compacted = segmentContext(readHistoricalConversationSegment(ctx.projectRoot, SESSION, 2).genesis)!;
    for (const selection of [historical[0]!.record_observations![0]!.observed.selection, compacted.required_model_facts.latestRecordObservations[0]!.observation.observed.selection]) {
      expect(selection).toMatchObject({ kind: 'draft', version: 2, target_version: 2, accepted_backing: { kind: 'accepted', version: 1 } });
      expect(selection).not.toHaveProperty('content_sha256');
    }
    const { target_version: _target, ...missing } = observed.selection as Extract<RecordSelectionObservation['selection'], {kind:'draft'}>;
    expect(() => recordObservationSchema.parse({ ...row.record_observations![0], observed: { ...observed, selection: missing } })).toThrow();
    expect(() => recordObservationSchema.parse({ ...row.record_observations![0], observed: { ...observed, selection: { ...observed.selection, unfilled: false } } })).toThrow();
  });

  it('rejects missing required facts, malformed provenance, and protected descriptor rows; keeps selection distinct from head changes', () => {
    expect(() => compactedHistorySchema.parse({ summaryText: 'x', protectedPrompts: [], requiredModelFacts: { latestRecovery: null, latestContentPolicyRefusal: null } })).toThrow();
    expect(sameRecordSelection(selection(1), { ...selection(1), head: { head_id: '33333333-3333-4333-8333-333333333333', revision: 9 } })).toBe(true);
    expect(sameRecordSelection(selection(1), selection(2))).toBe(false);
    expect(() => recordObservationSchema.parse({ observed: { ...selection(1), view: 'accepted', selection: { kind: 'draft', content_sha256: 'a'.repeat(64), accepted_backing: null } }, source: { kind: 'read', input_id: INPUT, tool_call_id: 'x', tool_name: 'read' } })).toThrow();
    const descriptor = { ...prompt('descriptor', selection(1)), role: 'system', kind: 'record_observation', content: '', instruction_origin: undefined, record_prompt: undefined,
      context_policy: STRUCTURAL_ROW_POLICY.record_observation, record_observations: [{ observed: selection(1), source: { kind: 'preparation', input_id: INPUT, node_id: 'plan' } }] };
    expect(() => agentMessageSchema.parse(descriptor)).not.toThrow();
    expect(() => agentMessageSchema.parse({ ...descriptor, context_policy: { ...DURABLE_PRIMARY_CONTENT_POLICY, compactable: false } })).toThrow();
    expect(() => conversationSegmentEnvelopeSchema.parse({ version: 8, type: 'conversation-segment', rows: [prompt('old', selection(1))] })).toThrow();
    expect(() => conversationVersionIndexSchema.parse({ format_version: 8, kind: 'conversation-version-index', session_id: SESSION, created_at: TS, versions: [], current_version: null, current_filename: null })).toThrow();
  });
});
