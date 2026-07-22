import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { saivageConfigSchema } from '../../src/schemas/saivage-config.js';
import { DEFAULT_CARD_PROCESSES } from '../../src/agents/default-card-processes.js';
import { RuntimeInterventionBinding } from '../../src/application/intervention-readiness.js';
import { CardService } from '../../src/cards/card-service.js';
import { createEventLog } from '../../src/observability/index.js';
import { EventQueryService } from '../../src/application/event-query-service.js';
import { listControlActions } from '../../src/persistence/index.js';
import { readConversation } from '../../src/persistence/conversation-file.js';
import { initProjectTree, testConfigAuthority } from '../helpers/canonical-project.js';
import { createTestProcessRunner } from '../helpers/test-process-runner.js';
import { createTestPromptTemplateRegistry } from '../helpers/prompt-template-registry.js';
import { unusedMcpToolInvocation } from '../helpers/llm-test-helpers.js';
import { createTestAnalystRuntime } from '../helpers/test-analyst-runtime.js';
import { dataPropertyGraphContains } from '../helpers/data-property-graph.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('Analyst handler cancellation after a committed mutation', () => {
  it('keeps one ok audit and durably pairs the cancelled parked tool call without continuation', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-analyst-late-cancel-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const cards = new CardService(projectRoot);
    const child = cards.create({ type: 'code', parent: 'project', title: 'Cancel me', brief: 'work', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });

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
    const processes = createTestProcessRunner(projectRoot);
    const closeDirect = jest.spyOn(processes.processRunner, 'closeAndTerminateDirectScope');
    const terminateRoot = jest.spyOn(processes.processRunner, 'terminateScopeTree');
    const config = saivageConfigSchema.parse({ models: { default: ['test/model'] }, providers: { test: { models: ['model'] } }, compaction: { enabled: true, input_budget_tokens: 20480, summarizer_candidate: { provider: 'test', account: null, model: 'model' } }, card_processes: DEFAULT_CARD_PROCESSES });
    const { enabled: _enabled, summarizer_candidate: _candidate, ...compactionPolicy } = config.compaction;
    const composed = createTestAnalystRuntime({
      projectRoot,
      config,
      promptTemplates: createTestPromptTemplateRegistry(),
      processes,
      configAuthority: testConfigAuthority(projectRoot),
      cardStore: cards,
      runtime: { startProject: jest.fn(), pause: jest.fn(), resume: jest.fn(), stopProject: jest.fn(), cancelCard, notifyCard: jest.fn(() => ({ ok: true, notificationId: 'notification' })), getStatus: jest.fn() },
      eventLogger: createEventLog(projectRoot),
      eventQueries: new EventQueryService(projectRoot),
      provider: { completeTurn: provider, projectProviderExchanges: jest.fn() },
      mcpToolInvocation: unusedMcpToolInvocation,
      compactionPolicy,
      compactor: { shouldCompact: () => false, compact: jest.fn() },
      summarizerProvider: { completeTurn: jest.fn(), projectProviderExchanges: jest.fn() },
      conversations: { projectRoot },
      interventionReadiness: new RuntimeInterventionBinding(),
      runtimeProjectionChanged: jest.fn(),
      captureExecutingLlmSnapshots: () => [],
    });
    const { runtime } = composed;

    const turn = runtime.submit({ userContent: 'cancel obsolete work' });
    const session = composed.sessions[0]!;
    const forbidden = new Set<unknown>([processes.registry, processes.processRunner, processes.analystProcessRootScope, ...composed.directScopes, ...composed.sessionOperations, ...composed.sessionConstructionInputs]);
    expect(dataPropertyGraphContains(session, forbidden)).toBe(false);
    expect(Reflect.ownKeys(session)).not.toEqual(expect.arrayContaining(['args', 'runtimeDeps', 'processScope', 'llm', 'phase', 'retiredOperationTrackers']));
    expect(dataPropertyGraphContains(runtime, new Set([...forbidden, ...composed.runtimeOperations, composed.runtimeConstructionInput]))).toBe(false);
    expect(Reflect.ownKeys(runtime)).not.toEqual(expect.arrayContaining(['args', 'runtimeDeps', 'session', 'admissionOpen']));
    await committed;
    expect(runtime.cancel('operator cancelled after commit')).toBe(true);
    await expect(turn).resolves.toMatchObject({ cancelled: true });
    releaseOwner();
    await runtime.cleanupForApplicationStop();
    expect(closeDirect).toHaveBeenCalledTimes(1);
    expect(closeDirect).toHaveBeenCalledWith(expect.objectContaining({ directScope: composed.directScopes[0], category: 'operator_session', reason: 'session closed' }));
    expect(terminateRoot).toHaveBeenCalledWith(expect.objectContaining({ rootScope: processes.analystProcessRootScope, categories: ['operator_session'], reason: 'application stopping' }));

    expect(cancelCard).toHaveBeenCalledTimes(1);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(listControlActions(projectRoot)).toHaveLength(1);
    expect(listControlActions(projectRoot)[0]).toMatchObject({ action: 'card.cancel', outcome: 'ok' });
    const rows = readConversation(projectRoot, 'analyst:global').physicalRows;
    expect(rows.filter((row) => row.kind === 'tool_call' && row.tool_call_id === 'cancel-call')).toHaveLength(1);
    expect(rows.filter((row) => row.kind === 'tool_result' && row.tool_call_id === 'cancel-call')).toEqual([
      expect.objectContaining({ content: '{"success":false,"error":"The Analyst turn was cancelled before this tool result could continue the conversation."}' }),
    ]);
  });
});
