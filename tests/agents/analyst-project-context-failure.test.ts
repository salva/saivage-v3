import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { AnalystSession } from '../../src/agents/analyst-handler.js';
import type { CardService } from '../../src/cards/card-api.js';
import { readAppLogEntries } from '../../src/persistence/app-log.js';
import { appLogFile, globalAgentConversationVersionIndexFile } from '../../src/persistence/layout.js';
import { defineTool, type InvocationSurface } from '../../src/tools/invocation.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { testCompactionPolicy, unusedSummarizerProvider } from '../helpers/llm-test-helpers.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';
import { actorProvider } from '../helpers/actor-provider.js';

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
      inputSchema: z.object({}).strict(),
      executor: execute,
    });
    const surface: InvocationSurface = {
      agentName: 'analyst',
      tools: new Map([[tool.name, tool]]),
      providers: [],
    };
    const session = new AnalystSession({
      cardTypeVocabulary: ['project','goal','architecture','code','test','doc','data','research','ops'],
      projectRoot,
      sessionId: 'agent:analyst:global',
      agentName: 'analyst', modelParams: { temperature: 0, maxTokens: 1000 }, capabilityRequest: { requiresTools: true, requiresExclusiveToolChoice: true },
      candidateChain: [{ provider: 'test', account: null, model: 'test-model' }],
      promptTemplates: { render },
      restartServerAvailable: false,
      provider: actorProvider(completeTurn),
      conversations: { projectRoot },
      compactionPolicy: testCompactionPolicy,
      compactor: {
        shouldCompact: () => false,
        compact: async () => { throw new Error('compaction must not run'); },
      },
      summarizerProvider: unusedSummarizerProvider,
      cardStore,
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
});
