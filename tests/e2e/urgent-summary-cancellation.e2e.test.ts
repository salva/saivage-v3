import { afterEach, describe, expect, it, jest } from '@jest/globals';
import Fastify, { type LightMyRequestResponse } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntimeApplication } from '../../src/application/runtime-composition.js';
import { listControlActions } from '../../src/persistence/control-action-audit.js';
import { ProviderRegistry } from '../../src/agents/provider.js';
import { ModelRouter } from '../../src/agents/model-router.js';
import {
  bindRuntimeWorkflows,
  compileProjectWorkflows,
} from '../../src/runtime/card-process/card-process-config.js';
import { resolveSystemTemplate } from '../../src/config/system-templates/registry.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { CardService } from '../../src/cards/card-service.js';
import { effectiveSaivageConfigSchema } from '../../src/schemas/saivage-config.js';
import { NO_FRESHNESS_EFFECTS } from '../../src/contracts/index.js';
import { appendActivationMarker } from '../../src/runtime/actors/conversation-session.js';
import {
  appendConversationBatch,
  readConversation,
  readCurrentConversationSegment,
} from '../../src/persistence/conversation-file.js';
import { readProviderExchangeEntries } from '../../src/persistence/provider-exchange-log.js';
import { buildChatOperatorContractHandlers } from '../../src/server/routes/operator-chat-handlers.js';
import { ContractRuntime } from '../../src/server/contract-runtime.js';
import { AuthPolicy } from '../../src/server/auth-policy.js';
import { operatorApiContracts } from '../../src/contracts/operator-api.js';
import { createEventLog } from '../../src/observability/index.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { createTestConfigAuthority } from '../helpers/project-config.js';
import { unusedMcpToolInvocation } from '../helpers/llm-test-helpers.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { TEXT_ROW_POLICY } from '../helpers/row-policy-fixtures.js';
import { chatSuccess } from '../helpers/invocation-provider-fixture.js';

function gate() {
  let resolve!: () => void;
  let open = false;
  const promise = new Promise<void>((done) => {
    resolve = () => {
      open = true;
      done();
    };
  });
  return { promise, resolve, isOpen: () => open };
}

