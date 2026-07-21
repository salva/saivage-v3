import { describe, expect, it } from '@jest/globals';
import { createFastifyApp } from '../../src/server/composition/fastify-app.js';
import { AppLogPublicationError } from '../../src/persistence/app-log.js';

describe('Fastify app-log publication root', () => {
  it('returns only the fixed 500 body without exposing causes', async () => {
    const marker = 'hostile-publication-cause';
    const fastify = await createFastifyApp({ nodeEnv: 'test', projectRoot: process.cwd(), server: { logLevel: 'silent' } } as never);
    fastify.get('/publication-failure', async () => { throw new AppLogPublicationError('event', new Error(marker)); });
    try {
      const response = await fastify.inject({ method: 'GET', url: '/publication-failure' });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: 'InternalServerError', message: 'Internal server error' });
      expect(response.body).not.toContain(marker);
    } finally { await fastify.close(); }
  });
});
