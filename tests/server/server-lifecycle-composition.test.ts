import { describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFastifyApp } from '../../src/server/composition/fastify-app.js';
import type { SaivageConfig } from '../../src/agents/config-api.js';
import { createAppTerminalCoordinator } from '../../src/boot/app.js';
import { loadEnvironment } from '../../src/config/environment.js';
import { McpManager } from '../../src/mcp/manager-api.js';
import { createServerServices } from '../../src/server/composition/server-services.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import * as YAML from 'yaml';
import { DEFAULT_CARD_PROCESSES } from '../../src/agents/default-card-processes.js';
import { registerServerRoutes } from '../../src/server/composition/route-composition.js';
import { RuntimeControlService } from '../../src/application/runtime-control-service.js';
import type { AppTerminalRegistration, ShutdownComponent } from '../../src/boot/app.js';
import { McpToolInvocationInstaller } from '../../src/mcp/tool-invocation-installation.js';

function config(): SaivageConfig {
  return {
    server: { host: '127.0.0.1', port: 8080 },
    models: { default: ['test-model'], max_tokens: { analyst: 200 } },
    providers: { test: { models: ['test-model'] } },
    providerFailoverOrder: [],
    mcpServers: {},
    runtime: { continuousImprovement: false },
    compaction: { enabled: true, input_budget_tokens: 1000, summarizer_candidate: { provider: 'test', account: null, model: 'test-model' } },
    card_processes: DEFAULT_CARD_PROCESSES,
  } as unknown as SaivageConfig;
}

