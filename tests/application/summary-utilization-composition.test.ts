import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as invocationProviders from '../../src/application/invocation-service-provider.js';
import type { InvocationService } from '../../src/agents/invocation-service.js';
import type { AdmittedSummaryRequest } from '../../src/runtime/runtime-api.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';

// ESM export instrumentation only: observe the real packed object and forward
// every call to the actual production implementation. Packing/estimation and
// all admission/execution behavior remain real; only provider HTTP is simulated.
const packedRequests: AdmittedSummaryRequest[] = [];
const admissions: Array<Extract<ReturnType<InvocationService['preparePrimaryRequestAdmission']>, { kind: 'admitted' }>> = [];
const observedSummaryTurn: typeof invocationProviders.executeInternalSummaryTurn = (...args) => {
  packedRequests.push(args[3]);
  const service = args[0];
  const prepare = service.preparePrimaryRequestAdmission.bind(service);
  const spy = jest.spyOn(service, 'preparePrimaryRequestAdmission').mockImplementation((request) => {
    expect(request.contextUtilizationFraction).toBe(args[3].contextUtilizationFraction);
    const result = prepare(request);
    expect(result.kind).toBe('admitted');
    if (result.kind !== 'admitted') throw new Error('packed summary rejected at send');
    expect(result.bindings.contextUtilizationFraction).toBe(args[3].contextUtilizationFraction);
    admissions.push(result);
    return result;
  });
  const completion = invocationProviders.executeInternalSummaryTurn(...args);
  spy.mockRestore();
  return completion;
};
jest.unstable_mockModule('../../src/application/invocation-service-provider.js', () => ({ ...invocationProviders, executeInternalSummaryTurn: observedSummaryTurn }));
const { createRuntimeApplication } = await import('../../src/application/runtime-composition.js');
const { ProviderRegistry } = await import('../../src/agents/provider.js');
const { ModelRouter } = await import('../../src/agents/model-router.js');
const { bindRuntimeWorkflows } = await import('../../src/runtime/card-process/card-process-config.js');
const { ManagedProcessGroupRegistry } = await import('../../src/runtime/managed-process-group-registry.js');
const { ProcessRunner } = await import('../../src/runtime/process-runner.js');
const { CardService } = await import('../../src/cards/card-service.js');
const { effectiveSaivageConfigSchema } = await import('../../src/schemas/saivage-config.js');
const { TEST_SAIVAGE_CONFIG } = await import('../helpers/test-saivage-config.js');
const { createTestConfigAuthority } = await import('../helpers/project-config.js');
const { initProjectTree, TEST_WORKFLOWS } = await import('../helpers/canonical-project.js');
const { unusedMcpToolInvocation } = await import('../helpers/llm-test-helpers.js');

const roots: string[] = [];
afterEach(() => {
  jest.restoreAllMocks();
  packedRequests.length = 0;
  admissions.length = 0;
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('configured summary utilization through production composition', () => {
  it.each([.90, 1, .60])('retains U=%s through real normal/split/corrective packing to fetch', async (u) => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'summary-utilization-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const window = 30_000;
    const ceiling = Math.floor(u * window) - 2000;
    const config = effectiveSaivageConfigSchema.parse({
      ...structuredClone(TEST_SAIVAGE_CONFIG),
      providers: { test: { models: ['test-model'], capabilities: { transportProtocol: 'openai-chat-completions', toolsMode: 'native', exclusiveToolChoiceSupport: 'native', contextWindowTokens: window, maxOutputTokens: 10_000 } } },
      compaction: { ...TEST_SAIVAGE_CONFIG.compaction, context_utilization_fraction: u, tail_fraction: 0 },
    });
    const registry = new ProviderRegistry(config);
    const workflows = bindRuntimeWorkflows(TEST_WORKFLOWS, new ModelRouter(registry), registry, u);
    const processes = new ManagedProcessGroupRegistry();
    const freshness = { runtimeChanged: jest.fn(), cardProjectionChanged: jest.fn(), agentMembershipChanged: jest.fn(), conversationChanged: jest.fn(), llmExchangeChanged: jest.fn() };
    const sent: string[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = String(init!.body);
      const parsed = JSON.parse(body) as { messages: Array<{ content: string }>; max_tokens: number };
      const summary = parsed.max_tokens === 2000;
      if (summary) {
        sent.push(body);
      }
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: summary ? 'compact history' : 'done' }, finish_reason: summary && sent.length === 1 ? 'length' : 'stop' }] }), { status: 200 });
    });
    const app = createRuntimeApplication({ projectRoot, processIdentity: { pid: 42, startedAt: '2026-10-01T00:00:00.000Z' }, config, workflows, providerRegistry: registry, configAuthority: createTestConfigAuthority(projectRoot), cardStore: new CardService(projectRoot, workflows, freshness), freshness, processRunner: new ProcessRunner(projectRoot, processes, testApplicationFatalPort), runtimeProcessRootScope: processes.createContainerScope(processes.rootScope, 'runtime'), analystProcessRootScope: processes.createContainerScope(processes.rootScope, 'analyst'), mcpToolInvocation: unusedMcpToolInvocation, restartCapability: { available: false }, fatalPort: testApplicationFatalPort, onOversightOwnerFailure(error) { throw error; }, analystSessionId: 'agent:analyst:global' });
    const result = await app.analystRuntime.submit({ userContent: 'source material '.repeat(14_000) });
    expect(result).toMatchObject({ sessionId: 'agent:analyst:global', restart: null });
    expect(sent.length).toBeGreaterThan(2);
    expect(packedRequests).toHaveLength(sent.length);
    expect(admissions).toHaveLength(sent.length);
    for (const [index, body] of sent.entries()) {
      const packed = packedRequests[index]!;
      const verdict = admissions[index]!.candidates[0]!;
      if (verdict.kind !== 'admitted') throw new Error('expected retained plan');
      expect(packed.contextUtilizationFraction).toBe(u);
      expect(packed.usableInputTokens).toBe(ceiling);
      expect(packed.estimatedInputTokens).toBeLessThanOrEqual(ceiling);
      expect(body).toBe(packed.serializedRequest);
      expect(createHash('sha256').update(body).digest('hex')).toBe(packed.requestSha256);
      expect(verdict.plan.request.serializedBody).toBe(packed.serializedRequest);
      expect(verdict.plan.request.estimatedWireInputTokens).toBe(packed.estimatedInputTokens);
    }
    expect(JSON.parse(sent[1]!).messages[0].content).toContain('6000');
    expect(JSON.parse(sent[1]!).messages.slice(1)).toEqual(JSON.parse(sent[0]!).messages.slice(1));
    expect(packedRequests[0]!.estimatedInputTokens).toBe(ceiling);
    if (u > .8) {
      for (const packed of packedRequests.slice(0, 2))
        expect(packed.estimatedInputTokens).toBeGreaterThan(Math.floor(.8 * window) - 2000);
    } else expect(packedRequests[0]!.estimatedInputTokens).toBeLessThan(Math.floor(.8 * window) - 2000);
    await app.cleanupAnalystForApplicationStop();
  });
});
