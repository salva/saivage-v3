#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Environment } from '../../src/config/index.js';
import type { ApplicationFatalPort } from '../../src/contracts/index.js';
import { createFastifyApp } from '../../src/server/composition/fastify-app.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const docsIndex = readFileSync(join(packageRoot, 'docs', '.vitepress', 'dist', 'runbook', 'index.html'));
const webIndexPath = join(packageRoot, 'web', 'dist', 'index.html');
const webIndex = readFileSync(webIndexPath);
const assetPath = webIndex.toString('utf8').match(/(?:src|href)="(\/assets\/[^"?#]+\.(?:js|css))[^" ]*"/)?.[1];
assert(assetPath, `${webIndexPath} does not reference a built JavaScript or CSS asset`);
const assetBytes = readFileSync(join(packageRoot, 'web', 'dist', assetPath));
const assetContentType = assetPath.endsWith('.js') ? 'application/javascript' : 'text/css';

const environment = {
  nodeEnv: 'test',
  server: { host: '127.0.0.1', port: 0, logLevel: 'silent' },
} as Environment;
const fatalPort: ApplicationFatalPort = {
  publicationOutcomeUnknown(error): never {
    throw error;
  },
};

const app = await createFastifyApp(environment, fatalPort);
try {
  await app.ready();

  const docsResponse = await app.inject({ method: 'GET', url: '/docs/runbook/' });
  assert.equal(docsResponse.statusCode, 200);
  assert.match(docsResponse.headers['content-type'] ?? '', /^text\/html\b/);
  assert.deepEqual(docsResponse.rawPayload, docsIndex);

  for (const url of ['/', '/cards']) {
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 200, `GET ${url}`);
    assert.match(response.headers['content-type'] ?? '', /^text\/html\b/, `GET ${url}`);
    assert.deepEqual(response.rawPayload, webIndex, `GET ${url}`);
  }

  const assetResponse = await app.inject({ method: 'GET', url: assetPath });
  assert.equal(assetResponse.statusCode, 200, `GET ${assetPath}`);
  assert.match(assetResponse.headers['content-type'] ?? '', new RegExp(`^${assetContentType.replace('/', '\\/')}\\b`), `GET ${assetPath}`);
  assert.deepEqual(assetResponse.rawPayload, assetBytes, `GET ${assetPath}`);

  for (const url of ['/assets/static-serving-smoke-missing.js', '/api/static-serving-smoke-missing']) {
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 404, `GET ${url}`);
    assert.doesNotMatch(response.headers['content-type'] ?? '', /^text\/html\b/, `GET ${url}`);
    assert.notDeepEqual(response.rawPayload, webIndex, `GET ${url}`);
  }
} finally {
  await app.close();
}