describe('server lifecycle composition', () => {
  it('threads the exact server-owned EventBus through route composition and publishes contract violations on it', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-server-event-bus-'));
    const terminal = createAppTerminalCoordinator();
    let stopped = false;
    try {
      initProjectTree(projectRoot);
      writeFileSync(join(projectRoot, '.saivage', 'saivage.yaml'), validConfigYaml());
      const environment = await loadEnvironment(['node', 'test', '--project-root', projectRoot], { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent', SAIVAGE_API_TOKEN: undefined });
      const services = await createServerServices({ environment, terminal, processIdentity: { pid: 4242, startedAt: '2026-07-18T00:00:00.000Z' } });
      const published: unknown[] = [];
      const exactBusEmit = jest.spyOn(services.eventBus, 'emit');
      services.eventBus.subscribe('runtime_actionable_error', (event) => { published.push(event.payload); });
      jest.spyOn(services.runtimeApplication, 'getProviderRoutingReadModel').mockReturnValue({ invalid: 'response' } as never);

      registerServerRoutes({
        fastify: services.fastify,
        projectRoot: services.projectRoot,
        cardStore: services.cardStore,
        runtimeApplication: services.runtimeApplication,
        mcpManager: services.mcpManager,
        configAuthority: environment.configAuthority,
        saivageConfig: services.config,
        liveSyncSocket: services.liveSyncSocket,
        authPolicy: services.authPolicy,
        eventBus: services.eventBus,
      });

      const response = await services.fastify.inject({ method: 'GET', url: '/api/providers' });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: 'InternalServerError', message: 'Internal server error' });
      expect(exactBusEmit).toHaveBeenCalledWith('runtime_actionable_error', expect.any(Object));
      expect(published).toEqual([expect.objectContaining({
        actionable_error: expect.objectContaining({
          code: 'contract_response_violation',
          currentState: expect.objectContaining({ operation: 'providers.list' }),
        }),
      })]);

      expect((await terminal.stop()).warnings).toEqual([]);
      stopped = true;
    } finally {
      if (!stopped) await terminal.stop();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('serves built web assets instead of falling through to the SPA shell', async () => {
    const assetDir = join(process.cwd(), 'web', 'dist', 'assets');
    const assetName = existsSync(assetDir) ? readdirSync(assetDir).find((name) => name.endsWith('.js')) : undefined;
    if (!assetName) return;

    const fastify = await createFastifyApp({ ...config(), nodeEnv: 'test', projectRoot: process.cwd(), server: { logLevel: 'silent' } } as any);
    try {
      const assetResponse = await fastify.inject({ method: 'GET', url: `/assets/${assetName}` });
      expect(assetResponse.statusCode).toBe(200);
      expect(assetResponse.headers['content-type']).toContain('javascript');
      expect(assetResponse.body).not.toContain('<!DOCTYPE html>');

      const missingAssetResponse = await fastify.inject({ method: 'GET', url: '/assets/missing-wave010.js' });
      expect(missingAssetResponse.statusCode).toBe(404);
      expect(missingAssetResponse.headers['content-type']).toContain('application/json');
      expect(missingAssetResponse.json()).toEqual({ error: 'Static asset not found' });
    } finally {
      await fastify.close();
    }
  });

  it('closes runtime admission once before runtime and Fastify cleanup while disposing LiveSync once', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-server-cleanup-'));
    const startupOrder: string[] = [];
    const originalReconcile = McpManager.prototype.reconcilePersistedConfig;
    const reconciliation = jest.spyOn(McpManager.prototype, 'reconcilePersistedConfig').mockImplementation(async function (this: McpManager) {
      const report = await originalReconcile.call(this);
      startupOrder.push('reconciled');
      return report;
    });
    const originalInstall = McpToolInvocationInstaller.prototype.install;
    const install = jest.spyOn(McpToolInvocationInstaller.prototype, 'install').mockImplementation(function (this: McpToolInvocationInstaller, authority) {
      startupOrder.push('installed');
      return originalInstall.call(this, authority);
    });
    const originalRuntimeStart = RuntimeControlService.prototype.start;
    const runtimeStart = jest.spyOn(RuntimeControlService.prototype, 'start').mockImplementation(async function (this: RuntimeControlService) {
      await originalRuntimeStart.call(this);
      startupOrder.push('runtime-started');
    });
    try {
      initProjectTree(projectRoot);
      writeFileSync(join(projectRoot, '.saivage', 'saivage.yaml'), validConfigYaml());
      const environment = await loadEnvironment(['node', 'test', '--project-root', projectRoot], { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent', SAIVAGE_API_TOKEN: undefined });
      const terminal = createAppTerminalCoordinator();
      const services = await createServerServices({ environment, terminal, processIdentity: { pid: 4242, startedAt: '2026-07-18T00:00:00.000Z' } });
      expect(startupOrder).toEqual(['reconciled', 'installed', 'runtime-started']);
      expect(reconciliation).toHaveBeenCalledTimes(1);
      expect(install).toHaveBeenCalledTimes(1);
      expect(runtimeStart).toHaveBeenCalledTimes(1);
      const order: string[] = [];
      const sharedRunner = services.runtimeApplication.processRunner;
      const terminateScopeTree = jest.spyOn(sharedRunner, 'terminateScopeTree');
      const closeRuntimeAdmission = services.runtimeApplication.closeRuntimeAdmission.bind(services.runtimeApplication);
      const runtimeAdmissionClose = jest.spyOn(services.runtimeApplication, 'closeRuntimeAdmission').mockImplementation(() => {
        order.push('runtime-admission');
        closeRuntimeAdmission();
      });
      const cleanupRuntime = services.runtimeApplication.cleanupRuntimeForApplicationStop.bind(services.runtimeApplication);
      const runtimeCleanup = jest.spyOn(services.runtimeApplication, 'cleanupRuntimeForApplicationStop').mockImplementation(async () => {
        order.push('runtime');
        await cleanupRuntime();
      });
      const cleanupAnalyst = services.runtimeApplication.cleanupAnalystForApplicationStop.bind(services.runtimeApplication);
      const analystCleanup = jest.spyOn(services.runtimeApplication, 'cleanupAnalystForApplicationStop').mockImplementation(async () => {
        order.push('analyst');
        await cleanupAnalyst();
      });
      const cleanupMcp = services.mcpManager.cleanupForApplicationStop.bind(services.mcpManager);
      const mcpCleanup = jest.spyOn(services.mcpManager, 'cleanupForApplicationStop').mockImplementation(async () => {
        order.push('mcp');
        await cleanupMcp();
      });
      const liveDispose = jest.spyOn(services.liveSyncSocket, 'dispose').mockImplementation(() => { order.push('live-sync'); });
      const fastifyClose = jest.spyOn(services.fastify, 'close').mockImplementation((closeListener?: () => void) => { order.push('fastify'); closeListener?.(); return undefined; });

      expect((await terminal.stop()).warnings).toEqual([]);
      expect(order.indexOf('runtime-admission')).toBeLessThan(order.indexOf('runtime'));
      expect(order.indexOf('runtime-admission')).toBeLessThan(order.indexOf('fastify'));
      expect(order.indexOf('live-sync')).toBeLessThan(order.indexOf('fastify'));
      expect(order.indexOf('mcp')).toBeLessThan(order.indexOf('analyst'));
      expect(order.indexOf('mcp')).toBeLessThan(order.indexOf('runtime'));
      expect(runtimeAdmissionClose).toHaveBeenCalledTimes(1);
      expect(runtimeCleanup).toHaveBeenCalledTimes(1);
      expect(analystCleanup).toHaveBeenCalledTimes(1);
      expect(mcpCleanup).toHaveBeenCalledTimes(1);
      expect(liveDispose).toHaveBeenCalledTimes(1);
      expect(fastifyClose).toHaveBeenCalledTimes(1);
      expect(terminateScopeTree).toHaveBeenCalledTimes(2);
      const containmentCalls = terminateScopeTree.mock.calls.map(([input]) => input);
      expect(containmentCalls.map(({ categories, reason, graceMs }) => ({ categories, reason, graceMs }))).toEqual([
        { categories: ['service_infrastructure'], reason: 'application stopping', graceMs: 5_000 },
        { categories: ['runtime_card'], reason: 'application stopping', graceMs: 5_000 },
      ]);
      expect(new Set(containmentCalls.map(({ rootScope }) => rootScope)).size).toBe(2);
    } finally {
      reconciliation.mockRestore();
      install.mockRestore();
      runtimeStart.mockRestore();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it.each([
    { outcome: 'rejected reconciliation', rejection: new Error('MCP startup allocation failed') },
    { outcome: 'non-converged reconciliation', rejection: new Error('MCP startup did not converge to persisted configuration.') },
  ])('cleans up MCP through the App terminal path after $outcome', async ({ outcome, rejection }) => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-server-mcp-startup-failure-'));
    const terminal = createAppTerminalCoordinator();
    const markers: string[] = [];
    const reconciliation = jest.spyOn(McpManager.prototype, 'reconcilePersistedConfig').mockImplementation(async () => {
      markers.push('allocation-started');
      if (outcome === 'rejected reconciliation') throw rejection;
      return {
        converged: false,
        desired: [],
        active: [],
        pending: [{ name: 'test-server', operation: 'start', diagnostic: 'Test startup remained pending.' }],
      };
    });
    const mcpCleanup = jest.spyOn(McpManager.prototype, 'cleanupForApplicationStop');
    const runtimeStart = jest.spyOn(RuntimeControlService.prototype, 'start');
    const install = jest.spyOn(McpToolInvocationInstaller.prototype, 'install');
    let stopped = false;
    try {
      initProjectTree(projectRoot);
      writeFileSync(join(projectRoot, '.saivage', 'saivage.yaml'), validConfigYaml());
      const environment = await loadEnvironment(['node', 'test', '--project-root', projectRoot], { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent', SAIVAGE_API_TOKEN: undefined });

      await expect(createServerServices({ environment, terminal, processIdentity: { pid: 4242, startedAt: '2026-07-18T00:00:00.000Z' } })).rejects.toThrow(rejection.message);
      expect(markers).toEqual(['allocation-started']);
      expect(install).not.toHaveBeenCalled();
      expect(runtimeStart).not.toHaveBeenCalled();

      expect((await terminal.stop()).warnings).toEqual([]);
      stopped = true;
      expect(mcpCleanup).toHaveBeenCalledTimes(1);
    } finally {
      if (!stopped) await terminal.stop();
      reconciliation.mockRestore();
      mcpCleanup.mockRestore();
      runtimeStart.mockRestore();
      install.mockRestore();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('installs converged MCP before runtime start and cleans post-install start failure in reverse component order', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-server-runtime-startup-failure-'));
    const coordinator = createAppTerminalCoordinator();
    const cleanupOrder: string[] = [];
    const terminal: AppTerminalRegistration = {
      registerAdmissionCloser: (component, close) => coordinator.registerAdmissionCloser(component, close),
      registerCleanupLeaf: (component: ShutdownComponent, cleanup) => coordinator.registerCleanupLeaf(component, async () => {
        if (component === 'runtime' || component === 'analyst' || component === 'mcp') cleanupOrder.push(component);
        await cleanup();
      }),
      isApplicationClosing: () => coordinator.isApplicationClosing(),
    };
    const markers: string[] = [];
    const reconciliation = jest.spyOn(McpManager.prototype, 'reconcilePersistedConfig').mockImplementation(async () => {
      markers.push('reconciled');
      return { converged: true, desired: [], active: [], pending: [] };
    });
    const startError = new Error('runtime startup failed after MCP installation');
    const originalInstall = McpToolInvocationInstaller.prototype.install;
    const install = jest.spyOn(McpToolInvocationInstaller.prototype, 'install').mockImplementation(function (this: McpToolInvocationInstaller, authority) {
      markers.push('installed');
      return originalInstall.call(this, authority);
    });
    const runtimeStart = jest.spyOn(RuntimeControlService.prototype, 'start').mockImplementation(async () => {
      markers.push('runtime-start');
      throw startError;
    });
    let stopped = false;
    try {
      initProjectTree(projectRoot);
      writeFileSync(join(projectRoot, '.saivage', 'saivage.yaml'), validConfigYaml());
      const environment = await loadEnvironment(['node', 'test', '--project-root', projectRoot], { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent', SAIVAGE_API_TOKEN: undefined });

      await expect(createServerServices({ environment, terminal, processIdentity: { pid: 4242, startedAt: '2026-07-18T00:00:00.000Z' } })).rejects.toBe(startError);
      expect(markers).toEqual(['reconciled', 'installed', 'runtime-start']);
      expect(reconciliation).toHaveBeenCalledTimes(1);
      expect(install).toHaveBeenCalledTimes(1);
      expect(runtimeStart).toHaveBeenCalledTimes(1);

      expect((await coordinator.stop()).warnings).toEqual([]);
      stopped = true;
      expect(cleanupOrder).toEqual(['mcp', 'analyst', 'runtime']);
      expect(reconciliation).toHaveBeenCalledTimes(1);
      expect(install).toHaveBeenCalledTimes(1);
      expect(runtimeStart).toHaveBeenCalledTimes(1);
    } finally {
      if (!stopped) await coordinator.stop();
      reconciliation.mockRestore();
      install.mockRestore();
      runtimeStart.mockRestore();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

});

function validConfigYaml(): string {
  return YAML.stringify({ models: { default: ['test-model'], max_tokens: { analyst: 200 } }, providers: { test: { models: ['test-model'] } }, compaction: { enabled: true, input_budget_tokens: 1000, summarizer_candidate: { provider: 'test', account: null, model: 'test-model' } }, card_processes: DEFAULT_CARD_PROCESSES, runtime: { continuous_improvement: false } });
}
