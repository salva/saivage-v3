import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

let phase: 'open' | 'write' | 'collision' | 'rename' | 'parent-fsync' | null = null;
let armed = false;
let fired = false;
let directory = '';
let fault: Error;
let abortOnFault: AbortController | undefined;
const descriptors = new Map<number, string>();
const afterFault: string[] = [];
const attempts: string[] = [];
const leaks = new Set<number>();
const inspections: string[] = [];
function observe(name: string) {
  if (fired) afterFault.push(name);
}
function fail(name: string) {
  attempts.push(name);
  fired = true;
  abortOnFault?.abort(new Error('racing cancellation'));
  throw fault;
}
jest.unstable_mockModule('node:fs', () => ({
  ...fs,
  openSync: (...args: Parameters<typeof fs.openSync>) => {
    observe('open');
    if (
      armed &&
      phase === 'open' &&
      String(args[0]).startsWith(directory) &&
      String(args[0]).endsWith('.saivage-tmp')
    )
      fail('open');
    const fd = fs.openSync(...args);
    descriptors.set(fd, String(args[0]));
    return fd;
  },
  writeSync: (...args: Parameters<typeof fs.writeSync>) => {
    observe('write');
    if (armed && phase === 'write' && descriptors.get(args[0])?.startsWith(directory)) {
      leaks.add(args[0]);
      fail('write');
    }
    return Reflect.apply(fs.writeSync, fs, args);
  },
  renameSync: (...args: Parameters<typeof fs.renameSync>) => {
    observe('rename');
    if (armed && phase === 'rename' && String(args[1]).startsWith(directory)) fail('rename');
    return fs.renameSync(...args);
  },
  fsyncSync: (fd: number) => {
    observe('fsync');
    if (armed && phase === 'parent-fsync' && descriptors.get(fd) === directory) {
      leaks.add(fd);
      fail('parent-fsync');
    }
    return fs.fsyncSync(fd);
  },
  closeSync: (fd: number) => {
    observe('close');
    descriptors.delete(fd);
    return fs.closeSync(fd);
  },
  lstatSync: (...args: Parameters<typeof fs.lstatSync>) => {
    observe('lstat');
    if (
      armed &&
      phase === 'collision' &&
      String(args[0]).startsWith(directory) &&
      String(args[0]).endsWith('.json')
    ) {
      attempts.push('collision');
      return fs.lstatSync(directory);
    }
    return fs.lstatSync(...args);
  },
  readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
    observe('read');
    inspections.push(String(args[0]));
    return Reflect.apply(fs.readFileSync, fs, args);
  },
  readdirSync: (...args: Parameters<typeof fs.readdirSync>) => {
    observe('readdir');
    inspections.push(String(args[0]));
    return Reflect.apply(fs.readdirSync, fs, args);
  },
  unlinkSync: (...args: Parameters<typeof fs.unlinkSync>) => {
    observe('unlink');
    return fs.unlinkSync(...args);
  },
}));
const { InvocationService } = await import('../../src/agents/invocation-service.js');
const { MemoryCandidateAvailability } = await import('../../src/agents/candidate-availability.js');
const { PublicationOutcomeUnknownError, NO_FRESHNESS_EFFECTS } =
  await import('../../src/contracts/index.js');
const { FailedProviderRequestDiagnostics } =
  await import('../../src/agents/failed-provider-request-diagnostics.js');
const { invocationProviderRegistry } = await import('../helpers/invocation-provider-fixture.js');
const { initProjectTree } = await import('../helpers/canonical-project.js');
const { createInvocationServiceProvider } =
  await import('../../src/application/invocation-service-provider.js');
const { ConversationLLMActor } = await import('../../src/runtime/actors/llm-actor.js');
const { prepareCompaction } = await import('../../src/runtime/actors/compaction/compactor.js');
const { buildPreparedInvocationContext } =
  await import('../../src/runtime/actors/context/context-blocks.js');
