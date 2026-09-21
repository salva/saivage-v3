import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { AnalystSession } from '../../src/agents/analyst-handler.js';
import type { CardService } from '../../src/cards/card-api.js';
import { CardService as CompiledCardService, initProjectTree } from '../helpers/canonical-project.js';
import { readAppLogEntries } from '../../src/persistence/app-log.js';
import { appLogFile, globalAgentConversationVersionIndexFile } from '../../src/persistence/layout.js';
import { defineTool, executedToolOutcome, OPERATIONAL_RESULT_POLICY_TEMPLATE, type InvocationSurface } from '../../src/tools/invocation.js';
import { toolSucceeded } from '../../src/contracts/tool-result.js';
import { readConversation } from '../../src/persistence/conversation-file.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { scriptedAdmissionProvider, testCompactionPolicy, unusedSummarizerProvider } from '../helpers/llm-test-helpers.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';
import { SummaryPromptPolicyBlockedError } from '../../src/runtime/actors/compaction/summarizer.js';
import { COMPACTION_SUMMARY_BLOCKED_SUMMARY } from '../../src/schemas/index.js';
import type { CompactorPort } from '../../src/runtime/actors/llm-actor.js';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('Analyst project-context failure', () => {
  it('settles a summary prompt-policy block as a safe notice and reuses the retained owner for a new submission', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'analyst-summary-policy-block-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const completeTurn = jest.fn(async () => ({ result: { kind: 'message' as const, content: 'fresh submission succeeded' }, provider_exchanges: [] }));
    const compact = jest.fn<CompactorPort['compact']>()
      .mockRejectedValueOnce(new SummaryPromptPolicyBlockedError('00000000-0000-4000-8000-000000000099', new Error('RAW PROVIDER FLAG')))
      .mockImplementationOnce(async ({ input }) => ({ kind: 'compacted' as const, providerConversation: input.providerConversation, estimatedProviderMessageTokens: 1 }));
    const surface: InvocationSurface = { agentName: 'analyst', tools: new Map(), providers: [] };
    const session = new AnalystSession({
      cardTypeVocabulary: ['project'], sessionId: 'agent:analyst:global', agentName: 'analyst', modelParams: { temperature: 0, maxTokens: 1000 }, capabilityRequest: {},
      candidateChain: [{ provider: 'test', account: null, model: 'test-model' }], routeUsableInputTokens: 80_000,
      promptTemplates: { render: () => 'Analyst' }, restartCapability: { available: false }, provider: scriptedAdmissionProvider(completeTurn), conversations: { projectRoot }, compactionPolicy: testCompactionPolicy,
      compactor: { shouldCompact: () => true, compact }, summarizerProvider: unusedSummarizerProvider, cardStore: new CompiledCardService(projectRoot), runtimeCurrent: () => ({ status: 'stopped' as const, currentCardId: null }), runtimeProjectionChanged() {}, createInvocationSurface: () => surface, shutdownProcesses: async () => {}, fatalPort: testApplicationFatalPort,
    });

    await expect(session.submit({ userContent: 'first explicit submission' })).resolves.toMatchObject({ sessionId: 'agent:analyst:global' });
    expect(completeTurn).not.toHaveBeenCalled();
    const afterBlock = readConversation(projectRoot, 'agent:analyst:global').sourceRows;
    expect(afterBlock.some((row) => row.content === `Analyst LLM unavailable: ${COMPACTION_SUMMARY_BLOCKED_SUMMARY}`)).toBe(true);
    expect(afterBlock.some((row) => row.content.includes('RAW PROVIDER FLAG'))).toBe(false);

    await expect(session.submit({ userContent: 'second new explicit submission' })).resolves.toMatchObject({ sessionId: 'agent:analyst:global' });
    expect(compact).toHaveBeenCalledTimes(2);
    expect(completeTurn).toHaveBeenCalledTimes(1);
    expect(readConversation(projectRoot, 'agent:analyst:global').sourceRows.some((row) => row.content === 'fresh submission succeeded')).toBe(true);
  });

  it('rejects with the original error before prompt, ingress, diagnostic, provider, or tool effects and poisons the session', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'analyst-project-context-failure-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);

    const sentinel = new Error('project context sentinel');
    const list = jest.fn(() => { throw sentinel; });
    const cardStore = {
      list,
      getParent: jest.fn(() => { throw new Error('parent lookup must not run'); }),
    } as unknown as CardService;
    const render = jest.fn(() => 'rendered prompt');
    const completeTurn = jest.fn(async () => {
      throw new Error('provider must not run');
    });
    const execute = jest.fn(async () => ({ success: true as const, data: null }));
    const tool = defineTool({
      name: 'forbidden_tool',
      description: 'Must not run after failed project-context construction.',
      resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE,
      inputSchema: z.object({}).strict(),
       executor: async () => executedToolOutcome('none', toolSucceeded((await execute()).data)),
    });
    const surface: InvocationSurface = {
      agentName: 'analyst',
      tools: new Map([[tool.name, tool]]),
      providers: [],
    };
    const session = new AnalystSession({
      cardTypeVocabulary: ['project','goal','architecture','code','test','doc','data','research','ops'],
      sessionId: 'agent:analyst:global',
      agentName: 'analyst', modelParams: { temperature: 0, maxTokens: 1000 }, capabilityRequest: { requiresTools: true, requiresExclusiveToolChoice: true },
      candidateChain: [{ provider: 'test', account: null, model: 'test-model' }],
      routeUsableInputTokens: 80_000,
      promptTemplates: { render },
      restartCapability: { available: false },
      provider: scriptedAdmissionProvider(completeTurn),
      conversations: { projectRoot },
      compactionPolicy: testCompactionPolicy,
      compactor: {
        shouldCompact: () => false,
        compact: async () => { throw new Error('compaction must not run'); },
      },
      summarizerProvider: unusedSummarizerProvider,
      cardStore,
      runtimeCurrent: () => { throw new Error('runtime observation must not run'); },
      runtimeProjectionChanged() {},
      createInvocationSurface: () => surface,
      shutdownProcesses: async () => {},
      fatalPort: testApplicationFatalPort,
    });

    await expect(session.submit({ userContent: 'inspect the project' })).rejects.toBe(sentinel);

    expect(list).toHaveBeenCalledTimes(1);
    expect(render).not.toHaveBeenCalled();
    expect(completeTurn).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(existsSync(globalAgentConversationVersionIndexFile(projectRoot, 'analyst'))).toBe(true);
    expect(existsSync(appLogFile(projectRoot))).toBe(false);
    expect(readAppLogEntries(projectRoot)).toEqual([]);

    await expect(session.submit({ userContent: 'try again' })).rejects.toBe(sentinel);
    expect(list).toHaveBeenCalledTimes(1);
    expect(render).not.toHaveBeenCalled();
    expect(completeTurn).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a static capacity failure after surface binding with zero durable ingress rows', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'analyst-static-capacity-failure-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);

    const cardStore = new CompiledCardService(projectRoot);
    const render = jest.fn(() => 'x'.repeat(32_000));
    const completeTurn = jest.fn(async () => {
      throw new Error('provider must not run');
    });
    const execute = jest.fn(async () => ({ success: true as const, data: null }));
    const tool = defineTool({
      name: 'forbidden_tool',
      description: 'Must not run after failed static preparation.',
      resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE,
      inputSchema: z.object({}).strict(),
       executor: async () => executedToolOutcome('none', toolSucceeded((await execute()).data)),
    });
    const surface: InvocationSurface = {
      agentName: 'analyst',
      tools: new Map([[tool.name, tool]]),
      providers: [],
    };
    const session = new AnalystSession({
      cardTypeVocabulary: ['project'],
      sessionId: 'agent:analyst:global',
      agentName: 'analyst', modelParams: { temperature: 0, maxTokens: 100 }, capabilityRequest: { requiresTools: true, requiresExclusiveToolChoice: true },
      candidateChain: [{ provider: 'test', account: null, model: 'test-model' }],
      routeUsableInputTokens: 5_000,
      promptTemplates: { render },
      restartCapability: { available: false },
      provider: scriptedAdmissionProvider(completeTurn),
      conversations: { projectRoot },
      compactionPolicy: { context_utilization_fraction: 0.8, trigger_fraction: 0.8, tail_fraction: 0.25, snap: 'keep_straddler_verbatim' },
      compactor: {
        shouldCompact: () => false,
        compact: async () => { throw new Error('compaction must not run'); },
      },
      summarizerProvider: unusedSummarizerProvider,
      cardStore,
      runtimeCurrent: () => ({ status: 'stopped' as const, currentCardId: null }),
      runtimeProjectionChanged() {},
      createInvocationSurface: () => surface,
      shutdownProcesses: async () => {},
      fatalPort: testApplicationFatalPort,
    });

    await expect(session.submit({ userContent: 'inspect the project' })).rejects.toThrow(/does not fit the route usable-input capacity/u);

    expect(readConversation(projectRoot, 'agent:analyst:global').sourceRows).toEqual([]);
    expect(render).toHaveBeenCalledTimes(1);
    expect(completeTurn).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(readAppLogEntries(projectRoot)).toEqual([]);
  });
});
