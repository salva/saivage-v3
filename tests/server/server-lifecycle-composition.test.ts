import { describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFastifyApp } from '../../src/server/composition/fastify-app.js';
import { stopServerResources } from '../../src/server/composition/server-shutdown.js';
import { startRuntimeApplication } from '../../src/server/composition/runtime-lifecycle.js';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import type { SaivageConfig } from '../../src/agents/config-api.js';
import { EventBus } from '../../src/events/bus.js';
import { CardStore } from '../../src/cards/store-api.js';
import { EventLogger, ErrorLogger } from '../../src/observability/index.js';

function config(): SaivageConfig {
  return {
    server: { host: '127.0.0.1', port: 8080 },
    models: { default: ['test-model'] },
    providers: {},
    providerFailoverOrder: [],
    mcpServers: {},
    runtime: { continuousImprovement: false },
  } as unknown as SaivageConfig;
}

describe('server lifecycle composition', () => {
  it('throws runtime application startup failures', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-runtime-startup-fail-'));
    const fastify = { log: { info: jest.fn(), warn: jest.fn() } } as any;
    const eventBus = new EventBus();
    try {
      await expect(startRuntimeApplication({ projectRoot: root, config: { ...config(), runtime: undefined } as unknown as SaivageConfig, eventBus, eventLogger: new EventLogger(join(root, '.saivage')), errorLogger: new ErrorLogger(join(root, '.saivage')), cardStore: new CardStore(root, undefined, eventBus), fastify })).rejects.toThrow();
      expect(fastify.log.warn).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
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

  it('stops owned resources in reset, fastify, telegram, mcp, runtime order while tolerating later failures', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-shutdown-order-'));
    initProjectTree(root);
    const calls: string[] = [];
    const fastify = { close: jest.fn(async () => { calls.push('fastify'); }), log: { info: jest.fn(), warn: jest.fn() } } as any;
    const telegramBot = { stop: jest.fn(async () => { calls.push('telegram'); throw new Error('telegram stop failed'); }) } as any;
    const mcpManager = { stopAll: jest.fn(async () => { calls.push('mcp'); }) } as any;
    const runtimeApplication = { runtimeApi: { shutdown: jest.fn(async () => { calls.push('runtime'); }) } } as any;
    try {
      await stopServerResources({ projectRoot: root, fastify, telegramBot, mcpManager, runtimeApplication });
      expect(calls).toEqual(['fastify', 'telegram', 'mcp', 'runtime']);
      expect(fastify.log.warn).toHaveBeenCalledWith(expect.stringContaining('Telegram bot stop failed'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
