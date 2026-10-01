import { afterEach, describe, expect, it, jest } from '@jest/globals';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Instrument real fixture I/O, without replacing the mutation owners. Hooks
// model cancellation after a known file effect and uncertain audit publication.
let afterFileWrite: (() => void) | undefined;
let beforeAppend: (() => void) | undefined;
let fileWrites = 0;
let appendAttempts = 0;
jest.unstable_mockModule('node:fs', () => ({
  ...fs,
  writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
    fs.writeFileSync(...args); fileWrites++; afterFileWrite?.();
  },
  writeSync: (...args: any[]) => {
    appendAttempts++; beforeAppend?.();
    return (fs.writeSync as (...args: any[]) => number)(...args);
  },
}));

const { CardService, initProjectTree, testAnalystMutationServices } = await import('../helpers/canonical-project.js');
const { analystWorkspaceToolBinders, globalWorkspaceObservationToolBinders } = await import('../../src/tools/workspace-provider.js');
const { analystCardToolBinders } = await import('../../src/tools/analyst-card-tools.js');
const { bindToolProvider } = await import('../helpers/bind-tool-provider.js');
const { buildInvocationSurfaceFixture } = await import('../helpers/invocation-surface-fixture.js');
const { testLlmToolInvocationContext, scriptedAdmissionProvider, testCompactionPolicy, unusedSummarizerProvider } = await import('../helpers/llm-test-helpers.js');
const { invokeToolForLlm, llmToolDefinition } = await import('../../src/tools/invocation.js');
const { compileInvocationToolContract } = await import('../../src/runtime/actors/context/context-blocks.js');
const { settleToolResultForConversation } = await import('../../src/runtime/actors/llm-delivery-log.js');
const { readAppLogEntries } = await import('../../src/persistence/app-log.js');
const { PublicationOutcomeUnknownError, AnalystInterventionNotReadyError } = await import('../../src/contracts/index.js');
const { AnalystSession } = await import('../../src/runtime/actors/analyst-session.js');
const { testApplicationFatalPort } = await import('../helpers/test-application-fatal-port.js');
const { workflowResult } = await import('../helpers/workflow-result.js');
import type { ToolContext } from '../../src/tools/analyst-tool-types.js';
import type { ProviderTurnCompletion } from '../../src/contracts/index.js';

const roots: string[] = [];
afterEach(() => {
  afterFileWrite = undefined; beforeAppend = undefined; jest.restoreAllMocks();
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function harness(notify = jest.fn(() => ({ ok: true as const, notificationId: 'fixture' }))) {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), 'analyst-mutation-effects-')); roots.push(projectRoot); initProjectTree(projectRoot);
  const cards = new CardService(projectRoot);
  const readiness = jest.fn();
  const context = {
    projectRoot, actor: 'analyst', surface: 'web-chat', sessionId: 'agent:analyst:global', store: cards,
    cardTypeVocabulary: [...cards.workflows.cardTypes.keys()],
    interventionReadiness: { assertInterventionReady: readiness },
    runtime: { notifyCard: notify }, analystMutations: testAnalystMutationServices(projectRoot, cards, notify),
  } as unknown as ToolContext;
  const surface = buildInvocationSurfaceFixture('analyst', [bindToolProvider('workspace', analystWorkspaceToolBinders, context), bindToolProvider('cards', analystCardToolBinders, context)]);
  async function invoke(name: string, args: unknown, signal?: AbortSignal) {
    const settlement = await invokeToolForLlm(surface, name, args, testLlmToolInvocationContext({ toolName: name }), signal);
    const definition = surface.tools.get(name)!;
    return settleToolResultForConversation(name, compileInvocationToolContract(llmToolDefinition(definition), definition.resultPolicyTemplate), settlement).providerResult;
  }
  return { projectRoot, cards, readiness, notify, surface, invoke, audits: () => readAppLogEntries(projectRoot, 'control_action').map((entry) => entry.data) };
}