const { RuntimeGate } = await import('../../src/runtime/runtime-gate.js');
const { appendConversationBatch } = await import('../../src/persistence/conversation-file.js');
const { agentMessageSchema } = await import('../../src/schemas/index.js');
const { testCompactor, unusedSummarizerProvider } = await import('../helpers/llm-test-helpers.js');
const roots: string[] = [];
const candidate = { provider: 'test', account: null, model: 'model' };
const session = 'agent:planner:project' as const;
const inputId = '00000000-0000-4000-8000-000000000001';
function fixture() {
  const root = fs.mkdtempSync('/home/salva/g/ml/tmp/diagnostic-fault-');
  roots.push(root);
  initProjectTree(root);
  const activation = randomUUID();
  directory = join(root, '.saivage/diagnostics/failed-provider-requests', activation);
  const availability = new MemoryCandidateAvailability();
  const service = new InvocationService({
    projectRoot: root,
    registry: invocationProviderRegistry([candidate]),
    candidateAvailability: availability,
    freshness: NO_FRESHNESS_EFFECTS,
    failedProviderDiagnostics: activation,
  });
  const request = {
    inputId,
    agentName: 'planner',
    sessionId: session,
    systemPrompt: 'system',
    providerConversation: { sourceSessionId: session, messages: [] },
    tools: [],
    terminalToolNames: [],
    modelParams: { temperature: 0, maxTokens: 100 },
    capabilityRequest: {},
    routePass: { kind: 'pinned-content-policy-retry' as const, candidate },
  };
  const preflight = service.preflightPinnedContentPolicyRequest(request);
  if (preflight.kind !== 'admitted') throw new Error('must admit');
  return { root, service, availability, preflight };
}
beforeEach(() => {
  fault = Object.assign(new Error('private injected syscall details'), { code: 'EACCES' });
  fired = false;
  armed = false;
  attempts.length = 0;
  afterFault.length = 0;
  inspections.length = 0;
  jest.spyOn(console, 'error').mockImplementation(() => {
    observe('warning');
  });
});
afterEach(() => {
  armed = false;
  fired = false;
  phase = null;
  abortOnFault = undefined;
  for (const fd of leaks) fs.closeSync(fd);
  leaks.clear();
  descriptors.clear();
  jest.restoreAllMocks();
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('diagnostic publication uses existing fatal primitive boundary', () => {
  it.each(['open', 'write', 'collision'] as const)(
    'known %s failure consumes a slot and preserves the original provider outcome with one fixed warning',
    async (value) => {
      const f = fixture();
      const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('{"error":{"code":"content_filter","message":"synthetic refusal"}}', {
          status: 400,
        }),
      );
      phase = value;
      armed = true;
      const failure = await f.service
        .executePinnedContentPolicyRequest(f.preflight, { attemptIndex: 1 })
        .catch((error) => error);
      armed = false;
      fired = false;
      expect(failure).toMatchObject({
        originalFailure: { failure: { kind: 'content_policy', status: 400 } },
        provider_exchanges: [{ attempt_index: 0, status: 'error' }],
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(attempts).toEqual([value]);
      expect((console.error as ReturnType<typeof jest.spyOn>).mock.calls.at(-1)).toEqual([
        'Failed provider diagnostic capture failed.',
      ]);
      expect(
        JSON.stringify((console.error as ReturnType<typeof jest.spyOn>).mock.calls),
      ).not.toContain(fault.message);
    },
  );

  it('never reads reused activation contents and disables known ignore-file setup failure', () => {
    const f = fixture();
    const activation = randomUUID();
    const target = join(f.root, '.saivage/diagnostics/failed-provider-requests', activation);
    fs.mkdirSync(target);
    fs.writeFileSync(join(target, 'retained.json'), 'private retained malformed data');
    inspections.length = 0;
    new FailedProviderRequestDiagnostics(f.root, activation);
    expect(inspections.filter((path) => path.startsWith(target))).toEqual([]);
    const failedActivation = randomUUID();
    directory = join(f.root, '.saivage/diagnostics/failed-provider-requests', failedActivation);
    phase = 'open';
    armed = true;
    const disabled = new FailedProviderRequestDiagnostics(f.root, failedActivation);
    armed = false;
    fired = false;
    expect(attempts).toEqual(['open']);
    expect(fs.readdirSync(directory)).toEqual([]);
    expect((console.error as ReturnType<typeof jest.spyOn>).mock.calls.at(-1)).toEqual([
      'Failed provider diagnostics disabled (activation unavailable).',
    ]);
    // Disabled owners do not even parse an invalid body.
    disabled.capture(
      {
        context: {
          sourceSessionId: session,
          invocationSessionId: session,
          inputId,
          attemptIndex: 0,
          purpose: 'primary',
        },
        serializedBody: 'invalid JSON private text',
        contractId: 'x',
        protocol: 'openai-responses',
        provider: 'test',
        model: 'model',
        submittedAt: '2026-10-09T00:00:00.000Z',
        completedAt: '2026-10-09T00:00:01.000Z',
        observation: 'transport_failure',
        failureKind: 'unknown',
        providerCode: null,
        providerCodeTruncated: false,
        finishReason: null,
        httpStatus: null,
        embeddedStatus: null,
      },
      undefined,
    );
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it('propagates ignore-file publication uncertainty before enabled/disabled notices or cleanup', () => {
    const f = fixture();
    const activation = randomUUID();
    directory = join(f.root, '.saivage/diagnostics/failed-provider-requests', activation);
    phase = 'rename';
    armed = true;
    expect(() => new FailedProviderRequestDiagnostics(f.root, activation)).toThrow(
      PublicationOutcomeUnknownError,
    );
    armed = false;
    fired = false;
    expect(afterFault).toEqual([]);
    expect(attempts).toEqual(['rename']);
  });

  it('does not refund known failed publications or scan/read a reused activation', () => {
    const f = fixture();
    const capture = new FailedProviderRequestDiagnostics(f.root, randomUUID());
    // All activations share the same parent, but budgets belong to their owning service helper.
    directory = join(f.root, '.saivage/diagnostics/failed-provider-requests');
    phase = 'open';
    armed = true;
    const observation = {
      context: {
        sourceSessionId: session,
        invocationSessionId: session,
        inputId,
        attemptIndex: 0,
        purpose: 'primary' as const,
      },
      serializedBody: '{"safe":true}',
      contractId: 'x',
      protocol: 'openai-responses',
      provider: 'test',
      model: 'model',
      submittedAt: '2026-10-09T00:00:00.000Z',
      completedAt: '2026-10-09T00:00:01.000Z',
      observation: 'transport_failure' as const,
      failureKind: 'unknown' as const,
      providerCode: null,
      providerCodeTruncated: false,
      finishReason: null,
      httpStatus: null,
      embeddedStatus: null,
    };
    for (let index = 0; index < 20; index++) {
      fired = false;
      capture.capture(observation, undefined);
    }
    expect(attempts).toHaveLength(16);
    expect(
      (console.error as ReturnType<typeof jest.spyOn>).mock.calls.filter(
        (call: unknown[]) => call[0] === 'Failed provider diagnostics limit reached.',
      ),
    ).toHaveLength(1);
  });

  it.each([
    ['rename', false],
    ['parent-fsync', false],
    ['rename', true],
    ['parent-fsync', true],
  ] as const)(
    'routes %s uncertainty through the real actor fatal port before settlement, retry, logging (racing cancellation=%s)',
    async (value, racingCancellation) => {
      const f = fixture();
      appendConversationBatch({ projectRoot: f.root }, [
        agentMessageSchema.parse({
          id: 'activation',
          session_id: session,
          role: 'system',
          kind: 'activity',
          content: JSON.stringify({
            event: 'activation_open',
            agent_name: 'planner',
            card_id: 'project',
            input_id: inputId,
            timestamp: '2026-10-09T00:00:00.000Z',
          }),
          context_policy: { kind: 'structural', behavior: 'activation_boundary' },
          round_id: 'r-pre-00000000000000000000000000000000',
          message_index: 0,
          block_index: 0,
          timestamp: '2026-10-09T00:00:00.000Z',
        }),
      ]);
      const projected = jest.spyOn(f.service, 'projectProviderExchanges');
      const availability = jest.spyOn(f.availability, 'markFailed');
      const controller = new AbortController();
      abortOnFault = racingCancellation ? controller : undefined;
      const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('{"error":{"code":"content_filter","message":"synthetic refusal"}}', {
          status: 400,
        }),
      );
      const fatal = new Error('test fatal boundary');
      const delivery = jest.fn((error: unknown): never => {
        expect(error).toBeInstanceOf(PublicationOutcomeUnknownError);
        expect((error as Error).cause).toBe(fault);
        throw fatal;
      });
      const actor = new ConversationLLMActor({
        provider: createInvocationServiceProvider(f.service, f.root),
        conversations: { projectRoot: f.root },
        compactor: testCompactor,
        summarizerProvider: unusedSummarizerProvider,
        fatalPort: { publicationOutcomeUnknown: delivery },
        agentId: session,
        purpose: { kind: 'autonomous-card', cardId: 'project' },
        gate: new RuntimeGate(),
      });
      const preparedCompaction = prepareCompaction(
        {
          context_utilization_fraction: 0.8,
          trigger_fraction: 0.8,
          tail_fraction: 0.25,
          snap: 'compact_straddler',
        },
        'system',
        [],
        8000,
        2000,
      );
      phase = value;
      armed = true;
      const pending = actor.turn(
        {
          inputId,
          agentId: session,
          agentName: 'planner',
          sessionId: session,
          systemPrompt: 'system',
          providerConversation: { sourceSessionId: session, messages: [] },
          tools: [],
          compiledToolContracts: [],
          terminalToolNames: [],
          modelParams: { temperature: 0 },
          preparedCompaction,
          preparedContext: buildPreparedInvocationContext({
            instructionText: 'system',
            terminalToolNames: [],
            compiledTools: [],
            dynamicBlocks: [],
            preparedCompaction,
          }),
          capabilityRequest: {},
          routePass: { kind: 'ordinary', candidateChain: [candidate] },
          episodeContext: {},
        },
        controller.signal,
        () => {
          throw new Error('no terminal handoff');
        },
      );
      // A test port cannot actually terminate the process: observe fatal delivery separately
      // from the result promise, which cancellation is permitted to settle meanwhile.
      if (racingCancellation) await pending.catch(() => {});
      else {
        void pending.catch(() => {});
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      armed = false;
      fired = false;
      expect(attempts).toEqual([value]);
      expect(afterFault).toEqual([]);
      expect(delivery).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(projected).not.toHaveBeenCalled();
      expect(availability).not.toHaveBeenCalled();
    },
  );
});
