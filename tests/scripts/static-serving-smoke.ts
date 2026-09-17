#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Environment } from '../../src/config/index.js';
import type { ApplicationFatalPort } from '../../src/contracts/index.js';
import { createFastifyApp } from '../../src/server/composition/fastify-app.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const docsDistPath = join(packageRoot, 'docs', '.vitepress', 'dist');
const docsLandingPath = join(docsDistPath, 'index.html');
const docsLanding = readFileSync(docsLandingPath);
const docsLandingHtml = docsLanding.toString('utf8');
const docsRunbookIndex = readFileSync(join(docsDistPath, 'runbook', 'index.html'));
const webIndexPath = join(packageRoot, 'web', 'dist', 'index.html');
const webIndex = readFileSync(webIndexPath);
const assetPath = webIndex.toString('utf8').match(/(?:src|href)="(\/assets\/[^"?#]+\.(?:js|css))[^" ]*"/)?.[1];
assert(assetPath, `${webIndexPath} does not reference a built JavaScript or CSS asset`);
const assetBytes = readFileSync(join(packageRoot, 'web', 'dist', assetPath));
const assetContentType = assetPath.endsWith('.js') ? 'application/javascript' : 'text/css';

const docsCssUrl = docsLandingHtml.match(/<link\b[^>]*\bhref="([^"]+\.css(?:[?#][^"]*)?)"/)?.[1];
assert(docsCssUrl, `${docsLandingPath} does not reference a built CSS asset`);
assert(docsCssUrl.startsWith('/docs/'), `${docsLandingPath} CSS URL is not under /docs/: ${docsCssUrl}`);
const docsJavaScriptUrl = docsLandingHtml.match(/<script\b[^>]*\bsrc="([^"]+\.js(?:[?#][^"]*)?)"/)?.[1];
assert(docsJavaScriptUrl, `${docsLandingPath} does not reference a built JavaScript asset`);
assert(docsJavaScriptUrl.startsWith('/docs/'), `${docsLandingPath} JavaScript URL is not under /docs/: ${docsJavaScriptUrl}`);

const docsHrefs = [...docsLandingHtml.matchAll(/\bhref="([^"]+)"/g)].map((match) => match[1]);
const docsNavigation = [
  { url: '/docs/spec/system-specification.html', artifact: 'spec/system-specification.html' },
  { url: '/docs/spec/operator-ui.html', artifact: 'spec/operator-ui.html' },
  { url: '/docs/architecture/system-architecture.html', artifact: 'architecture/system-architecture.html' },
  { url: '/docs/runbook/', artifact: 'runbook/index.html' },
] as const;

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

  const docsRedirectResponse = await app.inject({ method: 'GET', url: '/docs' });
  assert.equal(docsRedirectResponse.statusCode, 302, 'GET /docs');
  assert.equal(docsRedirectResponse.headers.location, '/docs/', 'GET /docs Location');

  const docsRedirectTargetResponse = await app.inject({ method: 'GET', url: docsRedirectResponse.headers.location });
  assert.equal(docsRedirectTargetResponse.statusCode, 200, `GET ${docsRedirectResponse.headers.location}`);
  assert.match(docsRedirectTargetResponse.headers['content-type'] ?? '', /^text\/html\b/, `GET ${docsRedirectResponse.headers.location}`);
  assert.deepEqual(docsRedirectTargetResponse.rawPayload, docsLanding, `GET ${docsRedirectResponse.headers.location}`);

  for (const url of ['/docs/', '/docs/index.html']) {
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 200, `GET ${url}`);
    assert.match(response.headers['content-type'] ?? '', /^text\/html\b/, `GET ${url}`);
    assert.deepEqual(response.rawPayload, docsLanding, `GET ${url}`);
  }

  const docsRunbookResponse = await app.inject({ method: 'GET', url: '/docs/runbook/' });
  assert.equal(docsRunbookResponse.statusCode, 200, 'GET /docs/runbook/');
  assert.match(docsRunbookResponse.headers['content-type'] ?? '', /^text\/html\b/, 'GET /docs/runbook/');
  assert.deepEqual(docsRunbookResponse.rawPayload, docsRunbookIndex, 'GET /docs/runbook/');

  for (const destination of docsNavigation) {
    const emittedHref = docsHrefs.find((href) => new URL(href, 'http://localhost/docs/').pathname === destination.url);
    assert(emittedHref, `${docsLandingPath} does not link to ${destination.url}`);
    const emittedUrl = new URL(emittedHref, 'http://localhost/docs/');
    const response = await app.inject({ method: 'GET', url: `${emittedUrl.pathname}${emittedUrl.search}` });
    assert.equal(response.statusCode, 200, `GET ${emittedHref}`);
    assert.match(response.headers['content-type'] ?? '', /^text\/html\b/, `GET ${emittedHref}`);
    assert.deepEqual(response.rawPayload, readFileSync(join(docsDistPath, destination.artifact)), `GET ${emittedHref}`);
  }

  for (const [url, contentType] of [
    [docsCssUrl, 'text/css'],
    [docsJavaScriptUrl, 'application/javascript'],
  ] as const) {
    const parsedUrl = new URL(url, 'http://localhost');
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 200, `GET ${url}`);
    assert.match(response.headers['content-type'] ?? '', new RegExp(`^${contentType.replace('/', '\\/')}\\b`), `GET ${url}`);
    assert.deepEqual(response.rawPayload, readFileSync(join(docsDistPath, parsedUrl.pathname.slice('/docs/'.length))), `GET ${url}`);
  }

  const docsIconsUrl = docsHrefs.find((href) => new URL(href, 'http://localhost/docs/').pathname === '/docs/vp-icons.css');
  if (docsIconsUrl) {
    assert(docsIconsUrl.startsWith('/docs/'), `${docsLandingPath} icon CSS URL is not under /docs/: ${docsIconsUrl}`);
    const response = await app.inject({ method: 'GET', url: docsIconsUrl });
    assert.equal(response.statusCode, 200, `GET ${docsIconsUrl}`);
    assert.match(response.headers['content-type'] ?? '', /^text\/css\b/, `GET ${docsIconsUrl}`);
    assert.deepEqual(response.rawPayload, readFileSync(join(docsDistPath, 'vp-icons.css')), `GET ${docsIconsUrl}`);
  }

  for (const url of ['/docs/static-serving-smoke-missing.html', '/docs/assets/static-serving-smoke-missing.js']) {
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 404, `GET ${url}`);
    assert.notDeepEqual(response.rawPayload, webIndex, `GET ${url}`);
  }

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
