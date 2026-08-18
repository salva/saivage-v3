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
import { defineTool, executedProviderResult, OPERATIONAL_RESULT_POLICY_TEMPLATE, type InvocationSurface } from '../../src/tools/invocation.js';
import { readConversation } from '../../src/persistence/conversation-file.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { scriptedAdmissionProvider, testCompactionPolicy, unusedSummarizerProvider } from '../helpers/llm-test-helpers.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('Analyst project-context failure', () => {
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
      executor: async () => executedProviderResult('none', await execute()),
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
      promptTemplates: { render },
      restartServerAvailable: false,
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
    const render = jest.fn(() => 'x'.repeat(8_000));
    const completeTurn = jest.fn(async () => {
      throw new Error('provider must not run');
    });
    const execute = jest.fn(async () => ({ success: true as const, data: null }));
    const tool = defineTool({
      name: 'forbidden_tool',
      description: 'Must not run after failed static preparation.',
      resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE,
      inputSchema: z.object({}).strict(),
      executor: async () => executedProviderResult('none', await execute()),
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
      promptTemplates: { render },
      restartServerAvailable: false,
      provider: scriptedAdmissionProvider(completeTurn),
      conversations: { projectRoot },
      compactionPolicy: { input_budget_tokens: 1_000, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, merge_line_fraction: 0.3, summary_line_fraction: 0.5, escalate_merge_line_fraction: 0.4, escalate_summary_line_fraction: 0.6, snap: 'keep_straddler_verbatim' },
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

    await expect(session.submit({ userContent: 'inspect the project' })).rejects.toThrow(/does not fit the compaction budget/u);

    expect(readConversation(projectRoot, 'agent:analyst:global').sourceRows).toEqual([]);
    expect(render).toHaveBeenCalledTimes(1);
    expect(completeTurn).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(readAppLogEntries(projectRoot)).toEqual([]);
  });
});
