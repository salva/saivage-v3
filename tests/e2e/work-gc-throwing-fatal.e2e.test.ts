import { expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createRuntimeApplication } from '../../src/application/runtime-composition.js';
import { ProviderRegistry } from '../../src/agents/provider.js';
import { ModelRouter } from '../../src/agents/model-router.js';
import { bindRuntimeWorkflows } from '../../src/runtime/card-process/card-process-config.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { NO_FRESHNESS_EFFECTS, PublicationOutcomeUnknownError, WorkGcFrameSchema } from '../../src/contracts/index.js';
import { CardService } from '../../src/cards/card-service.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { createTestConfigAuthority } from '../helpers/project-config.js';
import { unusedMcpToolInvocation } from '../helpers/llm-test-helpers.js';
import { testApplicationFatalPort, testApplicationFatalDelivery } from '../helpers/test-application-fatal-port.js';
import { ContractFrameStream } from '../../src/server/contract-stream.js';
import { buildWorkGcOperatorContractHandlers } from '../../src/server/routes/operator-work-gc-handlers.js';
import { deferred } from '../../src/runtime/actors/deferred.js';

it('throwing fatal port bypasses real application/Supervisor release and every transport follow-up', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gc-throwing-port-')); initProjectTree(root);
  const authority = createTestConfigAuthority(root), effective = authority.loadEffective();
  const registry = new ProviderRegistry(effective.config);
  const workflows = bindRuntimeWorkflows(effective.workflows, new ModelRouter(registry), registry,
    effective.config.compaction.context_utilization_fraction, { internalAnalystEnabled: true });
  const groups = new ManagedProcessGroupRegistry();
  const fatal = jest.fn(testApplicationFatalPort.publicationOutcomeUnknown);
  const fatalPort = { publicationOutcomeUnknown: fatal };
  const app = createRuntimeApplication({ projectRoot: root, config: effective.config, workflows,
    configAuthority: authority, providerRegistry: registry, cardStore: new CardService(root, workflows, NO_FRESHNESS_EFFECTS), freshness: NO_FRESHNESS_EFFECTS,
    processIdentity: { pid: process.pid, startedAt: '2026-11-11T00:00:00.000Z' },
    processRunner: new ProcessRunner(root, groups, fatalPort),
    runtimeProcessRootScope: groups.createContainerScope(groups.rootScope, 'runtime'),
    analystProcessRootScope: groups.createContainerScope(groups.rootScope, 'analyst'),
    analystStartup: { mode: 'internal' }, externalProjectIdentityDigest: null,
    analystSessionId: 'agent:analyst:global', mcpToolInvocation: unusedMcpToolInvocation,
    restartCapability: { available: false }, fatalPort, assertWorkGcEntryIdle() {}, assertWorkGcReady() {},
    onExternalAnalystOwnerFailure(error) { throw error; }, onOversightOwnerFailure(error) { throw error; },
  });
  const original = app.runWorkGc.bind(app);
  const uncertainty = new PublicationOutcomeUnknownError(new Error('synthetic publication uncertainty'));
  const settled = deferred<unknown>();
  const run = jest.spyOn(app, 'runWorkGc').mockImplementation(input => {
    const task = original({ ...input, collect: async () => { throw uncertainty; } });
    void task.then(settled.resolve, settled.resolve); return task;
  });
  const stream = new ContractFrameStream(WorkGcFrameSchema), raw = new EventEmitter(), reply = new EventEmitter();
  const finish = jest.spyOn(stream, 'finish'), destroy = jest.spyOn(stream.body, 'destroy');
  const handler = buildWorkGcOperatorContractHandlers(app)['runtime.gcWork'];
  try {
    await app.runtimeApi.start();
    handler({ body: { mode: 'delete' }, request: { raw }, reply: { raw: reply,
      createStream: () => stream } } as unknown as Parameters<typeof handler>[0]);
    expect(await settled.promise).toBe(testApplicationFatalDelivery);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(fatal).toHaveBeenCalledTimes(1); expect(fatal).toHaveBeenCalledWith(uncertainty);
    expect(stream.fatal).toBe(true); expect(finish).not.toHaveBeenCalled(); expect(destroy).not.toHaveBeenCalled();
    expect(() => app.assertWorkGcIngressAllowed()).toThrow('busy');
    expect(() => app.collectWorkGarbage({ mode: 'dry_run' }, new AbortController().signal)).toThrow('busy');
    expect(raw.listenerCount('aborted')).toBe(1); expect(reply.listenerCount('close')).toBe(1);
    reply.emit('close'); expect(finish).not.toHaveBeenCalled(); expect(destroy).not.toHaveBeenCalled();
  } finally {
    // No application cleanup/hold release after the fatal sentinel. Only this
    // test's detached synthetic filesystem is removed, with no active runtime.
    run.mockRestore(); rmSync(root, { recursive: true, force: true });
  }
});