async function reach(barrier: ReturnType<typeof gate>, diagnostic: () => unknown) {
  for (let i = 0; i < 200 && !barrier.isOpen(); i++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  if (!barrier.isOpen())
    throw new Error(`Pipeline barrier not reached: ${JSON.stringify(diagnostic())}`);
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('offline urgent cancellation through summary, Analyst and HTTP owners', () => {
  // Finite safety budget for durable/HTTP setup, settlement and cleanup, not a latency assertion.
  it.each(['cancel', 'distinct_failure'] as const)(
    'retains real canonical evidence and truthful queue effects on %s',
    async (outcome) => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'urgent-summary-e2e-'));
      initProjectTree(projectRoot);
      const config = effectiveSaivageConfigSchema.parse({
        ...structuredClone(TEST_SAIVAGE_CONFIG),
        providers: {
          test: {
            models: ['test-model', 'summary', 'analyst-model'],
            apiKey: 'synthetic-key',
            baseUrl: 'https://offline.invalid/v1',
            capabilities: {
              transportProtocol: 'openai-chat-completions',
              toolsMode: 'native',
              exclusiveToolChoiceSupport: 'native',
              contextWindowTokens: 100_000,
              maxOutputTokens: 10_000,
            },
          },
        },
        models: {
          ...TEST_SAIVAGE_CONFIG.models,
          routes: {
            ...TEST_SAIVAGE_CONFIG.models.routes,
            analyst: { candidates: ['analyst-model'], temperature: 0, max_tokens: 200 },
          },
        },
        compaction: {
          ...TEST_SAIVAGE_CONFIG.compaction,
          summarizer_candidate: { provider: 'test', account: null, model: 'summary' },
        },
      });
      const registry = new ProviderRegistry(config);
      const workflows = bindRuntimeWorkflows(
        compileProjectWorkflows(config, {
          defaultPromptRoot: resolveSystemTemplate('classic').promptRoot,
        }),
        new ModelRouter(registry),
        registry,
        config.compaction.context_utilization_fraction,
      );
      const cards = new CardService(projectRoot, workflows, NO_FRESHNESS_EFFECTS);
      const processes = new ManagedProcessGroupRegistry();
      const app = createRuntimeApplication({
        projectRoot,
        config,
        workflows,
        providerRegistry: registry,
        cardStore: cards,
        configAuthority: createTestConfigAuthority(projectRoot),
        freshness: NO_FRESHNESS_EFFECTS,
        processIdentity: { pid: 42, startedAt: '2026-10-16T00:00:00.000Z' },
        processRunner: new ProcessRunner(projectRoot, processes, testApplicationFatalPort),
        runtimeProcessRootScope: processes.createContainerScope(processes.rootScope, 'runtime'),
        analystProcessRootScope: processes.createContainerScope(processes.rootScope, 'analyst'),
        mcpToolInvocation: unusedMcpToolInvocation,
        restartCapability: { available: false },
        fatalPort: testApplicationFatalPort,
        onOversightOwnerFailure(error) {
          throw error;
        },
        analystSessionId: 'agent:analyst:global',
      });
      const server = Fastify({ logger: false });
      new ContractRuntime({
        authPolicy: new AuthPolicy({ apiToken: 'offline-token' }),
        eventLogger: createEventLog(projectRoot),
        fatalPort: testApplicationFatalPort,
      }).mount(
        server,
        operatorApiContracts,
        buildChatOperatorContractHandlers({
          runtimeApplication: app,
          restartCapability: { available: false },
        }),
      );
      await server.ready();
      const goal = cards.create({
        type: 'goal',
        parent: 'project',
        title: 'Goal',
        bootstrap_content: 'Brief',
        priority: 0,
        urgency: 'normal',
        created_by: 'analyst',
        depends_on: [],
      });
      const leaf = cards.create({
        type: 'code',
        parent: goal.id,
        title: 'Leaf',
        bootstrap_content: 'Brief',
        priority: 0,
        urgency: 'normal',
        created_by: 'analyst',
        depends_on: [],
      });
      const session = `agent:executor:${leaf.id}` as const;
      appendActivationMarker({ projectRoot }, session, {
        event: 'activation_open',
        instructions: { kind: 'unavailable', reason: 'not_recorded' },
        agent_name: 'executor',
        card_id: leaf.id,
        input_id: '11111111-1111-4111-8111-111111111111',
      });
      appendConversationBatch({ projectRoot }, [
        {
          id: 'retained-source',
          session_id: session,
          role: 'user',
          kind: 'text',
          content: 'retained work evidence '.repeat(20_000),
          context_policy: TEXT_ROW_POLICY,
          round_id: `r-user-${'1'.repeat(32)}`,
          message_index: 1,
          block_index: 0,
          timestamp: '2026-10-16T00:00:00.000Z',
        },
      ]);
      const summaryEntered = gate();
      const summaryAborted = gate();
      const releaseSummary = gate();
      const replacementEntered = gate();
      const reentryEntered = gate();
      let primaryCalls = 0;
      let analystCalls = 0;
      let summaryCalls = 0;
      const call = (id: string, name: string, args: unknown) =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  tool_calls: [
                    { id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          }),
          { status: 200 },
        );
      const actual = new Error('distinct transport failure during urgent cancellation');
      jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const body = JSON.parse(String(init!.body)) as { model: string };
        const signal = init!.signal!;
        if (body.model === 'summary') {
          summaryCalls++;
          summaryEntered.resolve();
          signal.addEventListener('abort', () => summaryAborted.resolve(), { once: true });
          await releaseSummary.promise;
          if (outcome === 'distinct_failure') throw actual;
          throw Object.assign(new Error('native request aborted'), { name: 'AbortError' });
        }
        if (body.model === 'analyst-model') {
          analystCalls++;
          if (analystCalls === 1)
            return call('urgent-root', 'queue_notification', {
              card_id: 'project',
              kind: 'context',
              body: 'Reassess this root with fresh evidence.',
              urgency: 'urgent',
            });
          return chatSuccess('Receipt acknowledged; no resend or automatic descendant activation.');
        }
        primaryCalls++;
        if (primaryCalls <= 2)
          return call(`activate-${primaryCalls}`, 'activate_card', {
            card_id: primaryCalls === 1 ? goal.id : leaf.id,
            instructions: 'Complete the bounded child task.',
          });
        if (primaryCalls === 3) replacementEntered.resolve();
        if (primaryCalls === 4) reentryEntered.resolve();
        return await new Promise<never>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      });
      const stopped: string[] = [];
      const stop = cards.stopRunning.bind(cards);
      jest.spyOn(cards, 'stopRunning').mockImplementation((id) => {
        stopped.push(id);
        return stop(id);
      });
      const enqueue = jest.spyOn(cards, 'enqueueNotification');
      let request: Promise<LightMyRequestResponse> | undefined;
      try {
        expect((await app.runtimeApi.startProject()).started).toBe(true);
        await reach(summaryEntered, () => ({
          primaryCalls,
          analystCalls,
          summaryCalls,
          runtime: app.runtimeApi.getStatus(),
          root: readConversation(projectRoot, 'agent:planner:project').physicalRows.slice(-3),
        }));
        request = server.inject({
          method: 'POST',
          url: '/api/chat',
          headers: { authorization: 'Bearer offline-token' },
          payload: { content: 'Queue the urgent root context exactly once.' },
        });
        // Start inject's thenable while waiting for the exact cancellation barrier.
        const responsePending = Promise.resolve(request);
        await reach(summaryAborted, () => ({
          primaryCalls,
          analystCalls,
          summaryCalls,
          runtime: app.runtimeApi.getStatus(),
          analyst: readConversation(projectRoot, 'agent:analyst:global').physicalRows.slice(-3),
        }));
        expect(stopped).toEqual([]);
        expect(cards.read(leaf.id)!.lifecycle.status).toBe('running');
        expect(enqueue).toHaveBeenCalledTimes(1);
        const notificationId = enqueue.mock.calls[0]![1].id;
        expect(cards.read('project')!.pending_notifications).toEqual([notificationId]);
        releaseSummary.resolve();
        const response = await responsePending;
        const evidence = readProviderExchangeEntries(projectRoot, session);
        expect(evidence).toHaveLength(1);
        expect(evidence[0]!.data).toMatchObject({
          attempt_index: 0,
          session_id: expect.stringMatching(/^internal:/),
          payload: { status: 'error' },
        });
        expect(readCurrentConversationSegment(projectRoot, session)!.entry.version).toBe(1);
        const analyst = readConversation(projectRoot, 'agent:analyst:global');
        const calls = analyst.physicalRows.filter(
          (row) => row.kind === 'tool_call' && row.tool_call_id === 'urgent-root',
        );
        const results = analyst.physicalRows.filter(
          (row) => row.kind === 'tool_result' && row.tool_call_id === 'urgent-root',
        );
        expect(calls).toHaveLength(1);
        if (outcome === 'distinct_failure') {
          expect(response.statusCode).toBe(500);
          expect(results).toHaveLength(0);
          expect(cards.read('project')!.pending_notifications).toEqual([notificationId]);
          expect(app.runtimeApi.getStatus().status).toBe('error');
          expect(app.runtimeApi.getActorRuntimeReadModel().pauseMode).toBe('idle');
          expect(stopped).toEqual([]);
          expect(primaryCalls).toBe(2);
          expect(cards.read(leaf.id)!.lifecycle.status).toBe('running');
          expect(evidence[0]!.data.payload).toMatchObject({ error: { message: actual.message } });
          const audits = listControlActions(projectRoot).filter(
            (event) => event.action === 'notification.queue',
          );
          expect(audits).toHaveLength(1);
          expect(audits[0]).toMatchObject({ outcome: 'error' });
        } else {
          expect(response.statusCode).toBe(200);
          await reach(replacementEntered, () => app.runtimeApi.getStatus());
          expect(stopped).toEqual([leaf.id, goal.id, 'project']);
          const receipt = {
            success: true,
            data: {
              queued: true,
              notification_id: notificationId,
              interruption: {
                status: 'interrupted',
                stopped_card_ids: [leaf.id, goal.id, 'project'],
              },
            },
          };
          expect(response.json()).toMatchObject({
            toolInvocations: [{ tool: 'queue_notification', result: receipt }],
          });
          expect(results).toHaveLength(1);
          expect(JSON.parse(results[0]!.content)).toMatchObject(receipt);
          expect(analyst.unmatchedCall).toBeNull();
          const audits = listControlActions(projectRoot).filter(
            (event) => event.action === 'notification.queue',
          );
          expect(audits).toHaveLength(1);
          expect(audits[0]).toMatchObject({ outcome: 'ok' });
          expect(cards.read(goal.id)!.lifecycle.status).toBe('stopped');
          expect(cards.read(leaf.id)!.lifecycle.status).toBe('stopped');
          expect(app.runtimeApi.getActorRuntimeReadModel().cards).toHaveLength(1);
          expect(
            (
              await server.inject({
                method: 'POST',
                url: '/api/chat',
                headers: { authorization: 'Bearer offline-token' },
                payload: { content: 'Confirm no resend.' },
              })
            ).statusCode,
          ).toBe(200);
          await app.runtimeApi.stopProject();
          expect((await app.runtimeApi.startProject()).started).toBe(true);
          await reach(reentryEntered, () => app.runtimeApi.getStatus());
          expect(cards.read('project')!.lifecycle.status).toBe('running');
          expect(cards.read(leaf.id)!.lifecycle.status).toBe('stopped');
          expect(primaryCalls).toBe(4);
        }
        expect(summaryCalls).toBe(1);
        expect(enqueue).toHaveBeenCalledTimes(1);
      } finally {
        releaseSummary.resolve();
        app.closeRuntimeAdmission();
        app.closeAnalystAdmission();
        app.closeOversightAdmission();
        const cleanup = app.cleanupRuntimeForApplicationStop();
        if (outcome === 'distinct_failure')
          await expect(cleanup).rejects.toThrow('Runtime application cleanup failed.');
        else await cleanup;
        await app.cleanupAnalystForApplicationStop();
        await app.cleanupOversightForApplicationStop();
        await request;
        await server.close();
        rmSync(projectRoot, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
