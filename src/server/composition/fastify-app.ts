import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Environment } from '../../config/index.js';
import { PublicationOutcomeUnknownError, type ApplicationFatalPort } from '../../contracts/index.js';

export async function createFastifyApp(environment: Environment, fatalPort: ApplicationFatalPort): Promise<FastifyInstance> {
  let transportOpt: { target: string; options: Record<string, unknown> } | undefined;
  if (environment.nodeEnv === 'development') {
    try {
      await import('pino-pretty');
      transportOpt = { target: 'pino-pretty', options: { colorize: true } };
    } catch (err) {
      console.warn(`pino-pretty not available, falling back to JSON transport: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const fastify = Fastify({ logger: { level: environment.server.logLevel, transport: transportOpt } });
  fastify.setErrorHandler((error, _request, _reply) => {
    if (error instanceof PublicationOutcomeUnknownError) fatalPort.publicationOutcomeUnknown(error);
    throw error;
  });
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    const rawBody = typeof body === 'string' ? body : body.toString('utf-8');
    if (rawBody.trim() === '') {
      done(null, null);
      return;
    }
    try {
      done(null, JSON.parse(rawBody));
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      (error as Error & { statusCode?: number }).statusCode = 400;
      done(error, undefined);
    }
  });

  await fastify.register(cors);
  await fastify.register(websocket);
  await registerStaticAssets(fastify);
  return fastify;
}

async function registerStaticAssets(fastify: FastifyInstance): Promise<void> {
  const thisFile = fileURLToPath(import.meta.url);
  const inDist = thisFile.includes('/dist/src/') || thisFile.includes('\\dist\\src\\');
  const packageRoot = fileURLToPath(new URL(inDist ? '../../../..' : '../../..', import.meta.url));
  const docsDistDir = join(packageRoot, 'docs', '.vitepress', 'dist');
  const docsBuilt = existsSync(docsDistDir);

  if (docsBuilt) {
    await fastify.register(fastifyStatic, { root: docsDistDir, prefix: '/docs/', wildcard: false, decorateReply: false });
    fastify.get('/docs', async (_request, reply) => reply.redirect('/docs/'));
  } else {
    const docsUnavailable = async (_request: FastifyRequest, reply: FastifyReply) => reply.status(404).send({ error: 'Documentation not built. Run vitepress build docs/ to generate.' });
    fastify.get('/docs/*', docsUnavailable);
    fastify.get('/docs', docsUnavailable);
  }

  const webDistDir = join(packageRoot, 'web', 'dist');
  if (existsSync(webDistDir)) {
    const webAssetsDir = join(webDistDir, 'assets');
    if (existsSync(webAssetsDir)) {
      await fastify.register(fastifyStatic, { root: webAssetsDir, prefix: '/assets/', decorateReply: false });
    }
    await fastify.register(fastifyStatic, { root: webDistDir, prefix: '/', wildcard: false, index: false });
    fastify.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/assets/')) return reply.status(404).send({ error: 'Static asset not found' });
      if (request.url === '/docs' || request.url.startsWith('/docs/')) {
        if (docsBuilt) return reply.callNotFound();
        return reply.status(404).send({ error: 'Documentation not built. Run vitepress build docs/ to generate.' });
      }
      if (request.url.startsWith('/api/')) return reply.status(404).send({ error: 'API route not found' });
      reply.sendFile('index.html');
    });
  }
}
