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

function config(): SaivageConfig {
  return {
    server: { host: '127.0.0.1', port: 8080 },
    models: { default: ['test-model'], max_tokens: { analyst: 200 } },
    providers: { test: { models: ['test-model'] } },
    providerFailoverOrder: [],
    mcpServers: {},
    runtime: { continuousImprovement: false },
    compaction: { enabled: true, input_budget_tokens: 1000, summarizer_candidate: { provider: 'test', account: null, model: 'test-model' } },
  } as unknown as SaivageConfig;
}

describe('server lifecycle composition', () => {
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
    try {
      initProjectTree(projectRoot);
      writeFileSync(join(projectRoot, '.saivage', 'saivage.yaml'), validConfigYaml());
      const environment = await loadEnvironment(['node', 'test', '--project-root', projectRoot], { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent', SAIVAGE_API_TOKEN: undefined });
      const terminal = createAppTerminalCoordinator();
      const services = await createServerServices({ environment, terminal, processIdentity: { pid: 4242, startedAt: '2026-07-18T00:00:00.000Z' } });
      const order: string[] = [];
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
    } finally {
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
    let stopped = false;
    try {
      initProjectTree(projectRoot);
      writeFileSync(join(projectRoot, '.saivage', 'saivage.yaml'), validConfigYaml());
      const environment = await loadEnvironment(['node', 'test', '--project-root', projectRoot], { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent', SAIVAGE_API_TOKEN: undefined });

      await expect(createServerServices({ environment, terminal, processIdentity: { pid: 4242, startedAt: '2026-07-18T00:00:00.000Z' } })).rejects.toThrow(rejection.message);
      expect(markers).toEqual(['allocation-started']);

      expect((await terminal.stop()).warnings).toEqual([]);
      stopped = true;
      expect(mcpCleanup).toHaveBeenCalledTimes(1);
    } finally {
      if (!stopped) await terminal.stop();
      reconciliation.mockRestore();
      mcpCleanup.mockRestore();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

});

function validConfigYaml(): string {
  return 'models:\n  default: [test-model]\n  max_tokens:\n    analyst: 200\nproviders:\n  test:\n    models: [test-model]\ncompaction:\n  enabled: true\n  input_budget_tokens: 1000\n  summarizer_candidate:\n    provider: test\n    account: null\n    model: test-model\nruntime:\n  continuous_improvement: false\n';
}
