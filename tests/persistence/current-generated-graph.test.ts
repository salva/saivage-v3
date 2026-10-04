import { afterEach, describe, expect, it } from '@jest/globals';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { initializeAndValidateCurrentGeneratedState } from '../../src/persistence/current-generated-graph.js';
import { appendConversationBatch, initializeMissingConversation, readConversationCatalog, readCurrentConversationSegment } from '../../src/persistence/conversation-file.js';
import { appLogFile, cardConversationVersionFile, cardConversationVersionIndexFile, cardRecordHeadFile, cardHeadFile, cardHistoryFile, globalAgentConversationVersionFile, globalAgentConversationVersionIndexFile, providerExchangeFile, saivageCardsRoot } from '../../src/persistence/layout.js';
import { compileProjectWorkflows, type CompiledProjectWorkflows } from '../../src/runtime/card-process/card-process-config.js';
import { agentMessageSchema, cardAgentSessionId, cardRecordSchema, conversationSessionIdentity, effectiveSaivageConfigSchema, type AgentMessage, type ConversationSessionId, type SaivageConfig } from '../../src/schemas/index.js';
import { publishCardVersion, publishInitialChildCard } from '../../src/persistence/card-files.js';
import { cardVersionChangeSchema } from '../../src/persistence/canonical-card-artifacts.js';
import { CardService, initProjectTree, TEST_WORKFLOWS } from '../helpers/canonical-project.js';
import { testRecordDefinition } from '../helpers/record-definitions.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';
import { appendAppLogEntry } from '../../src/persistence/app-log.js';
import { appendProviderExchangeEntry } from '../../src/persistence/provider-exchange-log.js';

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('current generated state startup admission', () => {
  it.each(['missing', 'malformed'] as const)('admits current cards with a %s unconsumed predecessor but rejects history access', (fault) => {
    const root = fixture(); const cards = new CardService(root);
    const head = JSON.parse(readFileSync(cardHeadFile(root, 'project'), 'utf8'));
    const predecessor = cardHistoryFile(root, 'project', head.ordinary.entry_id);
    cards.create({ type: 'code', parent: 'project', title: 'child', bootstrap_content: 'brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
    if (fault === 'missing') rmSync(predecessor);
    else writeFileSync(predecessor, 'complete malformed predecessor\n');

    expect(() => initializeAndValidateCurrentGeneratedState(root, TEST_WORKFLOWS)).not.toThrow();
    expect(cards.read('project')!.version_seq).toBe(2);
    expect(() => cards.listCardVersions('project')).toThrow();
    expect(() => cards.readCardVersion('project', 1)).toThrow();
    if (fault === 'malformed') expect(readFileSync(predecessor, 'utf8')).toBe('complete malformed predecessor\n');
    else expect(existsSync(predecessor)).toBe(false);
  });

  it.each(['missing', 'malformed'] as const)('rejects a %s selected current card document before later admission effects', (fault) => {
    const root = fixture();
    const head = JSON.parse(readFileSync(cardHeadFile(root, 'project'), 'utf8'));
    const current = cardHistoryFile(root, 'project', head.ordinary.entry_id);
    if (fault === 'missing') rmSync(current);
    else writeFileSync(current, 'complete malformed current document\n');
    const effects = preparePhaseAEffectSentinels(root);
    expect(() => initializeAndValidateCurrentGeneratedState(root, TEST_WORKFLOWS)).toThrow();
    expectPhaseAEffectsAbsent(root, effects);
  });

  it('existing startup consumers truncate selected valid tails in remaining JSONL families without initializing optional records', () => {
    const root = fixture();
    appendAppLogEntry(root, 'event', () => ({ type: 'event', data: { id: 'first', timestamp: '2026-08-11T00:00:00.000Z', kind: 'runtime_diagnostic', error_message: 'first' } }));
    const owner = 'agent:planner:project' as const; const timestamp = '2026-08-11T00:00:00.000Z';
    appendProviderExchangeEntry(root, owner, { type: 'provider_exchange', data: { session_id: owner, source_input_id: 'first', attempt_index: 0, timestamp, payload: { contract_id: 'test.v1', contract_name: 'test', transport: 'generic', provider: 'test', model: 'test', source_input_id: 'first', attempt_index: 0, request_params: {}, started_at: timestamp, completed_at: timestamp, status: 'ok', terminal_tool_fired: null, assistant_output_ids: [] } } });
    const conversation = plannerConversationWithSuffix(root);
    const paths = [appLogFile(root), providerExchangeFile(root, owner)];
    const retained = paths.map((path) => readFileSync(path));
    for (const path of paths) appendFileSync(path, Buffer.from([0xe2, 0x82]));
    initializeAndValidateCurrentGeneratedState(root, TEST_WORKFLOWS);
    paths.forEach((path, index) => expect(readFileSync(path)).toEqual(retained[index]));
    expect(readFileSync(conversation).at(-1)).toBe(0x0a); expect(existsSync(optionalStream(root))).toBe(false);
  });

  it('malformed card head fails without truncation before later owners run', () => {
    const root = fixture(); const card = cardHeadFile(root, 'project'); appendFileSync(card, 'suffix'); const retained = readFileSync(card);
    const conversation = plannerConversationWithSuffix(root); const before = readFileSync(conversation);
    rmSync(cardConversationVersionIndexFile(root, 'project', 'reviewer'));
    expect(() => initializeAndValidateCurrentGeneratedState(root, TEST_WORKFLOWS)).toThrow();
    expect(readFileSync(card)).toEqual(retained); expect(readFileSync(conversation)).toEqual(before);
  });
  it('accepts a valid custom type on the wire and rejects it at compiled startup admission',()=>{
    const root=fixture();const cards=new CardService(root);const codeWorkflow=TEST_WORKFLOWS.cardTypes.get('code')!;const customWorkflow={...codeWorkflow,cardType:'custom-leaf'};
    const unknown=publishInitialChildCard(root,{type:'custom-leaf',parent:'project',title:'custom wire',bootstrap_content:'brief',priority:0,urgency:'normal',created_by:'analyst',depends_on:[]},customWorkflow);
    const parent=cards.read('project')!;const linked=cardRecordSchema.parse({...parent,child_membership:[...parent.child_membership,unknown.id],active_child_order:[...parent.active_child_order,unknown.id],version_seq:parent.version_seq+1,updated_at:'2026-08-15T00:00:01.000Z'});
    const change=cardVersionChangeSchema.parse({entry_id:'11111111-1111-4111-8111-111111111111',kind:'child_link',card_id:'project',resulting_version:linked.version_seq,changed_at:linked.updated_at,changed_by_actor:'runtime',changed_by_surface:'runtime',change_reason:'child linked',changed_fields:['child_membership','active_child_order'],change_summary:`linked child ${unknown.id}`,terminal_summary:null});
    publishCardVersion(root,linked,change);
    expect(cardRecordSchema.safeParse(unknown).success).toBe(true);
    expect(()=>initializeAndValidateCurrentGeneratedState(root,TEST_WORKFLOWS)).toThrow("No compiled workflow exists for card type 'custom-leaf'.");
    expect(cardRecordSchema.safeParse({...unknown,type:'Not Valid'}).success).toBe(false);
  });
  it('rejects missing required project authority before optional effects or conversation truncation', () => {
    const root = fixture();
    appendConversationBatch({ projectRoot: root }, [globalActivation()]);
    const global = readCurrentConversationSegment(root, 'agent:analyst:global')!;
    const conversationPath = globalAgentConversationVersionFile(root, 'analyst', global.entry.filename);
    appendFileSync(conversationPath, 'unterminated'); const before = readFileSync(conversationPath);
    rmSync(saivageCardsRoot(root), { recursive: true });

    expect(() => initializeAndValidateCurrentGeneratedState(root, TEST_WORKFLOWS)).toThrow(/Required project card authority is missing/);
    expect(existsSync(appLogFile(root))).toBe(false);
    expect(readFileSync(conversationPath)).toEqual(before);
  });

  it('accepts a missing optional stream, never creates it, and consumes an unterminated conversation suffix', () => {
    const root = fixture(); const optional = optionalStream(root);
    expect(existsSync(optional)).toBe(false);
    const path = plannerConversationWithSuffix(root); const canonicalLength = readFileSync(path).byteLength - Buffer.byteLength('unterminated');

    initializeAndValidateCurrentGeneratedState(root, TEST_WORKFLOWS);

    expect(existsSync(optional)).toBe(false);
    expect(readFileSync(path).byteLength).toBe(canonicalLength);
  });

  it('accepts empty required conversation indexes', () => {
    const root = fixture();

    expect(() => initializeAndValidateCurrentGeneratedState(root, TEST_WORKFLOWS)).not.toThrow();
    for (const sessionId of ['agent:analyst:global', 'agent:planner:project', 'agent:reviewer:project'] as const) {
      expect(readConversationCatalog(root, sessionId).versions).toEqual([]);
    }
  });

  it('validates a required complete evidence file before truncating the current conversation tail', () => {
    const root = fixture();
    const path = plannerConversationWithSuffix(root);
    const before = readFileSync(path);
    const evidence = providerExchangeFile(root, 'agent:planner:project');
    writeFileSync(evidence, '{malformed}\n');
    expect(() => initializeAndValidateCurrentGeneratedState(root, TEST_WORKFLOWS)).toThrow(/malformed/);
    expect(readFileSync(path)).toEqual(before);
    expect(readFileSync(evidence, 'utf8')).toBe('{malformed}\n');
  });

  it('ignores unselected evidence and reads selected optional Oversight evidence only with its catalog', () => {
    const root = fixture();
    const oversight = `agent:${TEST_WORKFLOWS.oversight.name}:global` as ConversationSessionId;
    const evidence = providerExchangeFile(root, oversight);
    mkdirSync(dirname(evidence), { recursive: true });
    writeFileSync(evidence, '{malformed}\n');
    expect(() => initializeAndValidateCurrentGeneratedState(root, TEST_WORKFLOWS)).not.toThrow();
    initializeMissingConversation(root, oversight);
    expect(() => initializeAndValidateCurrentGeneratedState(root, TEST_WORKFLOWS)).toThrow(/malformed/);
    expect(readFileSync(evidence, 'utf8')).toBe('{malformed}\n');
  });

  it('rejects a renamed card participant without creating it or applying earlier admission effects', () => {
    const root = fixture(); const cards = new CardService(root);
    const child = cards.create({ type: 'code', parent: 'project', title: 'child', bootstrap_content: 'brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
    const previousSessionId = cardAgentSessionId('executor', child.id);
    appendConversationBatch({ projectRoot: root }, [message('prior-executor-history', previousSessionId)]);
    const previousIndex = cardConversationVersionIndexFile(root, child.id, 'executor');
    const previousBytes = readFileSync(previousIndex);
    const previousSegment = currentSegmentPath(root, previousSessionId);
    const previousSegmentBytes = readFileSync(previousSegment);
    const replacementIndex = cardConversationVersionIndexFile(root, child.id, 'executor-v2');
    const effects = preparePhaseAEffectSentinels(root);

    expect(() => initializeAndValidateCurrentGeneratedState(root, renamedCardAgentWorkflows())).toThrow(
      `Required conversation index for current configured session 'agent:executor-v2:${child.id}' is missing from initialized generated state. Startup will not create a replacement session.`,
    );
    expect(existsSync(replacementIndex)).toBe(false);
    expect(readFileSync(previousIndex)).toEqual(previousBytes);
    expect(readFileSync(previousSegment)).toEqual(previousSegmentBytes);
    expectPhaseAEffectsAbsent(root, effects);
  });

  it('rejects a renamed selected Analyst without creating it or changing retained state', () => {
    const root = fixture();
    appendConversationBatch({ projectRoot: root }, [globalActivation()]);
    const previousIndex = globalAgentConversationVersionIndexFile(root, 'analyst');
    const previousBytes = readFileSync(previousIndex);
    const previousSegment = currentSegmentPath(root, 'agent:analyst:global');
    const previousSegmentBytes = readFileSync(previousSegment);
    const replacementIndex = globalAgentConversationVersionIndexFile(root, 'analyst-v2');
    const effects = preparePhaseAEffectSentinels(root);

    expect(() => initializeAndValidateCurrentGeneratedState(root, renamedAnalystWorkflows())).toThrow(
      "Required conversation index for current configured session 'agent:analyst-v2:global' is missing from initialized generated state. Startup will not create a replacement session.",
    );
    expect(existsSync(replacementIndex)).toBe(false);
    expect(readFileSync(previousIndex)).toEqual(previousBytes);
    expect(readFileSync(previousSegment)).toEqual(previousSegmentBytes);
    expectPhaseAEffectsAbsent(root, effects);
  });

  it('rejects a missing unvisited participant index before truncating earlier sessions', () => {
    const root = fixture();
    const missing = cardConversationVersionIndexFile(root, 'project', 'reviewer');
    rmSync(missing);
    const effects = preparePhaseAEffectSentinels(root);

    expect(() => initializeAndValidateCurrentGeneratedState(root, TEST_WORKFLOWS)).toThrow(
      "Required conversation index for current configured session 'agent:reviewer:project' is missing from initialized generated state.",
    );
    expect(existsSync(missing)).toBe(false);
    expectPhaseAEffectsAbsent(root, effects);
  });

  it.each(['malformed', 'mismatched'] as const)('strictly rejects a %s exact required index before optional effects', (fault) => {
    const root = fixture();
    const indexPath = cardConversationVersionIndexFile(root, 'project', 'reviewer');
    if (fault === 'malformed') writeFileSync(indexPath, 'complete malformed index\n');
    else {
      const index = JSON.parse(readFileSync(indexPath, 'utf8')) as Record<string, unknown>;
      index.session_id = 'agent:planner:project';
      writeFileSync(indexPath, `${JSON.stringify(index)}\n`);
    }
    const before = readFileSync(indexPath);
    const effects = preparePhaseAEffectSentinels(root);

    expect(() => initializeAndValidateCurrentGeneratedState(root, TEST_WORKFLOWS)).toThrow(
      fault === 'malformed' ? /Conversation index .* is malformed/ : /Conversation index identity does not match 'agent:reviewer:project'/,
    );
    expect(readFileSync(indexPath)).toEqual(before);
    expectPhaseAEffectsAbsent(root, effects);
  });

  it('does not discover an unconfigured malformed conversation namespace', () => {
    const root = fixture();
    const unknownIndex = globalAgentConversationVersionIndexFile(root, 'unused');
    mkdirSync(dirname(unknownIndex), { recursive: true });
    writeFileSync(unknownIndex, 'malformed inert namespace\n');
    const before = readFileSync(unknownIndex);

    expect(() => initializeAndValidateCurrentGeneratedState(root, TEST_WORKFLOWS)).not.toThrow();
    expect(readFileSync(unknownIndex)).toEqual(before);
  });

  it.each(['empty', 'malformed'] as const)('rejects a present %s optional stream without changing it', (fault) => {
    const root = fixture(); const optional = optionalStream(root);
    writeFileSync(optional, fault === 'empty' ? '' : 'complete malformed stream\n');
    const before = readFileSync(optional);

    expect(() => initializeAndValidateCurrentGeneratedState(root, TEST_WORKFLOWS)).toThrow();
    expect(readFileSync(optional)).toEqual(before);
  });

  it.each(['card', 'record', 'conversation'] as const)('fails on complete malformed current %s authority without changing it', (authority) => {
    const root = fixture(); let path: string;
    if (authority === 'card') path = cardHeadFile(root, 'project');
    else if (authority === 'record') path = cardRecordHeadFile(root, 'project', testRecordDefinition('brief.md', 'project'));
    else {
      appendConversationBatch({ projectRoot: root }, [plannerText('first')]);
      path = plannerCurrentSegmentPath(root); appendFileSync(path, '{"complete":"malformed"}\n');
    }
    if (authority !== 'conversation') writeFileSync(path, 'complete malformed authority\n');
    const before = readFileSync(path);

    expect(() => initializeAndValidateCurrentGeneratedState(root, TEST_WORKFLOWS)).toThrow();
    expect(readFileSync(path)).toEqual(before);
  });

  it.each(['missing-dependency', 'dependency-cycle'] as const)('rejects a %s corruption before optional effects', (fault) => {
    const root = fixture(); const cards = new CardService(root);
    if (fault === 'missing-dependency') mutateCurrentCard(root, 'project', (card) => ({ ...card, depends_on: ['card-z'] }));
    else {
      const child = cards.create({ type: 'code', parent: 'project', title: 'child', bootstrap_content: 'brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
      mutateCurrentCard(root, 'project', (card) => ({ ...card, depends_on: [child.id] }));
      mutateCurrentCard(root, child.id, (card) => ({ ...card, depends_on: ['project'] }));
    }
    const effects = preparePhaseAEffectSentinels(root);

    expect(() => initializeAndValidateCurrentGeneratedState(root, TEST_WORKFLOWS)).toThrow();
    expectPhaseAEffectsAbsent(root, effects);
  });

  it('terminates startup at a retained tombstone before workflow lookup and any operation below it', () => {
    const root = fixture(); const cards = new CardService(root);
    const child = cards.create({ type: 'code', parent: 'project', title: 'child', bootstrap_content: 'brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
    const agentName = [...TEST_WORKFLOWS.cardTypes.get('code')!.states.values()].flatMap((state) => state.kind === 'node' && state.agent.session === 'card' ? [state.agent.name] : [])[0]!;
    const sessionId = cardAgentSessionId(agentName, child.id);
    appendConversationBatch({ projectRoot: root }, [message('tombstone-sentinel', sessionId)]);
    const conversationPath = currentSegmentPath(root, sessionId);
    appendFileSync(conversationPath, 'unterminated');
    const sentinel = readFileSync(conversationPath);
    const optionalBelow = cardRecordHeadFile(root, child.id, testRecordDefinition('status.md', 'code'));
    cards.deleteSubtrees([child.id], () => true);
    const terminalPath = cardHeadFile(root, child.id); const terminal = readFileSync(terminalPath);
    const cardTypes = new Map(TEST_WORKFLOWS.cardTypes); cardTypes.delete('code');
    const workflows = { ...TEST_WORKFLOWS, cardTypes } as CompiledProjectWorkflows;

    expect(() => initializeAndValidateCurrentGeneratedState(root, workflows)).not.toThrow();
    expect(readFileSync(conversationPath)).toEqual(sentinel);
    expect(readFileSync(terminalPath)).toEqual(terminal);
    expect(existsSync(optionalBelow)).toBe(false);
    const terminalHead = JSON.parse(terminal.toString('utf8'));
    writeFileSync(cardHistoryFile(root, child.id, terminalHead.ordinary.entry_id), 'complete malformed tombstone\n');
    expect(() => initializeAndValidateCurrentGeneratedState(root, workflows)).toThrow();
    expect(readFileSync(conversationPath)).toEqual(sentinel);
  });

  it('rejects a missing compiled workflow before optional effects', () => {
    const root = fixture(); const cards = new CardService(root);
    cards.create({ type: 'code', parent: 'project', title: 'child', bootstrap_content: 'brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
    const cardTypes = new Map(TEST_WORKFLOWS.cardTypes); cardTypes.delete('code');
    const workflows = { ...TEST_WORKFLOWS, cardTypes } as CompiledProjectWorkflows;
    const effects = preparePhaseAEffectSentinels(root);

    expect(() => initializeAndValidateCurrentGeneratedState(root, workflows)).toThrow(/No compiled workflow exists for card type 'code'/);
    expectPhaseAEffectsAbsent(root, effects);
  });

  it('rejects a disallowed child type before optional effects', () => {
    const root = fixture(); const cards = new CardService(root);
    cards.create({ type: 'code', parent: 'project', title: 'child', bootstrap_content: 'brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
    const project = TEST_WORKFLOWS.cardTypes.get('project')!;
    const cardTypes = new Map(TEST_WORKFLOWS.cardTypes); cardTypes.set('project', { ...project, permittedChildTypes: new Set() });
    const workflows = { ...TEST_WORKFLOWS, cardTypes } as CompiledProjectWorkflows;
    const effects = preparePhaseAEffectSentinels(root);

    expect(() => initializeAndValidateCurrentGeneratedState(root, workflows)).toThrow(/violates compiled parent\/type admission/);
    expectPhaseAEffectsAbsent(root, effects);
  });
});

function fixture(): string { const root = mkdtempSync(join(tmpdir(), 'saivage-current-generated-')); roots.push(root); initProjectTree(root); return root; }
function config(): SaivageConfig { return effectiveSaivageConfigSchema.parse(structuredClone(TEST_SAIVAGE_CONFIG)); }
function renamedCardAgentWorkflows(): CompiledProjectWorkflows { const value = config(); value.agents['executor-v2'] = { ...value.agents.executor! }; value.card_types.code!.workflow.notification_recipient = 'executor-v2'; value.card_types.code!.workflow.nodes.execute!.agent = 'executor-v2'; return compileProjectWorkflows(value); }
function renamedAnalystWorkflows(): CompiledProjectWorkflows { const value = config(); value.agents['analyst-v2'] = { ...value.agents.analyst! }; value.analyst_agent = 'analyst-v2'; return compileProjectWorkflows(value); }
function optionalStream(root: string): string { return cardRecordHeadFile(root, 'project', testRecordDefinition('status.md', 'project')); }
function plannerText(id: string): AgentMessage { return message(id, 'agent:planner:project'); }
function message(id: string, sessionId: ConversationSessionId): AgentMessage { return agentMessageSchema.parse({ id, session_id: sessionId, role: 'user', kind: 'text', content: id, context_policy: { kind: 'content', storage: 'durable', replacement: { kind: 'retain' }, audience: 'primary_and_summarizer', evidence: { kind: 'none' }, compactable: true }, round_id: `r-user-${'0'.repeat(32)}`, message_index: 1, block_index: 0, timestamp: '2026-08-14T00:00:00.000Z' }); }
function globalActivation(): AgentMessage { const timestamp = '2026-08-14T00:00:00.000Z'; return agentMessageSchema.parse({ id: 'activation', context_policy: { kind: 'structural', behavior: 'activation_boundary' }, session_id: 'agent:analyst:global', role: 'system', kind: 'activity', content: JSON.stringify({ event: 'activation_open', agent_name: 'analyst', input_id: '00000000-0000-4000-8000-000000000001', timestamp }), round_id: `r-pre-${'0'.repeat(32)}`, message_index: 0, block_index: 0, timestamp }); }
function currentSegmentPath(root: string, sessionId: ConversationSessionId): string { const catalog = readConversationCatalog(root, sessionId); const identity = conversationSessionIdentity(sessionId); const filename = catalog.versions.at(-1)!.filename; return identity.cardId === null ? globalAgentConversationVersionFile(root, identity.agentName, filename) : cardConversationVersionFile(root, identity.cardId, identity.agentName, filename); }
function plannerCurrentSegmentPath(root: string): string { return currentSegmentPath(root, 'agent:planner:project'); }
function plannerConversationWithSuffix(root: string): string { appendConversationBatch({ projectRoot: root }, [plannerText('planner-first')]); const path = plannerCurrentSegmentPath(root); appendFileSync(path, 'unterminated'); return path; }
function mutateCurrentCard(root: string, cardId: string, mutate: (card: Record<string, unknown>) => Record<string, unknown>): void { const head = JSON.parse(readFileSync(cardHeadFile(root, cardId), 'utf8')); const path = cardHistoryFile(root, cardId, head.ordinary.entry_id); const row = JSON.parse(readFileSync(path, 'utf8')); const cardKey = row.kind === 'card-tombstone' ? 'final_card' : 'card'; row[cardKey] = mutate(row[cardKey]); writeFileSync(path, `${JSON.stringify(row)}\n`); }
function preparePhaseAEffectSentinels(root: string): { readonly optional: string; readonly conversation: string; readonly conversationBytes: Buffer } { const optional = optionalStream(root); const conversation = plannerConversationWithSuffix(root); return { optional, conversation, conversationBytes: readFileSync(conversation) }; }
function expectPhaseAEffectsAbsent(root: string, effects: { readonly optional: string; readonly conversation: string; readonly conversationBytes: Buffer }): void { expect(existsSync(appLogFile(root))).toBe(false); expect(existsSync(effects.optional)).toBe(false); expect(readFileSync(effects.conversation)).toEqual(effects.conversationBytes); }
