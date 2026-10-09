const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repository = path.resolve(__dirname, '../..');
const workspaceTmp = path.resolve(repository, '../tmp');

function fixture(t) {
  const directory = mkdtempSync(path.join(workspaceTmp, 'saivage-devtool-security-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('Vite denies a resolved alias to a denied file before and after shared imports', async (t) => {
  const { createServer, isFileServingAllowed } = await import('../../web/node_modules/vite/dist/node/index.js');
  const directory = mkdtempSync(path.join(workspaceTmp, 'saivage-devtool-security-'));
  let server;
  t.after(async () => {
    if (server) {
      // Stop background static-import transforms before server.close closes the
      // watcher; Vite's combined close otherwise runs those operations in parallel.
      await Promise.all(Object.values(server.environments).map((environment) => environment.close()));
      await server.close();
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const deniedFile = path.join(directory, '.env');
  const sentinel = 'HARMLESS_VITE_DENIED_FIXTURE';
  writeFileSync(deniedFile, sentinel);
  server = await createServer({
    configFile: path.join(repository, 'web/vite.config.ts'),
    root: path.join(repository, 'web'),
    resolve: { alias: [{ find: /^devtool-denied-fixture(?=\?|$)/, replacement: deniedFile }] },
    server: { host: '127.0.0.1', port: 0, open: false },
    logLevel: 'silent',
  });
  await server.listen();
  const resolved = await server.environments.client.pluginContainer.resolveId('devtool-denied-fixture?raw');
  assert.equal(resolved.id, `${deniedFile}?raw`, 'test alias must resolve to the existing denied file');
  assert.equal(isFileServingAllowed(deniedFile, server), false, 'resolved policy must deny the existing fixture');
  const address = server.httpServer.address();
  const origin = `http://127.0.0.1:${address.port}`;
  async function denial(url) {
    const response = await fetch(`${origin}${url}`, { headers: { Accept: 'application/javascript', 'Sec-Fetch-Dest': 'script' } });
    const body = await response.text();
    assert.equal(body.includes(sentinel), false, 'denied fixture contents must not be disclosed');
    assert.equal(response.status, 403, 'existing denied file must receive explicit admission denial');
  }
  async function deniedRequests() {
    await denial(`/@fs/${deniedFile}?raw`);
    await denial('/@id/devtool-denied-fixture?raw');
  }
  await deniedRequests();
  for (const module of ['/src/stores/cards.ts', '/src/api/client.ts', '/@id/@saivage/schemas']) {
    const response = await fetch(`${origin}${module}`, { headers: { Accept: 'application/javascript' } });
    assert.equal(response.status, 200, 'intentional shared imports must remain admitted');
    assert.match(response.headers.get('content-type'), /javascript/);
    await response.text();
  }
  await deniedRequests();
});

function sourceMap(content) {
  return { version: 3, names: [], sources: ['original.js'], sourcesContent: [content], mappings: 'AAAA' };
}

test('Babel rejects outside-package maps while consuming relative and inline maps', (t) => {
  const babel = require('@babel/core');
  const directory = fixture(t);
  const root = path.join(directory, 'package');
  const input = path.join(root, 'src/input.js');
  mkdirSync(path.dirname(input), { recursive: true });
  mkdirSync(path.join(directory, 'outside'));
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'devtool-map-fixture' }));
  const outsideContent = 'HARMLESS_OUTSIDE_MAP_CONTENT';
  const localContent = 'HARMLESS_LOCAL_MAP_CONTENT';
  const inlineContent = 'HARMLESS_INLINE_MAP_CONTENT';
  writeFileSync(path.join(directory, 'outside/secret.map'), JSON.stringify(sourceMap(outsideContent)));
  writeFileSync(path.join(root, 'src/input.js.map'), JSON.stringify(sourceMap(localContent)));
  const compile = (comment) => babel.transformSync(`const answer = 6 * 7;\n${comment}`, {
    babelrc: false, configFile: false, filename: input, root, sourceMaps: true,
  });
  const relative = compile('//# sourceMappingURL=input.js.map');
  assert.ok(relative.map.sourcesContent.includes(localContent), 'same-package maps must remain usable');
  const inline = compile(`//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(sourceMap(inlineContent))).toString('base64')}`);
  assert.ok(inline.map.sourcesContent.includes(inlineContent), 'inline maps must remain usable');
  const rejected = compile('//# sourceMappingURL=../../outside/secret.map');
  assert.equal(new Function(`${rejected.code}\nreturn answer;`)(), 42);
  assert.equal(JSON.stringify(rejected.map).includes(outsideContent), false, 'outside map content must not enter output map');
  assert.equal(rejected.code.includes(outsideContent), false, 'outside map content must not enter compiled code');
});

test('babel-jest consumer produces executable code and an input-derived source map', (t) => {
  const { createTransformer } = require('babel-jest');
  const root = fixture(t);
  const input = path.join(root, 'consumer.js');
  const content = 'HARMLESS_BABEL_JEST_MAP_CONTENT';
  const source = `const answer = 6 * 7;\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(sourceMap(content))).toString('base64')}`;
  const transformer = createTransformer({ babelrc: false, configFile: false });
  const result = transformer.process(source, input, {
    config: { cwd: root, rootDir: root }, configString: '{}',
    cacheFS: new Map(), instrument: false,
    supportsDynamicImport: false, supportsExportNamespaceFrom: false,
    supportsStaticESM: false, supportsTopLevelAwait: false,
  });
  assert.ok(result.map.sourcesContent.includes(content), 'real babel-jest must propagate input maps');
  assert.equal(new Function(`${result.code}\nreturn answer;`)(), 42);
});
