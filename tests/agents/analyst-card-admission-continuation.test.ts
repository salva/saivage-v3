import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AnalystSession } from '../../src/runtime/actors/analyst-session.js';
import { ConversationLLMActor } from '../../src/runtime/actors/llm-actor.js';
import type { LlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';
import type { ProviderTurnCompletion } from '../../src/contracts/index.js';
import { analystCardToolBinders } from '../../src/tools/analyst-card-tools.js';
import type { ToolContext } from '../../src/tools/analyst-tool-types.js';
import { CardService, initProjectTree, testAnalystMutationServices } from '../helpers/canonical-project.js';
import { bindToolProvider } from '../helpers/bind-tool-provider.js';
import { buildInvocationSurfaceFixture } from '../helpers/invocation-surface-fixture.js';
import { scriptedAdmissionProvider, testCompactionPolicy, unusedSummarizerProvider, testLlmToolInvocationContext } from '../helpers/llm-test-helpers.js';
import { invokeToolForLlm } from '../../src/tools/invocation.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { readAppLogEntries } from '../../src/persistence/app-log.js';
import { readConversation } from '../../src/persistence/conversation-file.js';
import { cardParentId } from '../../src/schemas/index.js';

const roots: string[] = [];
afterEach(() => { jest.restoreAllMocks(); while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function create(cards: CardService, parent = 'project', type = 'goal') {
  return cards.create({ parent, type, title: 'fixture', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
}

function chain(cards: CardService, depth: number, finalType = 'goal'): string {
  let parent = 'project';
  for (let index = 1; index <= depth; index++) parent = create(cards, parent, index === depth ? finalType : 'goal').id;
  return parent;
}

// Disposable fixture inspection includes namespaces, not just linked cards: denial
// must not consume an allocation or publish any card/record bytes.
function cardBytes(projectRoot: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) { result[child] = '<directory>'; walk(child); }
      else result[child] = readFileSync(child).toString('base64');
    }
  };
  walk(join(projectRoot, '.saivage', 'cards'));
  return result;
}

function harness() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'analyst-card-admission-')); roots.push(projectRoot); initProjectTree(projectRoot);
  const cards = new CardService(projectRoot);
  const readiness = jest.fn();
  const context = {
    projectRoot, actor: 'analyst', surface: 'web-chat', sessionId: 'agent:analyst:global', store: cards,
    cardTypeVocabulary: [...cards.workflows.cardTypes.keys()],
    interventionReadiness: { assertInterventionReady: readiness },
    analystMutations: testAnalystMutationServices(projectRoot, cards, (_id, notification) => ({ ok: true, notificationId: notification.id })),
  } as unknown as ToolContext;
  const surface = buildInvocationSurfaceFixture('analyst', [bindToolProvider('analyst-card', analystCardToolBinders, context)]);
  return { projectRoot, cards, readiness, surface, currentCardId: null as string | null };
}

function runningChain(h: ReturnType<typeof harness>, leaf: string): void {
  let current: string | null = leaf;
  while (current !== null) { h.cards.setStatus(current, 'running'); current = cardParentId(current); }
  h.currentCardId = leaf;
}

