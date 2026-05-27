import { describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stopServerResources } from '../../src/server/composition/server-shutdown.js';
import { startActiveRuntime } from '../../src/server/composition/runtime-lifecycle.js';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import type { SaivageConfig } from '../../src/agents/index.js';

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
  it('records ActiveRuntime startup failure without throwing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-runtime-startup-fail-'));
    const fastify = { log: { info: jest.fn(), warn: jest.fn() } } as any;
    try {
      const result = await startActiveRuntime({ createRuntime: true, projectRoot: root, saivageConfig: { ...config(), runtime: undefined } as unknown as SaivageConfig, fastify });
      expect(result.activeRuntime).toBeUndefined();
      expect(result.startupFailure).toEqual(expect.objectContaining({ code: 'active-runtime-start-failed' }));
      expect(fastify.log.warn).toHaveBeenCalledWith(expect.stringContaining('ActiveRuntime initialization failed'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('starts no runtime when runtime creation is disabled', async () => {
    const result = await startActiveRuntime({ createRuntime: false, projectRoot: '/tmp/project', saivageConfig: config(), fastify: { log: { info: jest.fn(), warn: jest.fn() } } as any });
    expect(result).toEqual({});
  });

  it('stops owned resources in reset, fastify, telegram, mcp, runtime order while tolerating later failures', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-shutdown-order-'));
    initProjectTree(root);
    const calls: string[] = [];
    const fastify = { close: jest.fn(async () => { calls.push('fastify'); }), log: { info: jest.fn(), warn: jest.fn() } } as any;
    const telegramBot = { stop: jest.fn(async () => { calls.push('telegram'); throw new Error('telegram stop failed'); }) } as any;
    const mcpManager = { stopAll: jest.fn(async () => { calls.push('mcp'); }) } as any;
    const activeRuntime = { runtime: { eventBus: {} }, stop: jest.fn(async () => { calls.push('runtime'); }) } as any;
    try {
      await stopServerResources({ projectRoot: root, fastify, telegramBot, mcpManager, activeRuntime });
      expect(calls).toEqual(['fastify', 'telegram', 'mcp', 'runtime']);
      expect(fastify.log.warn).toHaveBeenCalledWith(expect.stringContaining('Telegram bot stop failed'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
