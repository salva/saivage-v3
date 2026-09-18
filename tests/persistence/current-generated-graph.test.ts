import { afterEach, describe, expect, it } from '@jest/globals';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initializeAndValidateCurrentGeneratedState } from '../../src/persistence/current-generated-graph.js';
import { appendConversationBatch, readConversationCatalog, readCurrentConversationSegment } from '../../src/persistence/conversation-file.js';
import { appLogFile, cardConversationVersionFile, cardRecordStreamFile, cardStreamFile, globalAgentConversationVersionFile, saivageCardsRoot } from '../../src/persistence/layout.js';
import type { CompiledProjectWorkflows } from '../../src/runtime/card-process/card-process-config.js';
import { agentMessageSchema, cardAgentSessionId, cardRecordSchema, conversationSessionIdentity, type AgentMessage, type ConversationSessionId } from '../../src/schemas/index.js';
import { publishCardVersion, publishInitialChildCard } from '../../src/persistence/card-files.js';
import { cardVersionChangeSchema } from '../../src/persistence/canonical-card-artifacts.js';
import { CardService, initProjectTree, TEST_WORKFLOWS } from '../helpers/canonical-project.js';
import { testRecordDefinition } from '../helpers/record-definitions.js';

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('current generated state startup admission', () => {
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

  it('accepts a missing optional stream, never creates it, and truncates only an unterminated conversation suffix', () => {
    const root = fixture(); const optional = optionalStream(root);
    expect(existsSync(optional)).toBe(false);
    const path = plannerConversationWithSuffix(root); const canonicalLength = readFileSync(path).byteLength - Buffer.byteLength('unterminated');

    initializeAndValidateCurrentGeneratedState(root, TEST_WORKFLOWS);

    expect(existsSync(optional)).toBe(false);
    expect(readFileSync(path).byteLength).toBe(canonicalLength);
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
    if (authority === 'card') path = cardStreamFile(root, 'project');
    else if (authority === 'record') path = cardRecordStreamFile(root, 'project', testRecordDefinition('brief.md', 'project'));
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
    const optionalBelow = cardRecordStreamFile(root, child.id, testRecordDefinition('status.md', 'code'));
    cards.deleteSubtrees([child.id], () => true);
    const cardTypes = new Map(TEST_WORKFLOWS.cardTypes); cardTypes.delete('code');
    const workflows = { ...TEST_WORKFLOWS, cardTypes } as CompiledProjectWorkflows;

    expect(() => initializeAndValidateCurrentGeneratedState(root, workflows)).not.toThrow();
    expect(readFileSync(conversationPath)).toEqual(sentinel);
    expect(existsSync(optionalBelow)).toBe(false);
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
function optionalStream(root: string): string { return cardRecordStreamFile(root, 'project', testRecordDefinition('status.md', 'project')); }
function plannerText(id: string): AgentMessage { return message(id, 'agent:planner:project'); }
function message(id: string, sessionId: ConversationSessionId): AgentMessage { return agentMessageSchema.parse({ id, session_id: sessionId, role: 'user', kind: 'text', content: id, context_policy: { kind: 'content', storage: 'durable', replacement: { kind: 'retain' }, audience: 'primary_and_summarizer', evidence: { kind: 'none' } }, round_id: `r-user-${'0'.repeat(32)}`, message_index: 1, block_index: 0, timestamp: '2026-08-14T00:00:00.000Z' }); }
function globalActivation(): AgentMessage { const timestamp = '2026-08-14T00:00:00.000Z'; return agentMessageSchema.parse({ id: 'activation', context_policy: { kind: 'structural', behavior: 'activation_boundary' }, session_id: 'agent:analyst:global', role: 'system', kind: 'activity', content: JSON.stringify({ event: 'activation_open', agent_name: 'analyst', input_id: '00000000-0000-4000-8000-000000000001', timestamp }), round_id: `r-pre-${'0'.repeat(32)}`, message_index: 0, block_index: 0, timestamp }); }
function currentSegmentPath(root: string, sessionId: ConversationSessionId): string { const catalog = readConversationCatalog(root, sessionId); const identity = conversationSessionIdentity(sessionId); const filename = catalog.versions.at(-1)!.filename; return identity.cardId === null ? globalAgentConversationVersionFile(root, identity.agentName, filename) : cardConversationVersionFile(root, identity.cardId, identity.agentName, filename); }
function plannerCurrentSegmentPath(root: string): string { return currentSegmentPath(root, 'agent:planner:project'); }
function plannerConversationWithSuffix(root: string): string { appendConversationBatch({ projectRoot: root }, [plannerText('planner-first')]); const path = plannerCurrentSegmentPath(root); appendFileSync(path, 'unterminated'); return path; }
function mutateCurrentCard(root: string, cardId: string, mutate: (card: Record<string, unknown>) => Record<string, unknown>): void { const path = cardStreamFile(root, cardId); const envelopes = readFileSync(path, 'utf8').trimEnd().split('\n'); const last = JSON.parse(envelopes.at(-1)!) as { rows: Array<Record<string, unknown>> }; const row = last.rows[0]!; const kind = row.kind; const cardKey = kind === 'card-tombstone' ? 'final_card' : 'card'; row[cardKey] = mutate(row[cardKey] as Record<string, unknown>); envelopes[envelopes.length - 1] = JSON.stringify(last); writeFileSync(path, `${envelopes.join('\n')}\n`); }
function preparePhaseAEffectSentinels(root: string): { readonly optional: string; readonly conversation: string; readonly conversationBytes: Buffer } { const optional = optionalStream(root); const conversation = plannerConversationWithSuffix(root); return { optional, conversation, conversationBytes: readFileSync(conversation) }; }
function expectPhaseAEffectsAbsent(root: string, effects: { readonly optional: string; readonly conversation: string; readonly conversationBytes: Buffer }): void { expect(existsSync(appLogFile(root))).toBe(false); expect(existsSync(effects.optional)).toBe(false); expect(readFileSync(effects.conversation)).toEqual(effects.conversationBytes); }