async function submit(h: ReturnType<typeof harness>, name: string, args: unknown) {
  const before = cardBytes(h.projectRoot);
  const abandon = jest.spyOn(ConversationLLMActor.prototype, 'abandonParkedTurn');
  let turns = 0;
  const completeTurn = jest.fn(async (_input: LlmInvocationInput): Promise<ProviderTurnCompletion> => {
    if (++turns === 1) return { result: { kind: 'tool_calls', tool_calls: [{ id: 'admission-call', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, provider_exchanges: [] };
    // The failure/success is already paired before the next real provider entry.
    const history = readConversation(h.projectRoot, 'agent:analyst:global');
    expect(history.unmatchedCall).toBeNull();
    expect(history.sourceRows.filter((row) => row.kind === 'tool_result')).toHaveLength(1);
    return { result: { kind: 'message', content: 'continued normally' }, provider_exchanges: [] };
  });
  const session = new AnalystSession({
    cardTypeVocabulary: [...h.cards.workflows.cardTypes.keys()], fatalPort: testApplicationFatalPort, sessionId: 'agent:analyst:global', agentName: 'analyst',
    modelParams: { temperature: 0, maxTokens: 1000 }, capabilityRequest: { requiresTools: true, requiresExclusiveToolChoice: true },
    candidateChain: [{ provider: 'test', account: null, model: 'test-model' }], routeUsableInputTokens: 80_000,
    promptTemplates: { render: () => 'test analyst prompt' }, restartCapability: { available: false }, provider: scriptedAdmissionProvider(completeTurn),
    conversations: { projectRoot: h.projectRoot }, compactionPolicy: testCompactionPolicy,
    compactor: { shouldCompact: () => false, compact: () => Promise.reject(new Error('Unexpected compaction.')) }, summarizerProvider: unusedSummarizerProvider,
    cardStore: h.cards, runtimeCurrent: () => ({ status: 'paused', currentCardId: h.currentCardId }), runtimeProjectionChanged() {},
    createInvocationSurface: () => h.surface, shutdownProcesses: async () => {},
  });
  const response = await session.submit({ userContent: 'perform the requested card operation' });
  expect(completeTurn).toHaveBeenCalledTimes(2);
  expect(abandon).not.toHaveBeenCalled();
  expect(h.readiness).toHaveBeenCalledTimes(1);
  const invocation = response.toolInvocations![0]!;
  const rows = readConversation(h.projectRoot, 'agent:analyst:global').sourceRows;
  const result = rows.find((row) => row.kind === 'tool_result')!;
  expect(JSON.parse(result.content)).toEqual(invocation.result);
  expect(result.context_policy).toMatchObject({ settlement_origin: 'executed', evidence: { kind: 'none' } });
  const audits = readAppLogEntries(h.projectRoot, 'control_action').map((entry) => entry.data);
  expect(audits).toHaveLength(1);
  return { result: invocation.result, before, audits };
}

async function denied(h: ReturnType<typeof harness>, name: string, args: unknown, reason: string) {
  const observation = await submit(h, name, args);
  expect(observation.result).toMatchObject({ success: false, error: expect.stringContaining(reason) });
  expect(observation.audits[0]).toMatchObject({ outcome: 'denied', action: name === 'create_card' ? 'card.create' : 'card.delete' });
  expect(cardBytes(h.projectRoot)).toEqual(observation.before);
}

describe('Analyst card admission through real session continuation', () => {
  it('settles a running requested root denial while paused', async () => {
    const h = harness(); const card = create(h.cards); runningChain(h, card.id);
    await denied(h, 'delete_card', { ids: [card.id] }, `${card.id}' is running`);
  });

  it('settles a running nested descendant denial while paused', async () => {
    const h = harness(); const root = create(h.cards); const nested = create(h.cards, root.id); const leaf = create(h.cards, nested.id, 'code'); runningChain(h, leaf.id);
    // A valid paused running chain also has running ancestors. The first
    // blocked member is the root, but subtree admission reads the nested leaf.
    const descendants = jest.spyOn(h.cards, 'getDescendantIds');
    await denied(h, 'delete_card', { ids: [root.id] }, `${root.id}' is running`);
    expect(descendants).toHaveBeenCalledWith(root.id);
    expect(descendants.mock.results[0]!.value).toContain(leaf.id);
  });

  it('admits no prefix of a multi-root deletion when the later root is blocked', async () => {
    const h = harness(); const first = create(h.cards); const later = create(h.cards); runningChain(h, later.id);
    await denied(h, 'delete_card', { ids: [first.id, later.id] }, `${later.id}' is running`);
    expect(h.cards.read(first.id)).not.toBeNull();
  });

  it('checks the nested running predicate when the selected deletion root is nonrunning', async () => {
    const h = harness(); const root = create(h.cards); const nested = create(h.cards, root.id, 'code');
    // Canonical card folds permit this fixture. It deliberately isolates the
    // subtree precheck, not a valid Supervisor running chain (ancestors rest).
    h.cards.setStatus(nested.id, 'running'); h.currentCardId = nested.id;
    expect(h.cards.read(root.id)!.lifecycle.status).not.toBe('running');
    const deletion = jest.spyOn(h.cards, 'deleteSubtrees');
    // Session orientation correctly rejects this discontinuous topology before
    // a provider turn. Invoke its real bound tool directly to isolate admission.
    const before = cardBytes(h.projectRoot);
    const settlement = await invokeToolForLlm(h.surface, 'delete_card', { ids: [root.id] }, testLlmToolInvocationContext({ toolName: 'delete_card' }));
    expect(settlement.kind).toBe('executed');
    if (settlement.kind !== 'executed') throw new Error('Expected executed deletion denial.');
    expect(settlement.execution.providerOutcome).toMatchObject({ kind: 'failed', error: expect.stringContaining(`${nested.id}' is running`) });
    expect(readAppLogEntries(h.projectRoot, 'control_action').map((entry) => entry.data)).toMatchObject([{ action: 'card.delete', outcome: 'denied' }]);
    expect(readAppLogEntries(h.projectRoot, 'control_action')).toHaveLength(1);
    expect(cardBytes(h.projectRoot)).toEqual(before);
    expect(deletion).not.toHaveBeenCalled();
  });

  it.each(['project', 'card-missing'])('settles existing root/missing deletion admission: %s', async (id) => {
    await denied(harness(), 'delete_card', { ids: [id] }, id === 'project' ? 'root project card cannot be deleted' : 'does not exist');
  });

  it('settles missing create dependencies without namespace publication', async () => {
    await denied(harness(), 'create_card', { parent: 'project', type: 'code', title: 'new', bootstrap_content: 'Brief', depends_on: ['card-missing'] }, "dependency 'card-missing' does not exist");
  });

  it('rejects depth thirteen before running-parent and child-workflow admission', async () => {
    const h = harness(); const parent = chain(h.cards, 12, 'code'); runningChain(h, parent);
    await denied(h, 'create_card', { parent, type: 'goal', title: 'too deep', bootstrap_content: 'Brief' }, 'child depth exceeds 12');
  });

  it('rejects a nonleaf selected workflow at depth twelve', async () => {
    const h = harness(); const parent = chain(h.cards, 11);
    await denied(h, 'create_card', { parent, type: 'goal', title: 'nonleaf', bootstrap_content: 'Brief' }, 'must use a leaf card type');
  });

  it('performs ordinary parent status admission before the depth-twelve leaf check', async () => {
    const h = harness(); const parent = chain(h.cards, 11); runningChain(h, parent);
    await denied(h, 'create_card', { parent, type: 'goal', title: 'nonleaf', bootstrap_content: 'Brief' }, 'wrong_state');
  });

  it('performs parent child-type workflow admission before the depth-twelve leaf check', async () => {
    const h = harness(); const parent = chain(h.cards, 11, 'code');
    await denied(h, 'create_card', { parent, type: 'goal', title: 'nonleaf', bootstrap_content: 'Brief' }, "child type 'goal' is not permitted under 'code'");
  });

  it('creates a maximum-depth leaf with an existing nonsibling dependency', async () => {
    const h = harness(); const dependency = create(h.cards, 'project', 'code'); const parent = chain(h.cards, 11);
    const observation = await submit(h, 'create_card', { parent, type: 'code', title: 'maximum-depth leaf', bootstrap_content: 'Brief', depends_on: [dependency.id] });
    expect(observation.result).toMatchObject({ success: true });
    expect(observation.audits[0]).toMatchObject({ outcome: 'ok' });
    const child = h.cards.read(h.cards.listChildren(parent)[0]!)!;
    expect(child).toMatchObject({ title: 'maximum-depth leaf', depends_on: [dependency.id] });
    expect(child.id.split('-').length - 1).toBe(12);
  });

  it('allows ordinary deletion including overlapping roots', async () => {
    const h = harness(); const root = create(h.cards); const child = create(h.cards, root.id, 'code');
    const observation = await submit(h, 'delete_card', { ids: [root.id, child.id] });
    expect(observation.result).toMatchObject({ success: true, data: { deleted: expect.arrayContaining([root.id, child.id]) } });
    expect(observation.audits[0]).toMatchObject({ outcome: 'ok' });
    expect(h.cards.read(root.id)).toBeNull(); expect(h.cards.read(child.id)).toBeNull();
  });
});
