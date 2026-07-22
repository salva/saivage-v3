import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { saivageConfigSchema } from '../../src/schemas/saivage-config.js';
import { DEFAULT_CARD_PROCESSES } from '../../src/agents/default-card-processes.js';
import { EventQueryService } from '../../src/application/event-query-service.js';
import { RuntimeInterventionBinding } from '../../src/application/intervention-readiness.js';
import { CardService } from '../../src/cards/card-service.js';
import { createEventLog } from '../../src/observability/index.js';
import { AppLogPublicationError } from '../../src/persistence/app-log.js';
import { initProjectTree, testConfigAuthority } from '../helpers/canonical-project.js';
import { createTestAnalystRuntime } from '../helpers/test-analyst-runtime.js';
import { unusedMcpToolInvocation } from '../helpers/llm-test-helpers.js';
import { createTestProcessRunner } from '../helpers/test-process-runner.js';
import { createTestPromptTemplateRegistry } from '../helpers/prompt-template-registry.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('AnalystSession publication-terminal ownership', () => {
  it('permanently fails the session, closes its process scope, and rejects every caller with the same object', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-analyst-publication-')); roots.push(projectRoot); initProjectTree(projectRoot);
    const config = saivageConfigSchema.parse({ models: { default: ['test/model'], max_tokens: { analyst: 200 } }, providers: { test: { models: ['model'] } }, compaction: { enabled: true, input_budget_tokens: 20000, summarizer_candidate: { provider: 'test', account: null, model: 'model' } }, card_processes: DEFAULT_CARD_PROCESSES });
    const { enabled: _enabled, summarizer_candidate: _candidate, ...compactionPolicy } = config.compaction;
    const processes = createTestProcessRunner(projectRoot);
    const closeScope = jest.spyOn(processes.processRunner, 'closeAndTerminateDirectScope');
    const error = new AppLogPublicationError('provider_exchange', new Error('hostile analyst publication failure'));
    const attempt = { attempt_index: 0, contract_id: 'test', contract_name: 'test', transport: 'generic' as const, provider: 'test', model: 'model', source_input_id: 'input', request_params: {}, started_at: '2026-07-21T00:00:00.000Z', completed_at: '2026-07-21T00:00:01.000Z', status: 'ok' as const, terminal_tool_fired: null };
    const composed = createTestAnalystRuntime({
      projectRoot, config, promptTemplates: createTestPromptTemplateRegistry(), processes, cardStore: new CardService(projectRoot),
      runtime: { notifyCard: jest.fn(), cancelCard: jest.fn() }, configAuthority: testConfigAuthority(projectRoot), interventionReadiness: new RuntimeInterventionBinding(), mcpToolInvocation: unusedMcpToolInvocation,
      eventLogger: createEventLog(projectRoot), eventQueries: new EventQueryService(projectRoot),
      provider: { completeTurn: async () => ({ result: { kind: 'message', content: 'done' }, provider_exchanges: [attempt] }), projectProviderExchanges: () => { throw error; } },
      conversations: { projectRoot }, compactionPolicy, compactor: { shouldCompact: () => false, compact: jest.fn() }, summarizerProvider: { completeTurn: jest.fn(), projectProviderExchanges: jest.fn() }, runtimeProjectionChanged: jest.fn(), captureExecutingLlmSnapshots: () => [],
    });
    await expect(composed.runtime.submit({ userContent: 'inspect' })).rejects.toBe(error);
    await expect(composed.runtime.submit({ userContent: 'again' })).rejects.toBe(error);
    expect(closeScope).toHaveBeenCalledTimes(1);
  });
});
