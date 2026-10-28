import { expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntimeApplication } from '../../src/application/runtime-composition.js';
import { ProviderRegistry } from '../../src/agents/provider.js';
import { ModelRouter } from '../../src/agents/model-router.js';
import { bindRuntimeWorkflows } from '../../src/runtime/card-process/card-process-config.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { NO_FRESHNESS_EFFECTS } from '../../src/contracts/index.js';
import { CardService } from '../../src/cards/card-service.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { createTestConfigAuthority } from '../helpers/project-config.js';
import { unusedMcpToolInvocation } from '../helpers/llm-test-helpers.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { deferred } from '../../src/runtime/actors/deferred.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';

it.each([
  ['natural', 'paused'], ['close', 'paused'],
  ['natural', 'fresh stopped'], ['close', 'fresh stopped'],
  ['natural', 'post-Stop'], ['close', 'post-Stop'],
] as const)('actual application GC joins accepted Analyst webfetch (%s, %s) without a close cycle', async (mode, entry) => {
  const root = mkdtempSync(join(tmpdir(), 'gc-app-close-'));
  initProjectTree(root);
  const config = structuredClone(TEST_SAIVAGE_CONFIG);
  config.providers.test!.apiKey = 'synthetic'; config.providers.test!.baseUrl = 'https://provider.invalid/v1';
  const authority = createTestConfigAuthority(root, { config }), effective = authority.loadEffective();
  const registry = new ProviderRegistry(effective.config);
  const workflows = bindRuntimeWorkflows(effective.workflows, new ModelRouter(registry), registry,
    effective.config.compaction.context_utilization_fraction, { internalAnalystEnabled: true });
  const groups = new ManagedProcessGroupRegistry();
  const cards = new CardService(root, workflows, NO_FRESHNESS_EFFECTS);
  const app = createRuntimeApplication({ projectRoot: root, config: effective.config, workflows,
    configAuthority: authority, providerRegistry: registry, cardStore: cards, freshness: NO_FRESHNESS_EFFECTS,
    processIdentity: { pid: process.pid, startedAt: '2026-10-24T00:00:00.000Z' },
    processRunner: new ProcessRunner(root, groups, testApplicationFatalPort),
    runtimeProcessRootScope: groups.createContainerScope(groups.rootScope, 'runtime'),
    analystProcessRootScope: groups.createContainerScope(groups.rootScope, 'analyst'),
    analystStartup: { mode: 'internal' }, externalProjectIdentityDigest: null,
    analystSessionId: 'agent:analyst:global', mcpToolInvocation: unusedMcpToolInvocation,
    restartCapability: { available: false }, fatalPort: testApplicationFatalPort,
    assertWorkGcEntryIdle() {}, assertWorkGcReady() {},
    onExternalAnalystOwnerFailure(error) { throw error; }, onOversightOwnerFailure(error) { throw error; },
  });
  const toolEntered = deferred<void>(), releaseTool = deferred<void>();
  // Documentation-only literal address: OS lookup is local and the fetch below
  // never delegates to a network transport. No DNS fixture or validator override.
  const documentUrl = 'https://203.0.113.10/gc';
  let providerCalls = 0;
  const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async url => {
    if (String(url) === documentUrl) {
      toolEntered.resolve(); await releaseTool.promise;
      return new Response('Late canonical webfetch content.', { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    if (!String(url).endsWith('/chat/completions')) throw new Error(`Unexpected synthetic request: ${String(url)}`);
    providerCalls++;
    const message = providerCalls === 1 ? { role: 'assistant', content: null, tool_calls: [{ id: 'late-fetch', type: 'function',
      function: { name: 'webfetch', arguments: JSON.stringify({ url: documentUrl, save_as: 'project:///late-fetch.txt' }) } }] }
      : { role: 'assistant', content: 'The late write has settled.' };
    return new Response(JSON.stringify({ choices: [{ message, finish_reason: providerCalls === 1 ? 'tool_calls' : 'stop' }] }), { status: 200 });
  });
  let turn: Promise<unknown> | undefined, gc: Promise<unknown> | undefined;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    app.closeRuntimeAdmission(); app.processRunner.closeLaunchAdmission(); app.closeAnalystAdmission(); app.closeOversightAdmission();
    await Promise.all([app.cleanupRuntimeForApplicationStop(), app.cleanupWorkGc(), app.cleanupAnalystForApplicationStop(), app.cleanupOversightForApplicationStop()]);
  })();
  try {
    await app.runtimeApi.start();
    if (entry !== 'fresh stopped') {
      await app.runtimeApi.startProject(); app.runtimeApi.pause();
      for (let i = 0; i < 1000 && app.runtimeApi.getStatus().status !== 'paused'; i++) await new Promise<void>(resolve => setImmediate(resolve));
      expect(app.runtimeApi.getStatus().status).toBe('paused');
      if (entry === 'post-Stop') await app.runtimeApi.stopProject();
    }
    const entryStatus = entry === 'paused' ? 'paused' : 'stopped';
    expect(app.runtimeApi.getStatus().status).toBe(entryStatus);
    if (entry === 'fresh stopped') {
      // No Analyst getter/submission or autonomous launch has occurred yet.
      const idlePreview = await app.collectWorkGarbage({ mode: 'dry_run' }, new AbortController().signal);
      expect(idlePreview).toMatchObject({ disposition: 'completed', restoration: 'not_resumed' });
      expect(providerCalls).toBe(0);
      expect(app.runtimeApi.getRuntimeState()).toBeNull();
      expect(app.runtimeApi.getStatus().status).toBe('stopped');
    }
    const autonomous = jest.spyOn(app.runtimeApi, 'startProject');
    turn = app.analystRuntime.submit({ userContent: 'Fetch the synthetic document into the requested review record.' }).catch(error => error);
    await Promise.race([toolEntered.promise, turn.then(value => { throw new Error(`Synthetic turn ended before webfetch: ${JSON.stringify(value)}`); })]);
    const collect = jest.fn(async () => {
      expect(readFileSync(join(root, 'late-fetch.txt'), 'utf8')).toBe('Late canonical webfetch content.');
      expect(providerCalls).toBe(2);
    });
    gc = app.runWorkGc({ signal: new AbortController().signal, inventory: async () => undefined, collect }).catch(error => error);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(() => app.assertWorkGcIngressAllowed()).toThrow('busy'); expect(collect).not.toHaveBeenCalled();
    await expect(app.analystRuntime.submit({ userContent: 'Must refuse' })).rejects.toThrow('busy');
    await expect(app.runtimeApi.startProject()).rejects.toThrow('busy');
    expect(() => app.runtimeApi.resume()).toThrow('busy');
    expect(autonomous).toHaveBeenCalledTimes(1); // only the explicit refused attempt
    if (mode === 'close') {
      const closing = close();
      expect(await gc).toBeInstanceOf(Error); expect(collect).not.toHaveBeenCalled();
      releaseTool.resolve(); await turn; await closing;
      expect(collect).not.toHaveBeenCalled(); expect(app.runtimeApi.getStatus().status).toBe('stopped');
    } else {
      releaseTool.resolve(); await turn;
      expect(await gc).toMatchObject({ restoredRunning: false }); expect(collect).toHaveBeenCalledTimes(1);
      expect(app.runtimeApi.getStatus().status).toBe(entryStatus);
      // Use the same real registry as the application, with a bootstrap-owned
      // survivor outside the runtime/Analyst scopes. Stopped is not containment.
      const bootstrapScope = groups.createContainerScope(groups.rootScope, 'bootstrap-fixture');
      const bootstrapDirect = groups.createDirectScope(bootstrapScope, 'bootstrap-command', 'service_infrastructure');
      const survivor = app.processRunner.spawn({ command: 'sleep 30', directScope: bootstrapDirect,
        category: 'service_infrastructure', ownerId: 'bootstrap-fixture', ownerKind: 'runtime' });
      const scratch = join(root, '.saivage/work/cards/project/tmp');
      mkdirSync(scratch, { recursive: true }); const control = join(scratch, 'unselected'); writeFileSync(control, 'scratch');
      try {
        expect(app.processRunner.workGcProtection().retainAll).toBe(true);
        const preview = await app.collectWorkGarbage({ mode: 'dry_run' }, new AbortController().signal);
        expect(preview).toMatchObject({ disposition: 'completed', restoration: 'not_resumed', result: { would_delete_count: 0 } });
        const blockedDelete = await app.collectWorkGarbage({ mode: 'delete' }, new AbortController().signal);
        expect(blockedDelete).toMatchObject({ disposition: 'completed', result: { deleted_count: 0 } });
        expect(existsSync(control)).toBe(true);
        expect(existsSync(survivor.stdout_path)).toBe(true);
        expect(existsSync(survivor.stderr_path)).toBe(true);
      } finally {
        const report = await app.processRunner.terminateScopeTree({ rootScope: bootstrapScope,
          categories: ['service_infrastructure'], reason: 'synthetic GC fixture finished', graceMs: 50 });
        expect(report.failed).toHaveLength(0);
      }
      expect(app.processRunner.workGcProtection().retainAll).toBe(false);
      const deleted = await app.collectWorkGarbage({ mode: 'delete' }, new AbortController().signal);
      // Successful containment retires this ProcessRunner presentation. With
      // no canonical reference its two captures are now ordinary candidates.
      expect(deleted).toMatchObject({ disposition: 'completed', restoration: 'not_resumed', result: { deleted_count: 3 } });
      expect(existsSync(control)).toBe(false);
      expect(existsSync(survivor.stdout_path)).toBe(false);
      expect(existsSync(survivor.stderr_path)).toBe(false);
      expect(app.runtimeApi.getStatus().status).toBe(entryStatus);
      expect(providerCalls).toBe(2);
    }
  } finally {
    releaseTool.resolve(); await turn; await gc; await close(); fetch.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
