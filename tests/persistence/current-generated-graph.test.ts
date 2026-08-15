import { afterEach, describe, expect, it } from '@jest/globals';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { initializeAndValidateCurrentGeneratedState } from '../../src/persistence/current-generated-graph.js';
import { appendConversationBatch, readConversationCatalog, readCurrentConversationSegment } from '../../src/persistence/conversation-file.js';
import { appLogFile, cardConversationVersionFile, cardConversationVersionIndexFile, cardRecordVersionFile, cardRecordVersionIndexFile, cardVersionFile, cardVersionIndexFile, globalAgentConversationVersionFile, saivageCardsRoot } from '../../src/persistence/layout.js';
import type { CompiledProjectWorkflows } from '../../src/runtime/card-process/card-process-config.js';
import { agentMessageSchema, type AgentMessage } from '../../src/schemas/index.js';
import { CardService, initProjectTree, TEST_WORKFLOWS } from '../helpers/canonical-project.js';
import { testRecordDefinition } from '../helpers/record-definitions.js';

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('current generated state startup admission', () => {
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

  it('accepts complete empty optional authority and truncates only an unterminated conversation suffix', () => {
    const root = fixture(); const optional = optionalIndex(root); const optionalBytes = readFileSync(optional);
    expect(JSON.parse(optionalBytes.toString('utf8'))).toEqual(expect.objectContaining({ kind: 'authored-record-version-index', versions: [], current_version: null, current_filename: null }));
    const path = plannerConversationWithSuffix(root); const canonicalLength = readFileSync(path).byteLength - Buffer.byteLength('unterminated');

    initializeAndValidateCurrentGeneratedState(root, TEST_WORKFLOWS);

    expect(readFileSync(optional)).toEqual(optionalBytes);
    expect(readFileSync(path).byteLength).toBe(canonicalLength);
  });

  it.each(['directory', 'index'] as const)('rejects a missing declared optional %s without recreating it', (missing) => {
    const root = fixture(); const optional = optionalIndex(root); const target = missing === 'directory' ? dirname(optional) : optional;
    rmSync(target, { recursive: true });

    expect(() => initializeAndValidateCurrentGeneratedState(root, TEST_WORKFLOWS)).toThrow(expect.objectContaining({ code: 'ENOENT' }));
    expect(existsSync(target)).toBe(false);
  });

  it.each(['card', 'record', 'conversation'] as const)('fails on complete malformed current %s authority without changing it', (authority) => {
    const root = fixture(); let path: string; let indexPath: string;
    if (authority === 'card') { path = currentCardArtifactPath(root, 'project'); indexPath = cardVersionIndexFile(root, 'project'); }
    else if (authority === 'record') { const definition = testRecordDefinition('brief.md', 'project'); path = currentRecordArtifactPath(root, 'project', definition); indexPath = cardRecordVersionIndexFile(root, 'project', definition); }
    else {
      appendConversationBatch({ projectRoot: root }, [plannerText('first')]);
      path = plannerCurrentSegmentPath(root); indexPath = cardConversationVersionIndexFile(root, 'project', 'planner'); appendFileSync(path, '{"complete":"malformed"}\n');
    }
    if (authority !== 'conversation') writeFileSync(path, 'complete malformed authority\n');
    const before = readFileSync(path); const beforeIndex = readFileSync(indexPath);

    expect(() => initializeAndValidateCurrentGeneratedState(root, TEST_WORKFLOWS)).toThrow();
    expect(readFileSync(path)).toEqual(before);
    expect(readFileSync(indexPath)).toEqual(beforeIndex);
  });

  it.each(['missing-dependency', 'dependency-cycle'] as const)('rejects %s before optional effects', (fault) => {
    const root = fixture(); const cards = new CardService(root);
    if (fault === 'missing-dependency') mutateCurrentCard(root, 'project', (card) => ({ ...card, depends_on: ['card-z'] }));
    else {
      const child = cards.create({ type: 'code', parent: 'project', title: 'child', bootstrap_content: 'brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
      mutateCurrentCard(root, 'project', (card) => ({ ...card, depends_on: [child.id] }));
      mutateCurrentCard(root, child.id, (card) => ({ ...card, depends_on: ['project'] }));
    }
    const effects = preparePhaseAEffectSentinels(root);

    expect(() => initializeAndValidateCurrentGeneratedState(root, TEST_WORKFLOWS)).toThrow(fault === 'missing-dependency' ? /depends_on missing/ : /dependency graph contains a cycle/);
    expectPhaseAEffectsAbsent(root, effects);
  });

  it('rejects a missing compiled workflow before optional effects', () => {
    const root = fixture(); const cards = new CardService(root);
    cards.create({ type: 'code', parent: 'project', title: 'child', bootstrap_content: 'brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    const cardTypes = new Map(TEST_WORKFLOWS.cardTypes); cardTypes.delete('code');
    const workflows = { ...TEST_WORKFLOWS, cardTypes } as CompiledProjectWorkflows;
    const effects = preparePhaseAEffectSentinels(root);

    expect(() => initializeAndValidateCurrentGeneratedState(root, workflows)).toThrow(/No compiled workflow exists for card type 'code'/);
    expectPhaseAEffectsAbsent(root, effects);
  });

  it('rejects a disallowed child type before optional effects', () => {
    const root = fixture(); const cards = new CardService(root);
    cards.create({ type: 'code', parent: 'project', title: 'child', bootstrap_content: 'brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    const project = TEST_WORKFLOWS.cardTypes.get('project')!;
    const cardTypes = new Map(TEST_WORKFLOWS.cardTypes); cardTypes.set('project', { ...project, permittedChildTypes: new Set() });
    const workflows = { ...TEST_WORKFLOWS, cardTypes } as CompiledProjectWorkflows;
    const effects = preparePhaseAEffectSentinels(root);

    expect(() => initializeAndValidateCurrentGeneratedState(root, workflows)).toThrow(/violates compiled parent\/type admission/);
    expectPhaseAEffectsAbsent(root, effects);
  });
});

function fixture(): string { const root = mkdtempSync(join(tmpdir(), 'saivage-current-generated-')); roots.push(root); initProjectTree(root); return root; }
function optionalIndex(root: string): string { return cardRecordVersionIndexFile(root, 'project', testRecordDefinition('status.md', 'project')); }
function plannerText(id: string): AgentMessage { return message(id, 'agent:planner:project'); }
function message(id: string, sessionId: 'agent:planner:project' | 'agent:analyst:global'): AgentMessage { return agentMessageSchema.parse({ id, session_id: sessionId, role: 'user', kind: 'text', content: id, round_id: `r-user-${'0'.repeat(32)}`, message_index: 1, block_index: 0, timestamp: '2026-08-14T00:00:00.000Z' }); }
function globalActivation(): AgentMessage { const timestamp = '2026-08-14T00:00:00.000Z'; return agentMessageSchema.parse({ id: 'activation', session_id: 'agent:analyst:global', role: 'system', kind: 'activity', content: JSON.stringify({ event: 'activation_open', agent_name: 'analyst', input_id: '00000000-0000-4000-8000-000000000001', timestamp }), round_id: `r-pre-${'0'.repeat(32)}`, message_index: 0, block_index: 0, timestamp }); }
function plannerCurrentSegmentPath(root: string): string { const catalog = readConversationCatalog(root, 'agent:planner:project'); return cardConversationVersionFile(root, 'project', 'planner', catalog.versions.at(-1)!.filename); }
function plannerConversationWithSuffix(root: string): string { appendConversationBatch({ projectRoot: root }, [plannerText('planner-first')]); const path = plannerCurrentSegmentPath(root); appendFileSync(path, 'unterminated'); return path; }
function currentCardArtifactPath(root: string, cardId: string): string { const index = JSON.parse(readFileSync(cardVersionIndexFile(root, cardId), 'utf8')) as { current_filename: string }; return cardVersionFile(root, cardId, index.current_filename); }
function currentRecordArtifactPath(root: string, cardId: string, definition: ReturnType<typeof testRecordDefinition>): string { const index = JSON.parse(readFileSync(cardRecordVersionIndexFile(root, cardId, definition), 'utf8')) as { current_filename: string }; return cardRecordVersionFile(root, cardId, definition, index.current_filename); }
function mutateCurrentCard(root: string, cardId: string, mutate: (card: Record<string, unknown>) => Record<string, unknown>): void { const path = currentCardArtifactPath(root, cardId); const artifact = JSON.parse(readFileSync(path, 'utf8')) as { card: Record<string, unknown> }; writeFileSync(path, `${JSON.stringify({ ...artifact, card: mutate(artifact.card) })}\n`); }
function preparePhaseAEffectSentinels(root: string): { readonly optional: string; readonly conversation: string; readonly conversationBytes: Buffer } { const optional = optionalIndex(root); unlinkSync(optional); const conversation = plannerConversationWithSuffix(root); return { optional, conversation, conversationBytes: readFileSync(conversation) }; }
function expectPhaseAEffectsAbsent(root: string, effects: { readonly optional: string; readonly conversation: string; readonly conversationBytes: Buffer }): void { expect(existsSync(appLogFile(root))).toBe(false); expect(existsSync(effects.optional)).toBe(false); expect(readFileSync(effects.conversation)).toEqual(effects.conversationBytes); }
