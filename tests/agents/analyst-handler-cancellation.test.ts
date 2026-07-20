import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AnalystRuntime } from '../../src/agents/analyst-handler.js';
import { saivageConfigSchema } from '../../src/agents/config-schema.js';
import { DEFAULT_CARD_PROCESSES } from '../../src/agents/default-card-processes.js';
import { RuntimeInterventionBinding } from '../../src/application/intervention-readiness.js';
import { CardService } from '../../src/cards/card-service.js';
import { EventBus } from '../../src/events/index.js';
import { listControlActions } from '../../src/persistence/index.js';
import { readConversation } from '../../src/persistence/conversation-file.js';
import { initProjectTree, testConfigAuthority } from '../helpers/canonical-project.js';
import { testAppLogs } from '../helpers/app-logs.js';
import { createTestProcessRunner } from '../helpers/test-process-runner.js';
import { createTestPromptTemplateRegistry } from '../helpers/prompt-template-registry.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('Analyst handler cancellation after a committed mutation', () => {
  it('keeps one ok audit while suppressing tool-result persistence, continuation, and replay', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-analyst-late-cancel-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const cards = new CardService(projectRoot);
    const child = cards.create({ type: 'code', parent: 'project', title: 'Cancel me', brief: 'work', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });

    let markCommitted!: () => void;
    const committed = new Promise<void>((resolve) => { markCommitted = resolve; });
    let releaseOwner!: () => void;
    const ownerRelease = new Promise<void>((resolve) => { releaseOwner = resolve; });
    const cancelCard = jest.fn(async (cardId: string, reason?: string) => {
      expect(cardId).toBe(child.id);
      markCommitted();
      await ownerRelease;
      return { card_id: cardId, status: 'cancelled' as const, cancelled_card_ids: [cardId], reason };
    });
    const provider = jest.fn(async () => ({ result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'cancel-call', type: 'function' as const, function: { name: 'cancel_card', arguments: JSON.stringify({ cardId: child.id, reason: 'obsolete' }) } }] }, provider_exchanges: [] }));
    const eventBus = new EventBus();
    let publishControlAction!: () => void;
    const controlActionPublished = new Promise<void>((resolve) => { publishControlAction = resolve; });
    const publications: unknown[] = [];
    eventBus.subscribe({ allowedKinds: ['control_action_recorded'], handler: (event) => { publications.push(event); publishControlAction(); } });
    const runner = createTestProcessRunner(projectRoot);
    const config = saivageConfigSchema.parse({ models: { default: ['test/model'] }, providers: { test: { models: ['model'] } }, compaction: { enabled: true, input_budget_tokens: 20480, summarizer_candidate: { provider: 'test', account: null, model: 'model' } }, card_processes: DEFAULT_CARD_PROCESSES });
    const { enabled: _enabled, summarizer_candidate: _candidate, ...compactionPolicy } = config.compaction;
    const runtime = new AnalystRuntime({ projectRoot, config, runtimeDeps: {
      configAuthority: testConfigAuthority(projectRoot), cardStore: cards,
      runtime: { startProject: jest.fn(), pause: jest.fn(), resume: jest.fn(), stopProject: jest.fn(), cancelCard, notifyCard: jest.fn(() => ({ ok: true, notificationId: 'notification' })), getStatus: jest.fn() },
      eventBus, provider: { completeTurn: provider, projectProviderExchanges: jest.fn() }, processRunner: runner, analystProcessRootScope: runner.analystRootScope,
      compactionPolicy, compactor: { shouldCompact: () => false, compact: jest.fn() }, summarizerProvider: { completeTurn: jest.fn(), projectProviderExchanges: jest.fn() },
      conversations: { projectRoot }, appLogs: testAppLogs(projectRoot), interventionReadiness: new RuntimeInterventionBinding(),
      runtimeProjectionChanged: jest.fn(), captureExecutingLlmSnapshots: () => [],
    } as never, promptTemplates: createTestPromptTemplateRegistry() });

    const turn = runtime.submit({ userContent: 'cancel obsolete work' });
    await committed;
    expect(runtime.cancel('operator cancelled after commit')).toBe(true);
    await expect(turn).resolves.toMatchObject({ cancelled: true });
    releaseOwner();
    await controlActionPublished;
    await runtime.cleanupForApplicationStop();

    expect(cancelCard).toHaveBeenCalledTimes(1);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(publications).toHaveLength(1);
    expect(listControlActions(projectRoot)).toHaveLength(1);
    expect(listControlActions(projectRoot)[0]).toMatchObject({ action: 'card.cancel', outcome: 'ok' });
    const rows = readConversation(projectRoot, 'analyst:global').physicalRows;
    expect(rows.filter((row) => row.kind === 'tool_call' && row.tool_call_id === 'cancel-call')).toHaveLength(1);
    expect(rows.filter((row) => row.kind === 'tool_result' && row.tool_call_id === 'cancel-call')).toHaveLength(0);
  });
});
