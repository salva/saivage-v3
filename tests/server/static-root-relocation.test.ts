import { expect, it } from '@jest/globals';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// This runner imports the physically relocated factory, never a mocked module URL.
const runner = `
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
const [moduleUrl, fixture, packageRoot, cwd] = process.argv.slice(2);
const { createFastifyApp } = await import(moduleUrl);
const environment = {
  nodeEnv: 'test',
  server: { host: '127.0.0.1', port: 0, logLevel: 'silent' },
};
const fatalPort = { publicationOutcomeUnknown(error) { throw error; } };
const web = '<!doctype html><title>intended UI</title>';
const docs = '<!doctype html><title>intended docs</title>';
const asset = 'console.log("intended asset");';
function assertPathFree(response) {
  for (const path of [fixture, packageRoot, cwd]) {
    assert(!response.body.includes(path), 'response disclosed fixture path');
  }
}
const app = await createFastifyApp(environment, fatalPort);
try {
  await app.ready();
  for (const [url, bytes, contentType] of [
    ['/', web, /^text\\/html\\b/],
    ['/cards', web, /^text\\/html\\b/],
    ['/assets/fixture.js', asset, /^application\\/javascript\\b/],
    ['/docs/', docs, /^text\\/html\\b/],
  ]) {
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 200, url);
    assert.equal(response.body, bytes, url);
    assert.match(response.headers['content-type'] ?? '', contentType, url);
  }
  const redirect = await app.inject({ method: 'GET', url: '/docs' });
  assert.equal(redirect.statusCode, 302);
  assert.equal(redirect.headers.location, '/docs/');
  assertPathFree(redirect);
  for (const url of ['/assets/missing.js', '/api/missing', '/docs/missing']) {
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 404, url);
    assert.notEqual(response.body, web, url);
    assert.doesNotMatch(response.headers['content-type'] ?? '', /^text\\/html\\b/, url);
    assertPathFree(response);
  }
} finally {
  await app.close();
}
// Only mutate the fixture once the first factory has closed.
rmSync(join(packageRoot, 'docs', '.vitepress', 'dist'), { recursive: true });
const withoutDocs = await createFastifyApp(environment, fatalPort);
try {
  await withoutDocs.ready();
  for (const url of ['/docs', '/docs/missing']) {
    const response = await withoutDocs.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 404, url);
    assert.deepEqual(response.json(), {
      error: 'Documentation not built. Run vitepress build docs/ to generate.',
    }, url);
    assert.match(response.headers['content-type'] ?? '', /^application\\/json\\b/, url);
    assert.notEqual(response.body, web, url);
    assertPathFree(response);
  }
} finally {
  await withoutDocs.close();
}
console.log('relocated static roots: both factory instances passed');
`;

it('anchors source static assets to its package despite dist/src ancestors and unrelated cwd', async () => {
  const fixture = mkdtempSync('/home/salva/g/ml/tmp/saivage-static-root-');
  try {
    const packageRoot = join(fixture, 'dist', 'src', 'checkout');
    mkdirSync(packageRoot, { recursive: true });
    cpSync(join(repositoryRoot, 'src'), join(packageRoot, 'src'), { recursive: true });
    cpSync(join(repositoryRoot, 'package.json'), join(packageRoot, 'package.json'));
    symlinkSync(join(repositoryRoot, 'node_modules'), join(packageRoot, 'node_modules'), 'dir');
    const cwd = join(fixture, 'unrelated-cwd');
    for (const [root, label] of [
      [packageRoot, 'intended'],
      [dirname(packageRoot), 'parent decoy'],
      [cwd, 'cwd decoy'],
    ]) {
      mkdirSync(join(root, 'web', 'dist', 'assets'), { recursive: true });
      mkdirSync(join(root, 'docs', '.vitepress', 'dist'), { recursive: true });
      writeFileSync(join(root, 'web', 'dist', 'index.html'), `<!doctype html><title>${label} UI</title>`);
      writeFileSync(join(root, 'web', 'dist', 'assets', 'fixture.js'), `console.log("${label} asset");`);
      writeFileSync(join(root, 'docs', '.vitepress', 'dist', 'index.html'), `<!doctype html><title>${label} docs</title>`);
    }
    const runnerPath = join(fixture, 'runner.mjs');
    writeFileSync(runnerPath, runner);
    const result = await new Promise<{ code: number | null; signal: string | null; output: string; timedOut: boolean }>((resolveResult) => {
      const child = spawn(process.execPath, [
        '--import', pathToFileURL(join(repositoryRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href,
        runnerPath,
        pathToFileURL(join(packageRoot, 'src', 'server', 'composition', 'fastify-app.ts')).href,
        fixture, packageRoot, cwd,
      ], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      let timedOut = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      }, 60_000);
      child.once('error', (error) => { output += error.message; });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        resolveResult({ code, signal, output, timedOut });
      });
    });
    expect(result).toEqual({
      code: 0,
      signal: null,
      output: 'relocated static roots: both factory instances passed\n',
      timedOut: false,
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}, 85_000);