describe('Analyst non-record editor audit', () => {
  it('writes and edits during a real running-session turn, without readiness and without content in audit summaries', async () => {
    const h = harness(); h.cards.setStatus('project', 'running');
    h.readiness.mockImplementation(() => { throw new Error('must not request intervention readiness'); });
    let turn = 0;
    const completeTurn = jest.fn(async (): Promise<ProviderTurnCompletion> => {
      turn++;
      if (turn <= 2) return { result: { kind: 'tool_calls', tool_calls: [{ id: `file-${turn}`, type: 'function', function: { name: turn === 1 ? 'write' : 'edit', arguments: JSON.stringify(turn === 1 ? { path: 'example.txt', content: 'private-before' } : { path: 'example.txt', old_string: 'private-before', new_string: 'private-after', replace_all: true }) } }] }, provider_exchanges: [] };
      return { result: { kind: 'message', content: 'edited' }, provider_exchanges: [] };
    });
    const session = new AnalystSession({
      cardTypeVocabulary: [...h.cards.workflows.cardTypes.keys()], fatalPort: testApplicationFatalPort, sessionId: 'agent:analyst:global', agentName: 'analyst',
      modelParams: { temperature: 0, maxTokens: 1000 }, capabilityRequest: { requiresTools: true, requiresExclusiveToolChoice: true },
      candidateChain: [{ provider: 'test', account: null, model: 'test-model' }], routeUsableInputTokens: 80_000,
      promptTemplates: { render: () => 'test' }, restartCapability: { available: false }, provider: scriptedAdmissionProvider(completeTurn),
      conversations: { projectRoot: h.projectRoot }, compactionPolicy: testCompactionPolicy,
      compactor: { shouldCompact: () => false, compact: () => Promise.reject(new Error('Unexpected compaction')) }, summarizerProvider: unusedSummarizerProvider,
      cardStore: h.cards, runtimeCurrent: () => ({ status: 'running', currentCardId: 'project' }), runtimeProjectionChanged() {},
      createInvocationSurface: () => h.surface, shutdownProcesses: async () => {},
    });
    const response = await session.submit({ userContent: 'edit file' });
    expect(response.toolInvocations!.map((invocation) => invocation.result.success)).toEqual([true, true]);
    expect(completeTurn).toHaveBeenCalledTimes(3);
    expect(fs.readFileSync(join(h.projectRoot, 'example.txt'), 'utf8')).toBe('private-after');
    expect(h.readiness).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.audits()).toMatchObject([
      { action: 'workspace.write', outcome: 'ok', target_kind: null, target_id: 'example.txt', safety_class: 'low', params_summary: '{"path":"example.txt"}' },
      { action: 'workspace.edit', outcome: 'ok', target_kind: null, target_id: 'example.txt', params_summary: '{"path":"example.txt","replace_all":true}' },
    ]);
    expect(JSON.stringify(h.audits())).not.toMatch(/private-before|private-after/);
  });

  it.each(['project', 'system'])('preserves supported scoped routing and one audit per operation: %s', async (scheme) => {
    const h = harness();
    const relative = 'scoped.txt';
    const path = scheme === 'system' ? `system:///${join(h.projectRoot, relative).replace(/^\/+/, '')}` : 'project:///scoped.txt';
    expect(await h.invoke('write', { path, content: 'before' })).toMatchObject({ success: true });
    expect(await h.invoke('edit', { path, old_string: 'before', new_string: 'after' })).toMatchObject({ success: true });
    expect(fs.readFileSync(join(h.projectRoot, relative), 'utf8')).toBe('after');
    expect(h.audits().map((entry) => [entry.action, entry.outcome, entry.target_id])).toEqual([['workspace.write', 'ok', path], ['workspace.edit', 'ok', path]]);
    expect(h.readiness).not.toHaveBeenCalled();
  });

  it('settles expected invalid path and absent edit text failures as errors without mutation', async () => {
    const h = harness(); fs.writeFileSync(join(h.projectRoot, 'existing.txt'), 'unchanged');
    const before = fileWrites;
    expect(await h.invoke('write', { path: '../outside.txt', content: 'blocked' })).toMatchObject({ success: false });
    // Global Analyst has no current-card tmp authority; audit must preserve that
    // existing routing permission rather than confer a card scope.
    expect(await h.invoke('write', { path: 'tmp:///project/scoped.txt', content: 'blocked' })).toMatchObject({ success: false });
    expect(await h.invoke('edit', { path: 'existing.txt', old_string: 'absent', new_string: 'changed' })).toMatchObject({ success: false });
    expect(fileWrites).toBe(before);
    expect(fs.readFileSync(join(h.projectRoot, 'existing.txt'), 'utf8')).toBe('unchanged');
    expect(h.audits().map((entry) => entry.outcome)).toEqual(['error', 'error', 'error']);
    expect(h.readiness).not.toHaveBeenCalled();
  });

  it.each(['write', 'edit'])('pre-entry cancellation of %s has no effect or audit', async (name) => {
    const h = harness(); fs.writeFileSync(join(h.projectRoot, 'existing.txt'), 'before');
    const abort = new AbortController(); abort.abort(); const before = fileWrites;
    const args = name === 'write' ? { path: 'existing.txt', content: 'after' } : { path: 'existing.txt', old_string: 'before', new_string: 'after' };
    expect(await h.invoke(name, args, abort.signal)).toMatchObject({ success: false });
    expect(fileWrites).toBe(before); expect(h.audits()).toEqual([]);
    expect(fs.readFileSync(join(h.projectRoot, 'existing.txt'), 'utf8')).toBe('before');
  });

  it.each(['write', 'edit'])('preserves known %s success when cancellation arrives after the effect', async (name) => {
    const h = harness(); fs.writeFileSync(join(h.projectRoot, 'known.txt'), 'before');
    const abort = new AbortController(); afterFileWrite = () => abort.abort();
    const args = name === 'write' ? { path: 'known.txt', content: 'applied' } : { path: 'known.txt', old_string: 'before', new_string: 'applied' };
    expect(await h.invoke(name, args, abort.signal)).toMatchObject({ success: true });
    expect(h.audits()).toMatchObject([{ outcome: 'ok' }]);
    expect(fs.readFileSync(join(h.projectRoot, 'known.txt'), 'utf8')).toBe('applied');
  });

  it.each(['write', 'edit'])('%s propagates file publication uncertainty without audit or replay', async (name) => {
    const h = harness(); fs.writeFileSync(join(h.projectRoot, 'existing.txt'), 'before');
    const unknown = new PublicationOutcomeUnknownError();
    afterFileWrite = () => { throw unknown; };
    const beforeWrites = fileWrites; const beforeAppends = appendAttempts;
    const args = name === 'write' ? { path: 'existing.txt', content: 'after' } : { path: 'existing.txt', old_string: 'before', new_string: 'after' };
    await expect(h.invoke(name, args)).rejects.toBe(unknown);
    expect(fileWrites - beforeWrites).toBe(1); expect(appendAttempts).toBe(beforeAppends);
    expect(h.audits()).toEqual([]); expect(h.readiness).not.toHaveBeenCalled();
  });

  it('audits an unexpected file-owner exception once and preserves the exception', async () => {
    const h = harness(); const unexpected = new Error('unexpected file-owner fault');
    afterFileWrite = () => { throw unexpected; }; const before = fileWrites;
    await expect(h.invoke('write', { path: 'existing.txt', content: 'applied' })).rejects.toBe(unexpected);
    expect(fileWrites - before).toBe(1); expect(h.audits()).toMatchObject([{ outcome: 'error', error: unexpected.message }]);
    expect(h.audits()).toHaveLength(1);
  });

  it.each(['write', 'edit'])('does not repeat %s or append another audit after uncertain audit publication', async (name) => {
    const h = harness(); fs.writeFileSync(join(h.projectRoot, 'existing.txt'), 'before');
    // Establish the canonical append target so the fault is at append, not a
    // known pre-publication failure writing a first-publication temporary.
    await h.invoke('write', { path: 'seed.txt', content: 'seed audit' });
    const beforeWrites = fileWrites; const beforeAppends = appendAttempts;
    beforeAppend = () => { throw new Error('audit I/O failed'); };
    const args = name === 'write' ? { path: 'existing.txt', content: 'after' } : { path: 'existing.txt', old_string: 'before', new_string: 'after' };
    await expect(h.invoke(name, args)).rejects.toBeInstanceOf(PublicationOutcomeUnknownError);
    expect(fileWrites - beforeWrites).toBe(1); expect(appendAttempts - beforeAppends).toBe(1);
    beforeAppend = undefined;
    // Test-only fresh observation, never follow-up in the uncertain owner.
    expect(fs.readFileSync(join(h.projectRoot, 'existing.txt'), 'utf8')).toBe('after');
  });

  it.each(['write', 'edit'])('retains record %s intervention readiness denial', async (name) => {
    const h = harness(); const before = h.cards.readRecordCurrent('project', 'brief.md');
    h.readiness.mockImplementation(() => { throw new AnalystInterventionNotReadyError(); });
    const args = name === 'write' ? { path: 'record:///brief.md?card=project', content: 'changed' } : { path: 'record:///brief.md?card=project', old_string: 'x', new_string: 'y' };
    expect(await h.invoke(name, args)).toMatchObject({ success: false, data: { code: 'intervention_not_ready' } });
    expect(h.readiness).toHaveBeenCalledTimes(1); expect(h.audits()).toMatchObject([{ action: `record.${name}`, outcome: 'denied' }]);
    expect(h.cards.readRecordCurrent('project', 'brief.md')).toEqual(before);
  });

  it('preserves named shared observation composition and Analyst binding order', () => {
    expect(analystWorkspaceToolBinders.map((binder) => binder.name)).toEqual(['read', 'write', 'edit', 'glob', 'grep']);
    expect(globalWorkspaceObservationToolBinders.map((binder) => binder.name)).toEqual(['read', 'glob', 'grep']);
    for (const observation of globalWorkspaceObservationToolBinders) expect(analystWorkspaceToolBinders).toContain(observation);
  });
});

