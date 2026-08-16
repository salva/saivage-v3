import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AnalystSession } from '../../src/agents/analyst-handler.js';
import type { CardService as CardServiceType } from '../../src/cards/card-api.js';
import type { InvocationSurface } from '../../src/tools/invocation.js';
import { CardService, initProjectTree } from '../helpers/canonical-project.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { testCompactionPolicy, unusedSummarizerProvider } from '../helpers/llm-test-helpers.js';

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
      agentName: 'analyst', modelParams: { temperature: 0, maxTokens: 1000 }, capabilityRequest: { requiresTools: true, requiresExclusiveToolChoice: true, streaming: false },
      candidateChain: [{ provider: 'test', account: null, model: 'test-model' }],
      promptTemplates: { render },
      restartServerAvailable: false,
      provider: { completeTurn },
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
});
