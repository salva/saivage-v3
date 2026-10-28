import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import { createFastifyApp } from '../../../src/server/composition/fastify-app.js';
import type { Environment } from '../../../src/config/index.js';

const pagesRoot = process.env.SAIVAGE_BRAND_PAGES_DIST;
if (!pagesRoot) throw new Error('Build isolated DOCS_BASE=/saivage-v3/ docs and set SAIVAGE_BRAND_PAGES_DIST');
const app = await createFastifyApp({
  nodeEnv: 'test', server: { host: '127.0.0.1', port: 0, logLevel: 'silent' },
} as Environment, { publicationOutcomeUnknown(error): never { throw error; } });
await app.register(fastifyStatic, { root: resolve(pagesRoot), prefix: '/saivage-v3/', decorateReply: false });
await app.listen({ host: '127.0.0.1', port: 4189 });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void app.close().then(() => process.exit(0)); });
}