function create(cards: InstanceType<typeof CardService>, parent = 'project') {
  return cards.create({ parent, type: 'goal', title: 'fixture', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
}

function completeProject(cards: InstanceType<typeof CardService>) {
  cards.setStatus('project', 'running');
  cards.commitActivationOutcome('project', { status: 'done', summary: 'done', result: workflowResult('DONE', 'done') }, '2026-10-01T00:00:00.000Z');
}

describe('Analyst known card effects and best-effort propagation', () => {
  function operation(name: 'create_card' | 'cancel_card' | 'reorder_child', h: ReturnType<typeof harness>) {
    const parent = create(h.cards); const first = create(h.cards, parent.id); const second = create(h.cards, parent.id);
    // The main operation is admitted; propagation has a known resting ancestor
    // status effect before its notification throws (or succeeds).
    completeProject(h.cards);
    const args = name === 'create_card' ? { parent: parent.id, type: 'goal', title: 'created', bootstrap_content: 'Brief' }
      : name === 'cancel_card' ? { cardId: first.id, reason: 'requested' }
      : { parentId: parent.id, orderedChildIds: [second.id, first.id] };
    function applied() {
      if (name === 'create_card') expect(h.cards.listChildren(parent.id)).toHaveLength(3);
      else if (name === 'cancel_card') expect(h.cards.read(first.id)!.lifecycle.status).toBe('cancelled');
      else expect(h.cards.listChildren(parent.id)).toEqual([second.id, first.id]);
      expect(h.cards.read('project')!.lifecycle.status).toBe('changed');
    }
    return { args, applied };
  }

  it.each(['create_card', 'cancel_card', 'reorder_child'] as const)('%s reports partial failure after known effects and audits the main success', async (name) => {
    const h = harness(); const fixture = operation(name, h);
    h.notify.mockImplementation(() => { expect(h.cards.read('project')!.lifecycle.status).toBe('changed'); throw new Error('notification failed'); });
    expect(await h.invoke(name, fixture.args)).toMatchObject({ success: true, data: { propagation: { ok: false, partial: true, error: 'notification failed' } } });
    fixture.applied(); expect(h.notify).toHaveBeenCalledTimes(1); expect(h.audits()).toMatchObject([{ outcome: 'ok' }]);
  });

  it.each(['create_card', 'cancel_card', 'reorder_child'] as const)('%s reports successful propagation', async (name) => {
    const h = harness(); const fixture = operation(name, h);
    expect(await h.invoke(name, fixture.args)).toMatchObject({ success: true, data: { propagation: { ok: true } } });
    fixture.applied(); expect(h.notify).toHaveBeenCalledTimes(1); expect(h.audits()).toMatchObject([{ outcome: 'ok' }]);
  });

  it('no-op reorder neither propagates nor reports propagation', async () => {
    const h = harness(); const child = create(h.cards); completeProject(h.cards);
    const status = jest.spyOn(h.cards, 'setStatus');
    expect(await h.invoke('reorder_child', { parentId: 'project', orderedChildIds: [child.id] })).toEqual({ success: true, data: { parent_id: 'project', changed: 0 } });
    expect(status).not.toHaveBeenCalled(); expect(h.notify).not.toHaveBeenCalled();
    expect(h.cards.read('project')!.lifecycle.status).toBe('done');
  });

  it.each(['create_card', 'cancel_card', 'reorder_child'] as const)('%s rethrows identical publication uncertainty without audit or follow-up', async (name) => {
    const h = harness(); const fixture = operation(name, h); const unknown = new PublicationOutcomeUnknownError();
    const reads = jest.spyOn(h.cards, 'read'); const statuses = jest.spyOn(h.cards, 'setStatus');
    const ancestors = jest.spyOn(h.cards, 'getAncestors'); const children = jest.spyOn(h.cards, 'listChildren');
    let counts: number[] = []; let appends = 0;
    h.notify.mockImplementation(() => {
      counts = [reads.mock.calls.length, statuses.mock.calls.length, ancestors.mock.calls.length, children.mock.calls.length];
      appends = appendAttempts; throw unknown;
    });
    await expect(h.invoke(name, fixture.args)).rejects.toBe(unknown);
    expect([reads.mock.calls.length, statuses.mock.calls.length, ancestors.mock.calls.length, children.mock.calls.length]).toEqual(counts);
    expect(appendAttempts).toBe(appends); expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.audits()).toEqual([]);
    // Separate fixture observer can inspect known effects after the failed call.
    fixture.applied();
  });
});
