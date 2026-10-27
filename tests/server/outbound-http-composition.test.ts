import { describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { OutboundHttpEvent } from '../../src/contracts/index.js';
import { createFastifyApp } from '../../src/server/composition/fastify-app.js';
import { createProjectIdentity } from '../../src/persistence/project-identity.js';
import { replaceConfigYaml } from '../../src/config/config-file.js';
import { loadEnvironment } from '../../src/config/environment.js';
import { publishTestProjectRuntime as publishInitialProjectRuntime } from '../helpers/initial-project-fixture.js';
import { createTestProcessRunner } from '../helpers/test-process-runner.js';
import { compileProjectWorkflows } from '../../src/runtime/card-process/card-process-config.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { deferred, assertLifecycles, assertPrivateMetadata } from '../helpers/http-lifecycle.js';

const records: OutboundHttpEvent[] = [];
const fastifyFactory = jest.fn<typeof createFastifyApp>();
// Retain real Fastify creation and emitter projection on successful startup.
// The local factory seam also controls scheduling/failure; never open a listener.
jest.unstable_mockModule('../../src/server/composition/fastify-app.js', () => ({
  createFastifyApp: fastifyFactory,
}));
const { createServerServices } = await import('../../src/server/composition/server-services.js');
const { createAppTerminalCoordinator } = await import('../../src/boot/app.js');

type StartupOutcome =
  | { status: 'fulfilled'; services: Awaited<ReturnType<typeof createServerServices>> }
  | { status: 'rejected'; error: unknown };

async function runCompositionScenario(options: {
  holdFactory?: boolean;
  pendingError?: Error;
  factoryError?: Error;
  lifecycle?: string[];
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'server-http-'));
  const terminal = createAppTerminalCoordinator();
  const initializeDispatched = deferred<void>();
  const headersRelease = deferred<void>();
  const factoryEntered = deferred<void>();
  const factoryRelease = deferred<void>();
  let startup: Promise<StartupOutcome> | undefined;
  let settled = false;
  try {
    records.length = 0;
    fastifyFactory.mockReset();
    fastifyFactory.mockImplementation(async (...args) => {
      // Reject before allocating an instance that composition cannot yet own.
      if (options.factoryError) throw options.factoryError;
      const app = await createFastifyApp(...args);
      jest.spyOn(app.log, 'info').mockImplementation((fields: unknown) => {
        if (typeof fields === 'object' && fields !== null && 'event' in fields) records.push(JSON.parse(JSON.stringify(fields)));
      });
      factoryEntered.resolve();
      if (options.holdFactory) await factoryRelease.promise;
      return app;
    });
    const config = structuredClone(TEST_SAIVAGE_CONFIG); config.oversight.enabled = false;
    config.mcpServers = { 'secret-server': { transport: 'streamable-http', url: 'https://secret-host.invalid/secret-path?secret-query#secret-fragment', autostart: true, disabled: false } };
    createProjectIdentity(root, 'Offline composition'); replaceConfigYaml(join(root, '.saivage/saivage.yaml'), config);
    publishInitialProjectRuntime(root, compileProjectWorkflows(config));
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init!.body));
      if (body.method === 'initialize') {
        initializeDispatched.resolve();
        await headersRelease.promise;
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18' } }), { headers: { 'content-type': 'application/json' } });
      }
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: body.method === 'tools/list' ? { tools: [] } : {} }), { headers: { 'content-type': 'application/json' } });
    });
    const environment = await loadEnvironment({ projectRoot: root, createRuntime: false }, { NODE_ENV: 'test', LOG_LEVEL: 'info' });
    const processes = createTestProcessRunner(root);
    terminal.registerAdmissionCloser('process-admission', () => processes.processRunner.closeLaunchAdmission());
    startup = createServerServices({ processRegistry: processes.registry, processRunner: processes.processRunner, onExternalAnalystOwnerFailure(error) { throw error; }, environment, terminal, processIdentity: { pid: 42, startedAt: '2026-10-14T00:00:00.000Z' }, fatalPort: testApplicationFatalPort, onOversightOwnerFailure: error => { throw error; } }).then(
      services => {
        settled = true;
        options.lifecycle?.push('startup fulfilled');
        return { status: 'fulfilled' as const, services };
      },
      error => {
        settled = true;
        options.lifecycle?.push('startup rejected');
        return { status: 'rejected' as const, error };
      },
    );
    if (options.holdFactory) {
      const entry = await Promise.race([factoryEntered.promise.then(() => 'entered' as const), startup]);
      if (entry !== 'entered') {
        if (entry.status === 'rejected') throw entry.error;
        throw new Error('Startup completed before Fastify factory entry.');
      }
      expect(fetch).not.toHaveBeenCalled();
      expect(settled).toBe(false);
      factoryRelease.resolve();
    }
    const dispatch = await Promise.race([initializeDispatched.promise.then(() => 'dispatched' as const), startup]);
    if (dispatch !== 'dispatched') {
      expect(fetch).not.toHaveBeenCalled();
      if (dispatch.status === 'rejected') throw dispatch.error;
      throw new Error('Startup completed before initialize dispatch.');
    }
    expect(fetch).toHaveBeenCalledTimes(1); expect(settled).toBe(false);
    expect(records).toHaveLength(1); expect(records[0]).toMatchObject({ event: 'outbound_http_dispatch', service: 'mcp', purpose: 'mcp-initialize', method: 'POST' });
    const initialize = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
    expect(initialize.method).toBe('initialize');
    if (options.pendingError) throw options.pendingError;
    headersRelease.resolve();
    const outcome = await startup;
    if (outcome.status === 'rejected') throw outcome.error;
    const services = outcome.services;
    expect(services.fastify.server.listening).toBe(false); assertLifecycles(records, 3);
    for (const r of records) { expect(r).not.toHaveProperty('source_session'); expect(r).not.toHaveProperty('source_card'); expect(r).not.toHaveProperty('input_id'); }
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.map(([, init]) => [init!.method, JSON.parse(String(init!.body)).method])).toEqual([['POST', 'initialize'], ['POST', 'notifications/initialized'], ['POST', 'tools/list']]);
    assertPrivateMetadata(records, ['secret-server', 'secret-host', 'secret-path', 'secret-query', 'secret-fragment']);
  } finally {
    // Startup owns registration until it settles, even after an assertion fails.
    factoryRelease.resolve();
    headersRelease.resolve();
    try {
      if (startup) {
        await startup;
        expect(settled).toBe(true);
      }
    } finally {
      try {
        options.lifecycle?.push('stop');
        const report = await terminal.stop();
        expect(report.warnings).toEqual([]);
        options.lifecycle?.push('stopped without warnings');
      } finally {
        try {
          jest.restoreAllMocks();
          fastifyFactory.mockReset();
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    }
  }
}

describe('offline server outbound sink composition', () => {
  it('actual Fastify sink is available during pending autostart before readiness, even with its factory held, without a listener/provider', async () => {
    await runCompositionScenario({ holdFactory: true });
  });

  it('preserves a pending-phase assertion failure while joining startup before clean stop', async () => {
    const sentinel = new Error('Pending-phase assertion sentinel');
    const lifecycle: string[] = [];
    await expect(runCompositionScenario({ pendingError: sentinel, lifecycle })).rejects.toBe(sentinel);
    expect(lifecycle).toEqual(['startup fulfilled', 'stop', 'stopped without warnings']);
  });

  it('surfaces factory rejection before initialize dispatch without allocating Fastify', async () => {
    const sentinel = new Error('Fastify factory rejection sentinel');
    const lifecycle: string[] = [];
    await expect(runCompositionScenario({ factoryError: sentinel, lifecycle })).rejects.toBe(sentinel);
    expect(records).toEqual([]);
    expect(lifecycle).toEqual(['startup rejected', 'stop', 'stopped without warnings']);
  });
});
