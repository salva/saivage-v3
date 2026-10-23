import { afterEach, describe, expect, it } from '@jest/globals';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createObservedCollections } from '../../src/retrieval/observed-collections.js';
import { queryObservedCollectionsInputSchema } from '../../src/contracts/observed-collections.js';
import { XERJ_BINARY_SHA256, XERJ_MODEL_FILES, XERJ_MODEL_REVISION, XERJ_SOURCE } from '../../src/retrieval/collection-definitions.js';

const roots: string[] = []; const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const caller = { resolveReadablePath: (path: string) => path };
async function fixture(options: {
  wrongRoot?: boolean; neural?: boolean; failNeural?: boolean; forbidden?: boolean; oversized?: boolean; stall?: boolean;
  carrier?: 'body' | 'text'; contents?: Record<string, unknown>[];
  properties?: Record<string, { type: string }>;
  destinations?: string[]; stallPhase?: 'catalog' | 'mapping' | 'search';
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'observed-query-')); roots.push(root);
  mkdirSync(join(root, '.saivage/config'), { recursive: true }); mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs/allowed.md'), 'Current source, not reread for indexed excerpt.');
  const requests: { path: string; authorization: string | undefined; body: any }[] = [];
  const prefix = `sv-${'a'.repeat(32)}`;
  let stalled = false;
  const server = createServer(async (req, res) => {
    const parts: Buffer[] = []; for await (const part of req) parts.push(Buffer.from(part));
    const body = parts.length ? JSON.parse(Buffer.concat(parts).toString()) : null;
    requests.push({ path: req.url!, authorization: req.headers.authorization, body });
    const phase = req.url === '/autoindex-catalog/_search' ? 'catalog' : req.url?.endsWith('/_mapping') ? 'mapping' : 'search';
    if (!stalled && options.stallPhase === phase) {
      stalled = true; res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{'); return;
    }
    const hits = (rows: Record<string, unknown>[]) => ({ hits: { hits: rows.map((_source, i) => ({ _id: String(i), _source })) } });
    let value: unknown;
    if (req.url === '/autoindex-catalog/_search') {
      const run = JSON.stringify(body.query).includes('"run"');
      value = hits(run ? [{ run_id: 'run-1', prefix, root: options.wrongRoot ? '/another-project/docs' : join(root, 'docs') }]
        : (options.destinations ?? ['native-nested-elected']).map(index_name => ({ index_name, run_id: 'run-1' })));
    } else if (req.url === '/metadata-failed/_mapping') {
      res.statusCode = 500; res.end('private mapping payload'); return;
    } else if (req.url === '/unsupported/_mapping') {
      value = { unsupported: { mappings: { properties: { arbitrary: { type: 'text' } } } } };
    } else if (req.url === '/native-nested-elected/_mapping') {
      value = { 'native-nested-elected': { mappings: { properties: options.properties ?? { [options.carrier ?? 'body']: { type: options.neural ? 'semantic_text' : 'text' } } } } };
    } else if (req.url === '/native-nested-elected/_search') {
      if (options.stall) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{'); return; }
      if (options.oversized) { res.end(JSON.stringify({ private: 'x'.repeat(8 * 1024 * 1024) })); return; }
      if (options.failNeural && JSON.stringify(body.query).includes('semantic')) {
        res.statusCode = 500; res.end('private native error token=do-not-expose'); return;
      }
      value = hits((options.contents ?? [{ [options.carrier ?? 'body']: `api_key=synthetic-secret-canary\n${'Useful explanation. '.repeat(200)}` }]).map((content, i) => ({ ...content,
        ax_path: 'excluded.md', ax_paths: options.forbidden ? ['.env'] : ['excluded.md', 'allowed.md'],
        ax_file: `axf2-${'a'.repeat(32)}-123`, ax_locator: `b${i}`, start_line: 1, end_line: 9 })));
    } else { res.statusCode = 404; res.end(); return; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value));
  });
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture listener');
  writeFileSync(join(root, '.saivage/config/observed-collections.json'), JSON.stringify({ format_version: 1, type: 'observed-collections',
    collections: [{ name: 'docs', purpose: 'Useful references', kind: 'documentation', directory: 'docs', include: ['allowed.md'], exclude: [] }] }));
  writeFileSync(join(root, '.saivage/config/observed-collections-native.json'), JSON.stringify({ format_version: 1, type: 'xerj-observed-deployment',
    endpoint: `http://127.0.0.1:${address.port}`, native: { executable: '/opt/xerj', sha256: XERJ_BINARY_SHA256, source: XERJ_SOURCE },
    model: { directory: '/opt/model', revision: XERJ_MODEL_REVISION, mode: 'neural', dimensions: 384, files: XERJ_MODEL_FILES },
    roots: [{ directory: 'docs', prefix }] }));
  writeFileSync(join(root, '.saivage/config/xerj.key'), 'synthetic-auth-key\n');
  return { port: createObservedCollections(root), requests };
}
const query = () => queryObservedCollectionsInputSchema.parse({ collections: ['docs'], query: 'stop request' });

