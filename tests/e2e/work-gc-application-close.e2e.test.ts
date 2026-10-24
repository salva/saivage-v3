import { expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
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

it.each(['natural', 'close'] as const)('actual application GC joins accepted Analyst webfetch (%s) without a close cycle', async mode => {
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
    await app.runtimeApi.start(); await app.runtimeApi.startProject(); app.runtimeApi.pause();
    for (let i = 0; i < 1000 && app.runtimeApi.getStatus().status !== 'paused'; i++) await new Promise<void>(resolve => setImmediate(resolve));
    expect(app.runtimeApi.getStatus().status).toBe('paused');
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
    if (mode === 'close') {
      const closing = close();
      expect(await gc).toBeInstanceOf(Error); expect(collect).not.toHaveBeenCalled();
      releaseTool.resolve(); await turn; await closing;
      expect(collect).not.toHaveBeenCalled(); expect(app.runtimeApi.getStatus().status).toBe('stopped');
    } else {
      releaseTool.resolve(); await turn;
      expect(await gc).toMatchObject({ restoredRunning: false }); expect(collect).toHaveBeenCalledTimes(1);
    }
  } finally {
    releaseTool.resolve(); await turn; await gc; await close(); fetch.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
