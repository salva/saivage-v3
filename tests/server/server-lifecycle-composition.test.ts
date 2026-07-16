import { describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFastifyApp } from '../../src/server/composition/fastify-app.js';
import type { SaivageConfig } from '../../src/agents/config-api.js';
import { createAppTerminalCoordinator } from '../../src/boot/app.js';
import { loadEnvironment } from '../../src/config/environment.js';
import { createServerServices } from '../../src/server/composition/server-services.js';
import { initProjectTree } from '../helpers/canonical-project.js';

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

  it('disposes LiveSync once before independently closing Fastify once', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-server-cleanup-'));
    try {
      initProjectTree(projectRoot);
      writeFileSync(join(projectRoot, '.saivage', 'saivage.yaml'), 'models:\n  default: [test-model]\nproviders: {}\nruntime:\n  continuous_improvement: false\n');
      const environment = await loadEnvironment(['node', 'test', '--project-root', projectRoot], { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent', SAIVAGE_API_TOKEN: undefined });
      const terminal = createAppTerminalCoordinator();
      const services = await createServerServices({ environment, terminal });
      const order: string[] = [];
      const liveDispose = jest.spyOn(services.liveSyncSocket, 'dispose').mockImplementation(() => { order.push('live-sync'); });
      const fastifyClose = jest.spyOn(services.fastify, 'close').mockImplementation((closeListener?: () => void) => { order.push('fastify'); closeListener?.(); return undefined; });

      expect((await terminal.stop()).warnings).toEqual([]);
      expect(order.indexOf('live-sync')).toBeLessThan(order.indexOf('fastify'));
      expect(liveDispose).toHaveBeenCalledTimes(1);
      expect(fastifyClose).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

});
