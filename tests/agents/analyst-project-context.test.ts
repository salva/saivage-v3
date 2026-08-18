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

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('Analyst project context', () => {
  it('derives parent values from one validated list without per-card parent reads', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'analyst-project-context-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const persisted = new CardService(projectRoot);
    const child = persisted.create({ type: 'goal', parent: 'project', title: 'Child', bootstrap_content: 'brief', tags: [], priority: 1, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    const listed = persisted.list();
    const list = jest.fn(() => listed);
    const getParent = jest.fn(() => { throw new Error('parent lookup must not run'); });
    const cardStore = { list, getParent } as unknown as CardServiceType;
    let projectContext = '';
    const render = jest.fn((_host: {kind:string}, _agent: string, variables: Record<string, string>) => {
      projectContext = variables.projectContext!;
      return 'rendered prompt';
    });
    const completeTurn = jest.fn(async () => ({ result: { kind: 'message' as const, content: 'done' }, provider_exchanges: [] }));
    const surface: InvocationSurface = { agentName: 'analyst', tools: new Map(), providers: [] };
    const session = new AnalystSession({
      cardTypeVocabulary: ['project','goal','architecture','code','test','doc','data','research','ops'],
      projectRoot,
      sessionId: 'agent:analyst:global',
      agentName: 'analyst', modelParams: { temperature: 0, maxTokens: 1000 }, capabilityRequest: { requiresTools: true, requiresExclusiveToolChoice: true },
      candidateChain: [{ provider: 'test', account: null, model: 'test-model' }],
      promptTemplates: { render },
      restartServerAvailable: false,
      provider: scriptedAdmissionProvider(completeTurn),
      conversations: { projectRoot },
      compactionPolicy: testCompactionPolicy,
      compactor: { shouldCompact: () => false, compact: async () => { throw new Error('compaction must not run'); } },
      summarizerProvider: unusedSummarizerProvider,
      cardStore,
      runtimeProjectionChanged() {},
      createInvocationSurface: () => surface,
      shutdownProcesses: async () => {},
      fatalPort: testApplicationFatalPort,
    });

    await expect(session.submit({ userContent: 'inspect cards' })).resolves.toMatchObject({ sessionId: 'agent:analyst:global' });

    expect(list).toHaveBeenCalledTimes(1);
    expect(getParent).not.toHaveBeenCalled();
    const context = JSON.parse(projectContext) as { cards: Array<{ id: string; parent: string | null }> };
    expect(context.cards.find((card) => card.id === 'project')?.parent).toBeNull();
    expect(context.cards.find((card) => card.id === child.id)?.parent).toBe('project');
  });

  it('freezes the prepared invocation context with the project-tree dynamic block before ingress', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'analyst-prepared-context-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const persisted = new CardService(projectRoot);
    persisted.create({ type: 'goal', parent: 'project', title: 'Child', bootstrap_content: 'brief', tags: [], priority: 1, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    let projectContext = '';
    const render = jest.fn((_host: {kind:string}, _agent: string, variables: Record<string, string>) => {
      projectContext = variables.projectContext!;
      return 'rendered prompt';
    });
    const providerInputs: unknown[] = [];
    const completeTurn = jest.fn(async (input: unknown) => {
      providerInputs.push(input);
      return { result: { kind: 'message' as const, content: 'done' }, provider_exchanges: [] };
    });
    const surface: InvocationSurface = { agentName: 'analyst', tools: new Map(), providers: [] };
    const session = new AnalystSession({
      cardTypeVocabulary: ['project','goal'],
      projectRoot,
      sessionId: 'agent:analyst:global',
      agentName: 'analyst', modelParams: { temperature: 0, maxTokens: 1000 }, capabilityRequest: { requiresTools: true, requiresExclusiveToolChoice: true },
      candidateChain: [{ provider: 'test', account: null, model: 'test-model' }],
      promptTemplates: { render },
      restartServerAvailable: false,
      provider: scriptedAdmissionProvider(completeTurn),
      conversations: { projectRoot },
      compactionPolicy: testCompactionPolicy,
      compactor: { shouldCompact: () => false, compact: async () => { throw new Error('compaction must not run'); } },
      summarizerProvider: unusedSummarizerProvider,
      cardStore: persisted,
      runtimeProjectionChanged() {},
      createInvocationSurface: () => surface,
      shutdownProcesses: async () => {},
      fatalPort: testApplicationFatalPort,
    });

    await expect(session.submit({ userContent: 'inspect cards' })).resolves.toMatchObject({ sessionId: 'agent:analyst:global' });

    const input = providerInputs[0] as { systemPrompt: string; preparedContext: { prefix: { instructionText: string; terminalToolNames: readonly string[]; immutablePrefixSha256: string }; dynamicBlocks: ReadonlyArray<{ id: string; content: string; storage: string; replacement: { kind: string; key: string; contentSha256: string } }>; preparedCompaction: unknown; internalToolContractSha256: string } };
    expect(input.systemPrompt).toBe('rendered prompt');
    expect(input.preparedContext.prefix.instructionText).toBe('rendered prompt');
    expect(input.preparedContext.prefix.terminalToolNames).toEqual([]);
    expect(input.preparedContext.prefix.immutablePrefixSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(input.preparedContext.internalToolContractSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(input.preparedContext.dynamicBlocks).toHaveLength(1);
    const tree = input.preparedContext.dynamicBlocks[0]!;
    expect(tree.id).toBe('analyst.project_tree');
    expect(tree.content).toBe(projectContext);
    expect(tree.storage).toBe('activation_local');
    expect(tree.replacement.kind).toBe('latest_snapshot');
    expect(tree.replacement.key).toBe('analyst.project_tree');
    expect(tree.replacement.contentSha256).toBe(contextContentSha256(tree.content));
  });
});