describe('observed source request-local protocol and projection', () => {
  it.each([false, true])('selects and fetches text-only mapped carriers, semantic=%s, with unchanged safe projection', async neural => {
    const f = await fixture({ carrier: 'text', neural });
    const result = await f.port.query(query(), caller, new AbortController().signal);
    const searches = f.requests.filter(r => r.path === '/native-nested-elected/_search');
    expect(searches[0]!.body.query).toEqual({ match: { text: 'stop request' } });
    expect(searches[0]!.body._source).toEqual(['body', 'impl', 'text', 'ax_path', 'ax_paths', 'ax_file', 'ax_run', 'ax_locator']);
    expect(searches).toHaveLength(neural ? 2 : 1);
    if (neural) expect(searches[1]!.body.query).toEqual({ semantic: { field: 'text', query: 'stop request', k: 200 } });
    else expect(result.coverage.unavailable_channels).toEqual(['neural']);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({ memberships: [{ collection: 'docs', path: 'docs/allowed.md' }],
      transformed: true, excerpt_truncated: true, location: 'unavailable', channels: neural ? ['lexical', 'neural'] : ['lexical'] });
    expect(result.hits[0]!.excerpt).toContain('Useful explanation.');
    expect(Buffer.byteLength(result.hits[0]!.excerpt)).toBeLessThanOrEqual(2048);
    expect(JSON.stringify(result)).not.toMatch(/synthetic-secret-canary|excluded\.md|start_line|end_line/);
  });
  it('preserves impl then body then text precedence across mixed records and withholds arbitrary columns', async () => {
    const f = await fixture({ properties: { body: { type: 'text' }, impl: { type: 'text' }, text: { type: 'text' }, arbitrary: { type: 'text' } }, contents: [
      { impl: 'implementation', body: 'not impl', text: 'not impl either' },
      { body: 'document body', text: 'not body' }, { text: 'line window' },
      { impl: 7, body: false, text: 'string window' },
      { text: 5, arbitrary: 'private arbitrary column', title: 'not an excerpt' },
    ] });
    const result = await f.port.query(query(), caller, new AbortController().signal);
    expect(result.hits.map(hit => hit.excerpt)).toEqual(['implementation', 'document body', 'line window', 'string window']);
    expect(f.requests.find(r => r.path === '/native-nested-elected/_search')!.body.query).toEqual({ bool: {
      should: [{ match: { body: 'stop request' } }, { match: { impl: 'stop request' } }, { match: { text: 'stop request' } }], minimum_should_match: 1,
    } });
    expect(result.hits.every(hit => hit.location === 'unavailable')).toBe(true);
    expect(result.coverage.postfilter_removals).toBe(true);
    const forbidden = await fixture({ carrier: 'text', forbidden: true });
    expect((await forbidden.port.query(query(), caller, new AbortController().signal)).hits).toEqual([]);
  });
  it.each([['metadata-failed', 'native-nested-elected'], ['native-nested-elected', 'metadata-failed']])(
    'retains availability and explicit metadata loss in destination order %s, %s', async (first, second) => {
      const f = await fixture({ destinations: [first, second] });
      for (const result of [await f.port.list(caller, new AbortController().signal), await f.port.query(query(), caller, new AbortController().signal)]) {
        expect(result.collections[0]).toMatchObject({ queryability: 'available', coverage: 'unknown', limitations: ['metadata_unavailable', 'semantic_fields_absent'] });
        expect(result.coverage.limitations).toContain('metadata_unavailable');
        expect(JSON.stringify(result)).not.toContain('private mapping payload');
      }
      expect((await f.port.query(query(), caller, new AbortController().signal)).hits).toHaveLength(1);
    },
  );
  it.each([['unsupported', 'native-nested-elected'], ['native-nested-elected', 'unsupported']])(
    'does not let unsupported destinations overwrite available ones: %s, %s', async (first, second) => {
      const f = await fixture({ destinations: [first, second] });
      const result = await f.port.query(query(), caller, new AbortController().signal);
      expect(result.collections[0]?.queryability).toBe('available'); expect(result.hits).toHaveLength(1);
      expect(result.collections[0]?.limitations).toContain('lexical_fields_absent');
    },
  );
  it('does not turn all failed/unsupported destinations into known-empty success', async () => {
    const f = await fixture({ destinations: ['metadata-failed', 'unsupported'] });
    const list = await f.port.list(caller, new AbortController().signal);
    expect(list.collections[0]).toMatchObject({ queryability: 'unavailable', coverage: 'unknown' });
    expect(list.coverage.limitations).toContain('metadata_unavailable');
    await expect(f.port.query(query(), caller, new AbortController().signal)).rejects.toThrow('Observed source query unavailable.');
  });
  it.each(['catalog', 'mapping', 'search'] as const)('enforces the real whole 15s deadline on stalled %s without caller timeout', async stallPhase => {
    const f = await fixture({ stallPhase });
    const invocation = new AbortController();
    const started = performance.now();
    await expect(f.port.query(query(), caller, invocation.signal)).rejects.toThrow('Observed source query unavailable.');
    const elapsed = performance.now() - started;
    expect(invocation.signal.aborted).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(14500);
    expect(elapsed).toBeLessThan(20000);
    expect((await f.port.list(caller, new AbortController().signal)).collections[0]?.queryability).toBe('available');
  }, 25000);
  it('joins actual root/run/destination, retains permitted identical-content alias, redacts before caps and reports absent neural', async () => {
    const f = await fixture();
    const result = await f.port.query(query(), caller, new AbortController().signal);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({ memberships: [{ collection: 'docs', path: 'docs/allowed.md' }], transformed: true, location: 'unavailable', channels: ['lexical'] });
    expect(Buffer.byteLength(result.hits[0]!.excerpt)).toBeLessThanOrEqual(2048);
    expect(JSON.stringify(result)).not.toContain('synthetic-secret-canary');
    expect(JSON.stringify(result)).not.toContain('excluded.md');
    expect(result.coverage.unavailable_channels).toEqual(['neural']);
    expect(f.requests.every((r) => r.authorization === 'Bearer synthetic-auth-key')).toBe(true);
    expect(f.requests.map((r) => r.path)).toContain('/native-nested-elected/_search');
  });
  it('does not treat matching prefix as proof of root association', async () => {
    const f = await fixture({ wrongRoot: true });
    const result = await f.port.query(query(), caller, new AbortController().signal);
    expect(result.collections[0]?.queryability).toBe('initializing');
    expect(result.hits).toEqual([]);
    expect(f.requests).toHaveLength(1);
  });
  it('keeps lexical success when actual neural request fails without exporting native errors', async () => {
    const f = await fixture({ neural: true, failNeural: true });
    const result = await f.port.query(query(), caller, new AbortController().signal);
    expect(result.hits).toHaveLength(1); expect(result.coverage.failed_channels).toEqual(['neural']);
    expect(JSON.stringify(result)).not.toContain('do-not-expose');
    expect(result.coverage.limitations).toContain('embedding_coverage_unknown');
  });
  it('reports filtering starvation even when no permitted result remains and honors caller refusal', async () => {
    const f = await fixture({ forbidden: true });
    const result = await f.port.query(query(), caller, new AbortController().signal);
    expect(result.hits).toEqual([]); expect(result.coverage.postfilter_removals).toBe(true);
    expect(result.coverage.limitations).toContain('eligible_results_may_be_starved');
    await expect(f.port.query(query(), { resolveReadablePath() { throw new Error('private refusal'); } }, new AbortController().signal)).rejects.toThrow('not permitted');
  });
  it('fails canceled queries with a fixed safe error', async () => {
    const f = await fixture(); const abort = new AbortController(); abort.abort('private reason');
    await expect(f.port.query(query(), caller, abort.signal)).rejects.toThrow('Observed source query unavailable.');
    expect(f.requests).toEqual([]);
  });
  it('bounds streamed bodies and leaves the independently owned server usable after query failure', async () => {
    const f = await fixture({ oversized: true });
    await expect(f.port.query(query(), caller, new AbortController().signal)).rejects.toThrow('Observed source query unavailable.');
    expect((await f.port.list(caller, new AbortController().signal)).collections[0]?.queryability).toBe('available');
  });
  it('cancels an in-flight body without stopping native lifetime', async () => {
    const f = await fixture({ stall: true });
    await expect(f.port.query(query(), caller, AbortSignal.timeout(100))).rejects.toThrow('Observed source query unavailable.');
    expect((await f.port.list(caller, new AbortController().signal)).collections[0]?.queryability).toBe('available');
  });
});
