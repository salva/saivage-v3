import { describe, expect, it } from '@jest/globals';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createFastifyApp } from '../../src/server/composition/fastify-app.js';
import type { SaivageConfig } from '../../src/agents/config-api.js';

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

});
