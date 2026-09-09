import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AnalystSession } from '../../src/agents/analyst-handler.js';
import type { CardService as CardServiceType } from '../../src/cards/card-api.js';
import type { InvocationSurface } from '../../src/tools/invocation.js';
import { CardService, initProjectTree } from '../helpers/canonical-project.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { contextContentSha256 } from '../../src/runtime/actors/context/context-blocks.js';
import { scriptedAdmissionProvider, testCompactionPolicy, unusedSummarizerProvider } from '../helpers/llm-test-helpers.js';
import { ANALYST_ORIENTATION_MAX_BYTES } from '../../src/application/read-models/analyst-orientation.js';

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

const runtimeCurrent = () => ({ status: 'stopped' as const, currentCardId: null });

function buildSession(projectRoot: string, cardStore: CardServiceType, completeTurn: ReturnType<typeof jest.fn>, render: ReturnType<typeof jest.fn>, surface: InvocationSurface = { agentName: 'analyst', tools: new Map(), providers: [] }): AnalystSession {
  return new AnalystSession({
    cardTypeVocabulary: ['project', 'goal'],
    sessionId: 'agent:analyst:global',
    agentName: 'analyst', modelParams: { temperature: 0, maxTokens: 1000 }, capabilityRequest: { requiresTools: true, requiresExclusiveToolChoice: true },
    candidateChain: [{ provider: 'test', account: null, model: 'test-model' }],
    promptTemplates: { render },
    restartCapability: { available: false },
    provider: scriptedAdmissionProvider(completeTurn),
    conversations: { projectRoot },
    compactionPolicy: testCompactionPolicy,
    compactor: { shouldCompact: () => false, compact: async () => { throw new Error('compaction must not run'); } },
    summarizerProvider: unusedSummarizerProvider,
    cardStore,
    runtimeCurrent,
    runtimeProjectionChanged() {},
    createInvocationSurface: () => surface,
    shutdownProcesses: async () => {},
    fatalPort: testApplicationFatalPort,
  });
}

describe('Analyst project context', () => {
  it('derives the bounded orientation snapshot from one validated list without per-card parent reads', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'analyst-project-context-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const persisted = new CardService(projectRoot);
    const child = persisted.create({ type: 'goal', parent: 'project', title: 'Child', bootstrap_content: 'brief', tags: [], priority: 1, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    const retained = persisted.create({ type: 'goal', parent: 'project', title: 'Retained tombstone', bootstrap_content: 'brief', tags: [], priority: 1, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    const second = persisted.create({ type: 'goal', parent: 'project', title: 'Second', bootstrap_content: 'brief', tags: [], priority: 1, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    persisted.deleteSubtrees([retained.id], () => true, 'analyst');
    persisted.reorderChildren('project', [second.id, child.id]);
    const listed = persisted.list();
    const list = jest.fn(() => listed);
    const getParent = jest.fn(() => { throw new Error('parent lookup must not run'); });
    const cardStore = { list, getParent } as unknown as CardServiceType;
    const providerInputs: unknown[] = [];
    const completeTurn = jest.fn(async (input: unknown) => {
      providerInputs.push(input);
      return { result: { kind: 'message' as const, content: 'done' }, provider_exchanges: [] };
    });
    const render = jest.fn(() => 'rendered prompt');

    await expect(buildSession(projectRoot, cardStore, completeTurn, render).submit({ userContent: 'inspect cards' })).resolves.toMatchObject({ sessionId: 'agent:analyst:global' });

    expect(list).toHaveBeenCalledTimes(1);
    expect(getParent).not.toHaveBeenCalled();
    const input = providerInputs[0] as { preparedContext: { dynamicBlocks: ReadonlyArray<{ id: string; content: string }> }; providerConversation: { messages: ReadonlyArray<{ kind: string; origin?: string; block_identity?: string; content: string }> } };
    const tree = input.preparedContext.dynamicBlocks[0]!;
    expect(tree.id).toBe('analyst.project_tree');
    expect(Buffer.byteLength(tree.content, 'utf8')).toBeLessThanOrEqual(ANALYST_ORIENTATION_MAX_BYTES);
    const snapshot = JSON.parse(tree.content) as { root: { id: string; children?: Array<{ id: string }> }; active_path: string[] };
    expect(snapshot.root.id).toBe('project');
    expect(snapshot.root.children?.map((node) => node.id)).toEqual([second.id, child.id]);
    expect(snapshot.active_path).toEqual([]);
    expect(input.providerConversation.messages.filter((item) => item.kind === 'synthetic_context' && item.origin === 'dynamic' && item.block_identity === tree.id && item.content === tree.content)).toHaveLength(1);
  });

  it('freezes the prepared invocation context with the project-tree dynamic block before ingress', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'analyst-prepared-context-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const persisted = new CardService(projectRoot);
    persisted.create({ type: 'goal', parent: 'project', title: 'Child', bootstrap_content: 'brief', tags: [], priority: 1, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    const render = jest.fn(() => 'rendered prompt');
    const providerInputs: unknown[] = [];
    const completeTurn = jest.fn(async (input: unknown) => {
      providerInputs.push(input);
      return { result: { kind: 'message' as const, content: 'done' }, provider_exchanges: [] };
    });

    await expect(buildSession(projectRoot, persisted, completeTurn, render).submit({ userContent: 'inspect cards' })).resolves.toMatchObject({ sessionId: 'agent:analyst:global' });

    const input = providerInputs[0] as { systemPrompt: string; providerConversation: { messages: ReadonlyArray<{ kind: string; origin?: string; block_identity?: string; content: string }> }; preparedContext: { prefix: { instructionText: string; terminalToolNames: readonly string[]; immutablePrefixSha256: string }; dynamicBlocks: ReadonlyArray<{ id: string; content: string; storage: string; replacement: { kind: string; key: string; contentSha256: string } }>; preparedCompaction: unknown; internalToolContractSha256: string } };
    expect(input.systemPrompt).toBe('rendered prompt');
    expect(input.preparedContext.prefix.instructionText).toBe('rendered prompt');
    expect(input.preparedContext.prefix.terminalToolNames).toEqual([]);
    expect(input.preparedContext.prefix.immutablePrefixSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(input.preparedContext.internalToolContractSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(input.preparedContext.dynamicBlocks).toHaveLength(1);
    const tree = input.preparedContext.dynamicBlocks[0]!;
    expect(tree.id).toBe('analyst.project_tree');
    expect(tree.storage).toBe('activation_local');
    expect(tree.replacement.kind).toBe('latest_snapshot');
    expect(tree.replacement.key).toBe('analyst.project_tree');
    expect(tree.replacement.contentSha256).toBe(contextContentSha256(tree.content));
    expect(input.providerConversation.messages.filter((item) => item.kind === 'synthetic_context' && item.block_identity === tree.id && item.content === tree.content)).toHaveLength(1);
  });
});
